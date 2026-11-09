import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, selectors, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { catalogRoutes } from '../catalog/load.ts';
import type { Catalog } from '../catalog/schema.ts';
import type { Execution, Resolved, Scenario, StepLog } from '../schema/scenario.ts';
import type { Frame, Recording } from '../schema/video.ts';
import { runAction } from './actions.ts';
import { logIn, type EnvReader, type PlayableAccount } from './login.ts';
import { describeTarget } from './targets.ts';

export interface RunOptions {
    baseUrl: string;
    /** An installed Chrome; otherwise Playwright's Chromium (the only one available on Linux ARM). */
    chromePath: string | null;
    timeoutMs: number;
    outputDir: string;
    /** Interface language, sent by the browser: the narration's. */
    locale: string;
    timezone: string;
    viewport: { width: number; height: number };
    testIdAttribute: string;
    hideSelectors: string[];
    allowedHosts: string[];
    allowedExternalHosts: string[];
    accounts: Map<string, PlayableAccount>;
    env: EnvReader;
}

/** `*.example.test` matches any subdomain of example.test; other patterns match the host exactly. */
export function hostMatches(host: string, pattern: string): boolean {
    const wanted = pattern.toLowerCase();
    const actual = host.toLowerCase();

    return wanted.startsWith('*.') ? actual.endsWith(wanted.slice(1)) : actual === wanted;
}

export function isRequestAllowed(url: string, baseUrl: string, externalHosts: string[]): boolean {
    const { protocol, hostname } = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) {
        return true;
    }

    return hostname === new URL(baseUrl).hostname || externalHosts.some((pattern) => hostMatches(hostname, pattern));
}

/** Refuses any host not declared as a development instance: a demo never touches production. */
export function assertAllowedBaseUrl(baseUrl: string, allowedHosts: string[]): void {
    const host = new URL(baseUrl).hostname;
    if (!allowedHosts.some((pattern) => hostMatches(host, pattern))) {
        throw new Error(
            `Host "${host}" refused: Demo Studio only runs against the hosts in allowedHosts (${allowedHosts.join(', ')}).`
        );
    }
}

/** Each lookup must designate exactly one record, otherwise the scenario cannot play. */
export function assertLookupsResolved(scenario: Scenario, resolved: Resolved): void {
    const problems = Object.entries(scenario.lookups)
        .map(([key, lookup]) => [key, lookup, resolved[key] ?? []] as const)
        .filter(([, , ids]) => 1 !== ids.length)
        .map(
            ([key, lookup, ids]) =>
                `"${key}" (${lookup.entity} ${JSON.stringify(lookup.where)}): ${0 === ids.length ? 'not found' : `${ids.length} results`}`
        );
    if (problems.length > 0) {
        throw new Error(
            `Demo data missing or ambiguous; reset the demo data or fix the lookups:\n- ${problems.join('\n- ')}`
        );
    }
}

function hideScript(selectors: string[]): string {
    const css = `${selectors.join(', ')} { display: none !important; }`;

    return `document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
});`;
}

function stepLabel(step: Scenario['scenes'][number]['steps'][number]): string {
    if ('goto' === step.action) {
        return `goto ${step.route}`;
    }

    return 'target' in step && step.target ? `${step.action} ${describeTarget(step.target)}` : step.action;
}

// The time for an animation (panel, dropdown) to end: the frame frozen in the edit must be stable.
const RECORDING_SETTLE_MS = 400;
const SCROLL_SETTLE_MS = 150;
const SETTLED_ACTIONS = new Set(['goto', 'click', 'fill', 'select', 'select2', 'check', 'press', 'scrollTo']);

interface Session {
    context: BrowserContext;
    page: Page;
}

interface Capture {
    frames: Frame[];
    stop: () => Promise<void>;
}

/** Continuous screen capture through the Chrome protocol: one frame on each change, dated on the gestures' clock. */
async function startCapture(
    page: Page,
    directory: string,
    prefix: string,
    viewport: { width: number; height: number },
    now: (epochMs?: number) => number
): Promise<Capture> {
    mkdirSync(directory, { recursive: true });
    const session = await page.context().newCDPSession(page);
    const frames: Frame[] = [];
    session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const name = `${String(frames.length).padStart(5, '0')}.jpg`;
        writeFileSync(join(directory, name), Buffer.from(data, 'base64'));
        // When Chrome painted the frame, not when it arrives: encoding and transfer delay it.
        frames.push({ t: metadata.timestamp ? now(metadata.timestamp * 1000) : now(), file: `${prefix}/${name}` });
        session.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
    });
    await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 92,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        everyNthFrame: 1,
    });

    return {
        frames,
        stop: async () => {
            await session.send('Page.stopScreencast').catch(() => undefined);
            await session.detach().catch(() => undefined);
        },
    };
}

export type ExecutionMode = 'dry-run' | 'record';

export async function execute(
    mode: 'dry-run',
    scenario: Scenario,
    catalog: Catalog,
    resolved: Resolved,
    options: RunOptions
): Promise<Execution>;
export async function execute(
    mode: 'record',
    scenario: Scenario,
    catalog: Catalog,
    resolved: Resolved,
    options: RunOptions
): Promise<Recording>;
/**
 * Plays the scenario step after step and stops at the first failure. Each scene starts from a fresh session,
 * logged in off camera, in a dry run as when recording: what passes dry passes on camera too. Cookies and
 * browser storage restart from the login; the server-side session is shared by the scenes of an account.
 */
export async function execute(
    mode: ExecutionMode,
    scenario: Scenario,
    catalog: Catalog,
    resolved: Resolved,
    options: RunOptions
): Promise<Execution | Recording> {
    assertAllowedBaseUrl(options.baseUrl, options.allowedHosts);
    assertLookupsResolved(scenario, resolved);
    selectors.setTestIdAttribute(options.testIdAttribute);
    const routes = catalogRoutes(catalog);
    const startedAt = new Date();
    const origin = Date.now();
    const now = (epochMs: number = Date.now()): number => Math.round(epochMs - origin);
    const steps: StepLog[] = [];
    const frames: Record<string, Frame[]> = {};
    const consoleMessages: string[] = [];
    const blockedRequests = new Set<string>();
    const executablePath = options.chromePath && existsSync(options.chromePath) ? options.chromePath : undefined;
    const browser = await chromium.launch({ executablePath, headless: true });
    const browserVersion = browser.version();
    const loggedIn = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();
    let failure: Execution['failure'] = null;

    const openSession = async (account: PlayableAccount): Promise<Session> => {
        const storageState = loggedIn.get(account.id);
        const context = await newContext(browser, options, blockedRequests, storageState);
        // Trace screenshots use the same screen stream as the recording: one consumer at a time.
        await context.tracing.start({ screenshots: 'dry-run' === mode, snapshots: true });
        const page = await context.newPage();
        page.on('console', (message) => {
            if (['error', 'warning'].includes(message.type())) {
                consoleMessages.push(`[${message.type()}] ${message.text()}`);
            }
        });
        page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${error.message}`));
        if (!storageState) {
            try {
                await logIn(page, account, {
                    baseUrl: options.baseUrl,
                    language: options.locale,
                    timeoutMs: options.timeoutMs,
                    env: options.env,
                });
            } catch (error) {
                const file = await diagnoseLogin(page, options.outputDir, account.id);
                throw new Error(`${error instanceof Error ? error.message : String(error)} (see ${file})`);
            }
            loggedIn.set(account.id, await context.storageState());
        }

        return { context, page };
    };

    try {
        for (const scene of scenario.scenes) {
            const account = options.accounts.get(scene.account);
            if (!account) {
                throw new Error(`Account "${scene.account}" has no login in the config`);
            }
            if (!loggedIn.has(account.id)) {
                const preparation = await openSession(account);
                await preparation.context.close();
            }
            const { page, context } = await openSession(account);
            const capture =
                'record' === mode
                    ? await startCapture(
                          page,
                          join(options.outputDir, 'frames', scene.id),
                          `frames/${scene.id}`,
                          options.viewport,
                          now
                      )
                    : null;
            for (const step of scene.steps) {
                const startMs = now();
                try {
                    const measured = await runAction(step, {
                        page,
                        baseUrl: options.baseUrl,
                        routes,
                        resolved,
                        timeoutMs: options.timeoutMs,
                        settleMs: 'record' === mode ? SCROLL_SETTLE_MS : 0,
                    });
                    const endMs = now();
                    if ('record' === mode && SETTLED_ACTIONS.has(step.action)) {
                        await page.waitForTimeout(RECORDING_SETTLE_MS);
                    }
                    steps.push({
                        scene: scene.id,
                        step: step.id,
                        action: stepLabel(step),
                        status: 'passed',
                        startMs,
                        endMs,
                        url: page.url(),
                        box: measured?.box ?? null,
                        actionMs: measured ? measured.at - origin : null,
                        anchor: step.anchor ?? null,
                        error: null,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
                    steps.push({
                        scene: scene.id,
                        step: step.id,
                        action: stepLabel(step),
                        status: 'failed',
                        startMs,
                        endMs: now(),
                        url: page.url(),
                        box: null,
                        actionMs: null,
                        anchor: step.anchor ?? null,
                        error: message,
                    });
                    failure = await diagnose(
                        page,
                        context,
                        options.outputDir,
                        scene.id,
                        step.id,
                        error,
                        consoleMessages
                    );
                    break;
                }
            }
            if (capture) {
                await capture.stop();
                frames[scene.id] = capture.frames;
            }
            if (failure) {
                break;
            }
            await context.close();
        }
    } finally {
        await browser.close();
    }

    const execution = {
        status: failure ? ('failed' as const) : ('passed' as const),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        baseUrl: options.baseUrl,
        browser: browserVersion,
        steps,
        blockedOrigins: [...blockedRequests].sort(),
        failure,
    };

    return 'record' === mode ? { ...execution, mode, frames } : { ...execution, mode };
}

async function newContext(
    browser: Browser,
    options: RunOptions,
    blockedRequests: Set<string>,
    storageState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined
): Promise<BrowserContext> {
    const context = await browser.newContext({
        baseURL: options.baseUrl,
        viewport: options.viewport,
        locale: options.locale,
        timezoneId: options.timezone,
        storageState,
    });
    if (options.hideSelectors.length > 0) {
        await context.addInitScript(hideScript(options.hideSelectors));
    }
    await context.route('**/*', (route) => {
        const url = route.request().url();
        if (isRequestAllowed(url, options.baseUrl, options.allowedExternalHosts)) {
            return route.continue();
        }
        blockedRequests.add(new URL(url).origin);

        return route.abort('blockedbyclient');
    });

    return context;
}

/** A screenshot only: a DOM snapshot of a login form can hold the typed password in a value attribute. */
async function diagnoseLogin(page: Page, outputDir: string, accountId: string): Promise<string> {
    const directory = join(outputDir, 'diagnostics');
    mkdirSync(directory, { recursive: true });
    const file = `diagnostics/login--${accountId.replace(/[^\w.-]/g, '_')}.png`;
    await page.screenshot({ path: join(outputDir, file), fullPage: true }).catch(() => undefined);

    return file;
}

async function diagnose(
    page: Page,
    context: BrowserContext,
    outputDir: string,
    sceneId: string,
    stepId: string,
    error: unknown,
    consoleMessages: string[]
): Promise<NonNullable<Execution['failure']>> {
    const directory = join(outputDir, 'diagnostics');
    mkdirSync(directory, { recursive: true });
    const base = `${sceneId}--${stepId}`;
    await page.screenshot({ path: join(directory, `${base}.png`), fullPage: true }).catch(() => undefined);
    writeFileSync(join(directory, `${base}.html`), await page.content().catch(() => ''));
    await context.tracing.stop({ path: join(directory, `${base}.trace.zip`) }).catch(() => undefined);

    return {
        scene: sceneId,
        step: stepId,
        error: error instanceof Error ? error.message : String(error),
        screenshot: `diagnostics/${base}.png`,
        dom: `diagnostics/${base}.html`,
        trace: `diagnostics/${base}.trace.zip`,
        console: consoleMessages.slice(-30),
    };
}
