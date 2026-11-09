import type { Locator, Page } from 'playwright-core';
import type { Route } from '../catalog/schema.ts';
import { routePath } from '../scenario/check.ts';
import type { Action, ActionType, RelativeDate, Resolved } from '../schema/scenario.ts';
import { locate } from './targets.ts';

export interface ActionContext {
    page: Page;
    baseUrl: string;
    routes: Map<string, Route>;
    resolved: Resolved;
    timeoutMs: number;
    // When recording, the time for the captured picture to catch up with a scroll before measuring the element.
    settleMs: number;
}

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Position of the targeted element, taken just before the gesture (a click can make it disappear), and the
 * time of that measure: the edit freezes the screen on that frame and brings the cursor there.
 */
export interface Measure {
    box: Box | null;
    at: number;
}

export type ActionResult = Measure | null;

export function formatRelativeDate(value: RelativeDate, today: Date = new Date()): string {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + value.daysFromToday);
    const pad = (number: number): string => String(number).padStart(2, '0');

    return value.format
        .replace('yyyy', String(date.getFullYear()))
        .replace('MM', pad(date.getMonth() + 1))
        .replace('dd', pad(date.getDate()));
}

/** Same path, or a sub-page the application led to by itself (`/signup/x` → `/signup/x/step-1`). */
export function landedWhereAsked(actual: string, expected: string): boolean {
    const normalize = (path: string): string => decodeURIComponent(path).replace(/\/+$/, '') || '/';
    const landed = normalize(actual);
    const asked = normalize(expected);

    return landed === asked || ('/' !== asked && landed.startsWith(`${asked}/`));
}

/** The element brought on screen before being measured: Playwright would do it anyway, and the cursor must aim right. */
async function measure(locator: Locator, { timeoutMs, settleMs }: ActionContext): Promise<Measure> {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
    if (settleMs > 0) {
        await locator.page().waitForTimeout(settleMs);
    }

    return { box: await locator.boundingBox({ timeout: timeoutMs }), at: Date.now() };
}

type Executor<T extends ActionType> = (
    step: Extract<Action, { action: T }>,
    context: ActionContext
) => Promise<ActionResult>;

/** The closed registry of gestures a scenario may ask for. No arbitrary code gets in. */
export const ACTIONS: { [T in ActionType]: Executor<T> } = {
    goto: async (step, { page, baseUrl, routes, resolved }) => {
        const route = routes.get(step.route);
        if (!route) {
            throw new Error(`Route "${step.route}" is not in the catalog`);
        }
        const url = new URL(routePath(route, step.params, resolved, step.query), baseUrl);
        const response = await page.goto(url.toString(), { waitUntil: 'load' });
        if (response && response.status() >= 400) {
            throw new Error(`HTTP ${response.status()} on ${response.url()}`);
        }
        // An expired session or a missing permission redirects with a 200: the failure must show here.
        const landed = new URL(page.url()).pathname;
        if (!landedWhereAsked(landed, url.pathname)) {
            throw new Error(`"${step.route}" redirects to ${landed} instead of ${url.pathname}`);
        }

        return null;
    },
    click: async (step, context) => {
        const { page, timeoutMs } = context;
        const locator = locate(page, step.target);
        const measured = await measure(locator, context);
        await locator.click({ timeout: timeoutMs });
        // No wait for network idle: a persistent connection would make it last; the next step waits for its element.
        await page.waitForLoadState('load');

        return measured;
    },
    fill: async (step, context) => {
        const { page, timeoutMs } = context;
        const locator = locate(page, step.target);
        const measured = await measure(locator, context);
        await locator.fill('string' === typeof step.value ? step.value : formatRelativeDate(step.value), {
            timeout: timeoutMs,
        });

        return measured;
    },
    select: async (step, context) => {
        const { page, timeoutMs } = context;
        const locator = locate(page, step.target);
        const measured = await measure(locator, context);
        await locator.selectOption({ label: step.option }, { timeout: timeoutMs });

        return measured;
    },
    select2: async (step, context) => {
        const { page, timeoutMs } = context;
        // Select2 hides the <select>: open its container, type, then pick the option.
        const select = locate(page, step.target);
        const container = select.locator('xpath=following-sibling::span[contains(@class, "select2")][1]');
        const measured = await measure(container, context);
        await container.click({ timeout: timeoutMs });
        await page.locator('.select2-container--open .select2-search__field').fill(step.search, { timeout: timeoutMs });
        // A group header has the same class and contains its options' text: only options count.
        const options = page.locator('.select2-container--open .select2-results__option:not([role="group"])', {
            hasText: step.option,
        });
        await options.first().waitFor({ state: 'visible', timeout: timeoutMs });
        // "Design" must not silently pick "Design review": exactly one option must match.
        const count = await options.count();
        if (count > 1) {
            throw new Error(`${count} options contain "${step.option}": make the label more precise.`);
        }
        await options.click({ timeout: timeoutMs });

        return measured;
    },
    check: async (step, context) => {
        const { page, timeoutMs } = context;
        const locator = locate(page, step.target);
        const measured = await measure(locator, context);
        await locator.check({ timeout: timeoutMs });

        return measured;
    },
    press: async (step, context) => {
        const { page, timeoutMs } = context;
        if (step.target) {
            const locator = locate(page, step.target);
            const measured = await measure(locator, context);
            await locator.press(step.key, { timeout: timeoutMs });

            return measured;
        }
        await page.keyboard.press(step.key);

        return null;
    },
    waitFor: async (step, context) => {
        const { page, timeoutMs } = context;
        const locator = locate(page, step.target);
        if ('hidden' === step.state) {
            await locator.waitFor({ state: 'hidden', timeout: timeoutMs });

            return null;
        }

        return measure(locator, context);
    },
    // What the scenario expects, the viewer must see: the element is brought on screen.
    expectVisible: async (step, context) => measure(locate(context.page, step.target).first(), context),
    expectText: async (step, context) => {
        const { page, timeoutMs } = context;
        const locator = locate(page, step.target).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        const deadline = Date.now() + timeoutMs;
        let text = '';
        while (Date.now() < deadline) {
            text = (await locator.innerText()).replace(/\s+/g, ' ');
            if (text.includes(step.text)) {
                return measure(locator, context);
            }
            await page.waitForTimeout(100);
        }
        throw new Error(`"${step.text}" not found; text found: "${text.slice(0, 200)}"`);
    },
    scrollTo: async (step, context) => measure(locate(context.page, step.target).first(), context),
    hold: async (step, { page }) => {
        await page.waitForTimeout(step.ms);

        return null;
    },
};

export async function runAction(step: Action, context: ActionContext): Promise<ActionResult> {
    const executor = ACTIONS[step.action] as Executor<typeof step.action>;

    return executor(step as never, context);
}
