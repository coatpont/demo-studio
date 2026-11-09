import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { catalogRoutes, loadCatalog } from '../catalog/load.ts';
import type { Catalog } from '../catalog/schema.ts';
import { loadProject, type Project } from '../config/load.ts';
import type { VoiceSettings } from '../config/schema.ts';
import { DemoStore, PLAN_FILE, SCENARIO_FILE, assertDemoId, requestOf } from '../demos/store.ts';
import { narrate } from '../narration/elevenlabs.ts';
import { splitSentences } from '../narration/sentences.ts';
import { textNarration } from '../narration/text.ts';
import { buildPlannerContext } from '../planner/context.ts';
import { coverageMarkdown } from '../planner/coverage.ts';
import { checkPlan, plannerOutputJsonSchema } from '../planner/plan.ts';
import { buildScope, resolveModulesAndMode } from '../planner/scope.ts';
import { readEnv } from '../project/env.ts';
import { readJson, writeJson, writeText } from '../project/files.ts';
import { gitInfo } from '../project/git.ts';
import { parseDuration, plural } from '../project/text.ts';
import { runResolver } from '../resolve/resolve.ts';
import { accountErrors, playableAccounts } from '../runner/login.ts';
import { execute, type RunOptions } from '../runner/run.ts';
import { checkScenario, lookupRequests, routePattern } from '../scenario/check.ts';
import type { DemoManifest } from '../schema/demo.ts';
import { DemoModeSchema, DemoPlanSchema, type DemoPlan } from '../schema/plan.ts';
import type { Execution, Resolved, Scenario } from '../schema/scenario.ts';
import { NarrationSchema, RecordingSchema, TimelineSchema, type Branding, type Tracks } from '../schema/video.ts';
import { buildTimeline, toSrt, type ExcerptSource } from '../timeline/build.ts';
import { findBrowser, renderVideo } from '../video/render.ts';
import { parseTracks, videoFileName } from '../video/tracks.ts';

const USAGE = `Usage: demo-studio <command> [--config <path>] [options]

  list                          demos, their status, last dry run and video
  check [<demo>…]               every demo against the current catalog, without a browser
  catalog                       validate the catalog and print what it holds
  context <demo> [--module <id>] [--prompt <text>] [--mode overview|deep-dive] [--language <code>]
                 [--audience <text>] [--duration 5m] [--title <title>] [--description <text>]
  validate <demo>               plan and, if written, scenario against the catalog
  scenario-check <demo>         same, the scenario being required
  resolve <demo>                ids of the scenario's lookups, from the running app
  dry-run <demo>                play the scenario in the browser, without video
  narrate <demo> [--text-only]  synthesise the narration (or prepare subtitle-only timing)
  record <demo>                 play the scenario while capturing the screen
  timeline <demo>               match recording and narration; write the SRT
  render <demo> [--tracks voice|subtitles|voice,subtitles]
  video <demo> [--tracks …]     narrate, record, timeline, render
  reset                         restore the demo data (requires DEMO_RESET_CONFIRM=1)
  browser                       install Playwright's Chromium`;

/** A failure already explained on the console: only the summary line and the exit code remain. */
class Failure extends Error {}

interface Context {
    project: Project;
    store: DemoStore;
    catalog: () => Catalog;
}

function rel(context: Context, path: string): string {
    return relative(context.project.paths.root, path) || '.';
}

function demoId(argv: string[]): string {
    const [id] = argv;
    if (!id) {
        throw new Error(`Demo id required.\n${USAGE}`);
    }
    // Checked before any write: the id becomes a directory name.
    assertDemoId(id);

    return id;
}

function showCatalog(context: Context): void {
    const catalog = context.catalog();
    const features = catalog.modules.flatMap((module) => module.features);
    const count = (confidence: string): number => features.filter((one) => one.confidence === confidence).length;
    const output = join(context.project.paths.work, 'catalog.json');
    writeJson(output, catalog);
    console.log(
        `Catalog ${catalog.catalogVersion} (commit ${catalog.git.commit?.slice(0, 9) ?? 'unknown'}) → ${rel(context, output)}`
    );
    console.log(
        `${plural(catalog.modules.length, 'module')}, ${count('verified')} verified features, ${count('documented')} documented, ` +
            `${count('inferred')} inferred; ${plural(
                features.reduce((sum, one) => sum + one.cases.length, 0),
                'case'
            )}, ` +
            `${plural(catalog.routes.length, 'route')}, ${plural(catalog.navigation.length, 'navigation entry', 'navigation entries')}, ` +
            `${plural(catalog.accounts.length, 'account')}, ${plural(catalog.data.length, 'data record')}`
    );
    const playable = playableAccounts(context.project.config);
    for (const account of catalog.accounts.filter((one) => !playable.has(one.id))) {
        console.log(`  ⚠ account "${account.id}" has no login in the config: scenes cannot use it.`);
    }
}

/** Creates the demo's manifest if it does not exist, then prepares what to read to write its plan. */
function prepareContext(context: Context, argv: string[]): void {
    const { config } = context.project;
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            module: { type: 'string', multiple: true },
            prompt: { type: 'string' },
            mode: { type: 'string' },
            language: { type: 'string' },
            audience: { type: 'string' },
            duration: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
        },
    });
    const id = demoId(positionals);
    const catalog = context.catalog();
    const { store } = context;
    if (!store.exists(id)) {
        const modules = (values.module ?? []).flatMap((value) => value.split(',')).filter(Boolean);
        if (0 === modules.length && !values.prompt) {
            throw new Error(`New demo: --module or --prompt is required.\n${USAGE}`);
        }
        const resolved = resolveModulesAndMode(catalog, {
            modules,
            prompt: values.prompt ?? null,
            mode: values.mode ? DemoModeSchema.parse(values.mode) : null,
        });
        store.createManifest({
            id,
            title: values.title ?? values.prompt ?? resolved.modules.join(', '),
            description: values.description ?? 'To write: what the demo shows, to whom, and why.',
            status: 'draft',
            audience: values.audience ?? config.defaultAudience,
            language: values.language ?? config.defaultLanguage,
            mode: resolved.mode,
            modules: resolved.modules,
            prompt: values.prompt ?? null,
            targetDurationSeconds: parseDuration(values.duration),
        });
        console.log(`Demo created: ${rel(context, join(store.sourceDir(id), 'demo.yaml'))}`);
    } else if (values.module || values.prompt || values.mode) {
        console.log(`  ⚠ The demo exists: its scope is edited in demo.yaml, the options are ignored.`);
    }
    const manifest = store.manifest(id);
    const request = requestOf(manifest);
    const work = store.workDir(id);
    writeJson(join(work, 'catalog.json'), catalog);
    writeText(join(work, 'context.md'), buildPlannerContext(catalog, request, buildScope(catalog, request)));
    writeJson(join(work, 'plan.schema.json'), plannerOutputJsonSchema());
    console.log(`${request.mode} on ${request.modules.join(', ') || 'all modules'}`);
    console.log(`Context: ${rel(context, join(work, 'context.md'))}`);
    console.log(`Plan to write: ${rel(context, join(store.sourceDir(id), PLAN_FILE))}`);
}

interface LoadedDemo {
    manifest: DemoManifest;
    catalog: Catalog;
    plan: DemoPlan | null;
    scenario: Scenario | null;
    errors: string[];
    warnings: string[];
}

/** Validates a demo's sources against the catalog as it is now: that is what reveals an outdated demo. */
function loadDemo(context: Context, id: string): LoadedDemo {
    const { store } = context;
    const manifest = store.manifest(id);
    const catalog = context.catalog();
    const loaded: LoadedDemo = { manifest, catalog, plan: null, scenario: null, errors: [], warnings: [] };
    const planSource = store.source(id, PLAN_FILE);
    if (null === planSource) {
        loaded.errors.push(`${PLAN_FILE} missing: write it from the context (demo-studio context ${id}).`);

        return loaded;
    }
    const planCheck = checkPlan(planSource, catalog, requestOf(manifest));
    loaded.errors.push(...planCheck.errors.map((error) => `plan: ${error}`));
    loaded.warnings.push(...planCheck.warnings.map((warning) => `plan: ${warning}`));
    loaded.plan = planCheck.plan;
    loaded.errors.push(...excerptErrors(store, id, loaded.plan));
    const scenarioSource = store.source(id, SCENARIO_FILE);
    if (!loaded.plan || null === scenarioSource) {
        return loaded;
    }
    const scenarioCheck = checkScenario(scenarioSource, loaded.plan, catalog);
    loaded.errors.push(...scenarioCheck.errors.map((error) => `scenario: ${error}`));
    loaded.warnings.push(...scenarioCheck.warnings.map((warning) => `scenario: ${warning}`));
    if (scenarioCheck.scenario) {
        const accounts = scenarioCheck.scenario.scenes.map((scene) => scene.account);
        const missing = accountErrors(accounts, context.project.config);
        loaded.errors.push(...missing.map((error) => `scenario: ${error}`));
        loaded.scenario = 0 === missing.length ? scenarioCheck.scenario : null;
    }

    return loaded;
}

/** Each excerpt cites a scene of another demo, which exists and has that scene in its plan. */
function excerptErrors(store: DemoStore, id: string, plan: DemoPlan | null): string[] {
    return (plan?.scenes ?? []).flatMap((scene) => {
        const excerpt = scene.excerpt;
        if (!excerpt) {
            return [];
        }
        const where = `plan: scene ${scene.id}, excerpt of "${excerpt.demo}"`;
        if (excerpt.demo === id || !store.exists(excerpt.demo)) {
            return [`${where}: unknown demo, or this demo itself.`];
        }
        const source = parseYaml(store.source(excerpt.demo, PLAN_FILE) ?? '') as { scenes?: { id: string }[] } | null;

        return source?.scenes?.some((candidate) => candidate.id === excerpt.scene)
            ? []
            : [`${where}: scene "${excerpt.scene}" is not in its plan.`];
    });
}

/**
 * Scenes reused from other demos, as they were edited there. Their frames are copied into this demo's
 * directory, which alone serves as the render's public directory.
 */
function excerptSources(context: Context, work: string, plan: DemoPlan): Map<string, ExcerptSource> {
    const sources = new Map<string, ExcerptSource>();
    for (const scene of plan.scenes) {
        if (!scene.excerpt) {
            continue;
        }
        const { demo, scene: sourceId } = scene.excerpt;
        const sourceWork = join(context.project.paths.work, 'demos', demo);
        const timelinePath = join(sourceWork, 'timeline.json');
        if (!existsSync(timelinePath)) {
            throw new Error(`Scene ${scene.id}: demo ${demo} is not edited yet (demo-studio render ${demo}).`);
        }
        const source = TimelineSchema.parse(readJson(timelinePath)).scenes.find((one) => one.id === sourceId);
        if (!source) {
            throw new Error(`Scene ${scene.id}: the timeline of ${demo} has no scene "${sourceId}".`);
        }
        const frames = source.frames.map((frame) => {
            const file = `excerpts/${demo}/${frame.file}`;
            mkdirSync(dirname(join(work, file)), { recursive: true });
            copyFileSync(join(sourceWork, frame.file), join(work, file));

            return { ...frame, file };
        });
        sources.set(scene.id, { ...source, frames, audio: [] });
    }

    return sources;
}

function report(loaded: LoadedDemo): void {
    loaded.warnings.forEach((warning) => console.log(`  ⚠ ${warning}`));
    loaded.errors.forEach((error) => console.log(`  ✗ ${error}`));
}

/** Validates plan and scenario; writes the validated plan, its coverage and the lookups to the work directory. */
function validate(context: Context, argv: string[], requireScenario = false): LoadedDemo {
    const id = demoId(argv);
    const loaded = loadDemo(context, id);
    const work = context.store.workDir(id);
    writeJson(join(work, 'catalog.json'), loaded.catalog);
    report(loaded);
    if (loaded.plan) {
        writeJson(join(work, 'plan.json'), loaded.plan);
        writeJson(join(work, 'coverage.json'), loaded.plan.coverage);
        writeText(join(work, 'coverage.md'), coverageMarkdown(loaded.plan.title, loaded.plan.coverage));
        const { summary } = loaded.plan.coverage;
        console.log(
            `"${loaded.plan.title}": ${plural(loaded.plan.scenes.length, 'scene')}, ~${Math.round(loaded.plan.estimatedDurationSeconds)} s, ` +
                `${summary.featuresIncluded}/${summary.featuresInScope} features, ${summary.casesIncluded}/${summary.casesInScope} cases`
        );
    }
    if (loaded.scenario) {
        writeJson(join(work, 'lookups.json'), lookupRequests(loaded.scenario));
        const steps = loaded.scenario.scenes.reduce((sum, scene) => sum + scene.steps.length, 0);
        console.log(
            `Scenario valid: ${plural(loaded.scenario.scenes.length, 'scene')}, ${plural(steps, 'step')}, ` +
                `${plural(Object.keys(loaded.scenario.lookups).length, 'lookup')}.`
        );
    } else if (requireScenario && loaded.plan && 0 === loaded.errors.length) {
        loaded.errors.push(`${SCENARIO_FILE} missing.`);
        console.log(`  ✗ ${SCENARIO_FILE} missing.`);
    }
    if (loaded.errors.length > 0) {
        throw new Failure(`Demo ${id} refused (${plural(loaded.errors.length, 'error')}).`);
    }
    context.store.updateLock(id, { validation: { catalogVersion: loaded.catalog.catalogVersion } });

    return loaded;
}

/** Every demo against the current catalog, without a browser: an outdated reference demo fails. */
function check(context: Context, argv: string[]): void {
    const ids = argv.length > 0 ? argv : context.store.ids();
    const catalog = context.catalog();
    let failures = 0;
    for (const id of ids) {
        const loaded = loadDemo(context, id);
        const blocking = 'reference' === loaded.manifest.status;
        if (blocking && loaded.plan && !loaded.scenario && 0 === loaded.errors.length) {
            loaded.errors.push(`${SCENARIO_FILE} missing.`);
        }
        // A reference replays: it must have been seen passing, not only have valid files.
        const { dryRun } = context.store.lock(id);
        if (blocking && 'passed' !== dryRun?.status) {
            loaded.errors.push(`${dryRun ? 'last dry run failed' : 'never played dry'}: demo-studio dry-run ${id}.`);
        } else if (blocking && dryRun?.catalogVersion !== catalog.catalogVersion) {
            loaded.warnings.push(`played dry against another catalog: demo-studio dry-run ${id} to confirm.`);
        }
        const status = 0 === loaded.errors.length ? '✓' : blocking ? '✗' : '⚠';
        console.log(`${status} ${id} (${loaded.manifest.status})`);
        loaded.errors.forEach((error) => console.log(`    ${error}`));
        loaded.warnings
            .filter((warning) => !warning.startsWith('plan:') && !warning.startsWith('scenario:'))
            .forEach((warning) => console.log(`    ⚠ ${warning}`));
        if (blocking && loaded.errors.length > 0) {
            failures++;
        }
    }
    if (failures > 0) {
        throw new Failure(`${plural(failures, 'reference demo')} to update.`);
    }
}

function list(context: Context): void {
    const { store } = context;
    const ids = store.ids();
    if (0 === ids.length) {
        console.log(`No demo in ${rel(context, context.project.paths.demos)}/.`);

        return;
    }
    for (const id of ids) {
        const manifest = store.manifest(id);
        const lock = store.lock(id);
        const video = lock.video ? `video ${Math.round(lock.video.durationMs / 1000)} s` : 'no video';
        const dryRun = lock.dryRun ? `dry run ${lock.dryRun.status} (${lock.dryRun.steps})` : 'never played';
        console.log(`${id.padEnd(28)} ${manifest.status.padEnd(9)} ${manifest.title}`);
        console.log(
            `${''.padEnd(38)}${manifest.mode}, ${manifest.modules.join(', ') || 'all modules'}; ${dryRun}; ${video}`
        );
    }
}

/** Ids of the scenario's lookups, from the project's resolver: a command, or values written in the config. */
function resolve(context: Context, argv: string[]): void {
    const id = demoId(argv);
    const loaded = validate(context, [id], true);
    const scenario = loaded.scenario as Scenario;
    const work = context.store.workDir(id);
    const requests = lookupRequests(scenario);
    const keys = Object.keys(requests);
    const { resolve: resolver } = context.project.config;
    if (keys.length > 0 && !resolver) {
        throw new Error(
            `The scenario declares ${plural(keys.length, 'lookup')} but the config has no \`resolve\` (command or values).`
        );
    }
    const resolved: Resolved = resolver ? runResolver(resolver, requests, context.project.paths.root) : {};
    writeJson(join(work, 'resolved.json'), resolved);
    for (const key of keys) {
        const ids = resolved[key] ?? [];
        console.log(`${key}: ${0 === ids.length ? 'not found' : ids.join(', ')}`);
    }
}

interface ReadyDemo {
    id: string;
    work: string;
    plan: DemoPlan;
    catalog: Catalog;
    scenario: Scenario;
    resolved: Resolved;
}

/** What playing the scenario needs: valid plan and scenario, lookups resolved after their last change. */
function readyDemo(context: Context, id: string): ReadyDemo {
    const loaded = loadDemo(context, id);
    if (!loaded.plan || !loaded.scenario) {
        throw new Error(`Demo ${id} is invalid, run demo-studio validate ${id}: ${loaded.errors.join('; ')}`);
    }
    const work = context.store.workDir(id);
    const resolvedPath = join(work, 'resolved.json');
    const lookupsPath = join(work, 'lookups.json');
    if (!existsSync(resolvedPath) || !existsSync(lookupsPath)) {
        throw new Error(`resolved.json missing: run demo-studio resolve ${id}.`);
    }
    // Criteria changed since the resolution would designate another record than the id kept.
    const stale =
        JSON.stringify(readJson(lookupsPath)) !== JSON.stringify(lookupRequests(loaded.scenario)) ||
        statSync(resolvedPath).mtimeMs < statSync(lookupsPath).mtimeMs;
    if (stale) {
        throw new Error(`Lookups changed since their resolution: run demo-studio resolve ${id}.`);
    }

    return {
        id,
        work,
        plan: loaded.plan,
        catalog: loaded.catalog,
        scenario: loaded.scenario,
        resolved: readJson(resolvedPath) as Resolved,
    };
}

function runOptions(context: Context, directory: string, locale: string): RunOptions {
    const { config, paths } = context.project;

    return {
        baseUrl: config.baseUrl,
        chromePath: process.env.DEMO_STUDIO_CHROME ?? config.browser.chromePath,
        timeoutMs: Number(process.env.DEMO_STUDIO_TIMEOUT_MS ?? config.browser.timeoutMs),
        outputDir: directory,
        locale,
        timezone: config.browser.timezone,
        viewport: config.browser.viewport,
        testIdAttribute: config.browser.testIdAttribute,
        hideSelectors: config.browser.hideSelectors,
        allowedHosts: config.allowedHosts,
        allowedExternalHosts: config.allowedExternalHosts,
        accounts: playableAccounts(config),
        env: (name) => readEnv(paths.root, name),
    };
}

/** The plan announces each scene's screen; the scene reaches it by clicking, so check that it gets there. */
function entryWarnings(demo: ReadyDemo, execution: Execution): string[] {
    const routes = catalogRoutes(demo.catalog);

    return demo.plan.scenes.flatMap((scene) => {
        const route = scene.entryRouteName ? routes.get(scene.entryRouteName) : undefined;
        const visited = execution.steps.filter((step) => step.scene === scene.id && 'passed' === step.status);
        if (!route || 0 === visited.length) {
            return [];
        }
        const pattern = routePattern(route);

        return visited.some((step) => pattern.test(new URL(step.url).pathname))
            ? []
            : [`Scene ${scene.id}: the screen announced by the plan (${route.name}, ${route.path}) was never opened.`];
    });
}

function reportExecution(label: string, demo: ReadyDemo, execution: Execution): string {
    const passed = execution.steps.filter((step) => 'passed' === step.status).length;
    const total = demo.scenario.scenes.reduce((sum, scene) => sum + scene.steps.length, 0);
    console.log(`${label} ${execution.status}: ${passed}/${total} steps.`);
    entryWarnings(demo, execution).forEach((warning) => console.log(`  ⚠ ${warning}`));
    if (execution.blockedOrigins.length > 0) {
        console.log(`  ⚠ Blocked external origins: ${execution.blockedOrigins.join(', ')}`);
    }
    if (execution.failure) {
        console.log(
            `  ✗ ${execution.failure.scene} / ${execution.failure.step}: ${execution.failure.error.split('\n')[0]}`
        );
        console.log(
            `  Diagnostics: ${execution.failure.screenshot}, ${execution.failure.dom}, ${execution.failure.trace} (in ${demo.work})`
        );
    }

    return `${passed}/${total}`;
}

/** Plays the scenario in the browser, without video; stops at the first failing step. */
async function runDry(context: Context, argv: string[]): Promise<void> {
    const id = demoId(argv);
    resolve(context, [id]);
    const demo = readyDemo(context, id);
    const execution = await execute(
        'dry-run',
        demo.scenario,
        demo.catalog,
        demo.resolved,
        runOptions(context, demo.work, demo.plan.language)
    );
    writeJson(join(demo.work, 'execution.json'), execution);
    const steps = reportExecution('Dry run', demo, execution);
    context.store.updateLock(demo.id, {
        dryRun: { status: execution.status, steps, catalogVersion: demo.catalog.catalogVersion },
    });
    if (execution.failure) {
        throw new Failure(`Dry run of ${id} failed.`);
    }
}

const VOICE_SETTINGS_ENV = {
    stability: 'ELEVENLABS_STABILITY',
    similarity_boost: 'ELEVENLABS_SIMILARITY_BOOST',
    style: 'ELEVENLABS_STYLE',
    speed: 'ELEVENLABS_SPEED',
} as const;

function voiceSettings(context: Context): VoiceSettings {
    const settings: VoiceSettings = { ...context.project.config.narration.voiceSettings };
    for (const [setting, name] of Object.entries(VOICE_SETTINGS_ENV) as [keyof VoiceSettings, string][]) {
        const value = readEnv(context.project.paths.root, name);
        if (null === value) {
            continue;
        }
        const number = Number(value);
        if (!Number.isFinite(number)) {
            throw new Error(`${name} must be a number ("${value}").`);
        }
        settings[setting] = number;
    }

    return settings;
}

function validatedPlan(id: string, work: string): DemoPlan {
    const path = join(work, 'plan.json');
    if (!existsSync(path)) {
        throw new Error(`Validated plan missing: run demo-studio validate ${id}.`);
    }

    return DemoPlanSchema.parse(readJson(path));
}

/**
 * Synthesises each scene's narration, sentence by sentence. With `--text-only` (or the `text` provider), no
 * synthesis: the video will only carry subtitles, each shown for the time it takes to read it.
 */
async function runNarrate(context: Context, argv: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { 'text-only': { type: 'boolean', default: false } },
    });
    const id = demoId(positionals);
    validate(context, [id]);
    const { config, paths } = context.project;
    const work = context.store.workDir(id);
    const plan = validatedPlan(id, work);
    if (values['text-only'] || 'text' === config.narration.provider) {
        const narration = textNarration(plan);
        writeJson(join(work, 'narration.json'), narration);
        const sentences = narration.scenes.flatMap((scene) => scene.sentences).concat(narration.introduction);
        const durationMs = sentences.reduce((sum, sentence) => sum + sentence.durationMs, 0);
        console.log(
            `Text-only narration: ${plural(sentences.length, 'sentence')}, ${Math.round(durationMs / 1000)} s of reading, nothing billed.`
        );

        return;
    }
    const { apiKeyEnv, voiceIdEnv } = config.narration;
    const languageVoice = `${voiceIdEnv}_${plan.language.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const apiKey = readEnv(paths.root, apiKeyEnv);
    // A voice per narration language when defined, the common voice otherwise.
    const voiceId = readEnv(paths.root, languageVoice) ?? readEnv(paths.root, voiceIdEnv);
    if (!apiKey || !voiceId) {
        throw new Error(
            `${apiKeyEnv} and ${voiceIdEnv} (or ${languageVoice}) are required, in the environment, .env.local or .env ` +
                '(voice ids: GET https://api.elevenlabs.io/v2/voices). For subtitles only, use --text-only.'
        );
    }
    const settings = voiceSettings(context);
    const modelId = readEnv(paths.root, 'ELEVENLABS_MODEL_ID') ?? config.narration.modelId;
    const result = await narrate(plan, work, {
        apiKey,
        voiceId,
        modelId,
        language: plan.language,
        cacheDir: join(paths.cache, 'narration'),
        settings,
        pronunciations: config.narration.pronunciations[plan.language] ?? [],
    });
    writeJson(join(work, 'narration.json'), result.narration);
    const sentences = result.narration.scenes.flatMap((scene) => scene.sentences).concat(result.narration.introduction);
    const durationMs = sentences.reduce((sum, sentence) => sum + sentence.durationMs, 0);
    context.store.updateLock(id, {
        narration: {
            voiceId,
            modelId,
            settings: { ...settings },
            sentences: sentences.length,
            durationMs,
            at: new Date().toISOString(),
        },
    });
    console.log(
        `Narration: ${plural(result.synthesized + result.cached, 'sentence')} (${result.synthesized} synthesised, ${result.cached} cached, ` +
            `${result.characters} characters billed), ${Math.round(durationMs / 1000)} s of voice.`
    );
}

/** Replays the scenario while capturing the screen, a fresh session per scene. */
async function runRecord(context: Context, argv: string[]): Promise<void> {
    const id = demoId(argv);
    resolve(context, [id]);
    const demo = readyDemo(context, id);
    rmSync(join(demo.work, 'frames'), { recursive: true, force: true });
    const recording = await execute(
        'record',
        demo.scenario,
        demo.catalog,
        demo.resolved,
        runOptions(context, demo.work, demo.plan.language)
    );
    writeJson(join(demo.work, 'recording.json'), recording);
    reportExecution('Recording', demo, recording);
    const frames = Object.values(recording.frames).reduce((sum, list) => sum + list.length, 0);
    console.log(`  ${plural(frames, 'frame')} captured.`);
    if (recording.failure) {
        throw new Failure(`Recording of ${id} failed.`);
    }
}

function copyLogo(context: Context, work: string): string | null {
    const { logo } = context.project.config.branding;
    if (!logo) {
        return null;
    }
    const source = isAbsolute(logo) ? logo : join(context.project.paths.root, logo);
    if (!existsSync(source)) {
        console.log(`  ⚠ Logo ${logo} not found: the title cards will show text only.`);

        return null;
    }
    const file = `assets/logo${extname(source)}`;
    mkdirSync(join(work, 'assets'), { recursive: true });
    copyFileSync(source, join(work, file));

    return file;
}

/** Matches recording and narration: presentation timeline and subtitles. */
function runTimeline(context: Context, argv: string[]): void {
    const id = demoId(argv);
    const work = context.store.workDir(id);
    const plan = validatedPlan(id, work);
    for (const [file, command] of [
        ['recording.json', 'record'],
        ['narration.json', 'narrate'],
    ]) {
        if (!existsSync(join(work, file))) {
            throw new Error(`${file} missing: run demo-studio ${command} ${id}.`);
        }
    }
    const recorded = RecordingSchema.parse(readJson(join(work, 'recording.json')));
    // Anchors come from the current scenario: retouching the narration and its anchors needs no new recording.
    const { scenario } = loadDemo(context, id);
    if (!scenario) {
        throw new Error(`Invalid scenario: run demo-studio validate ${id}.`);
    }
    // A step added, removed or renamed since the recording would not edit, or would keep old frames.
    const stepKeys = (keys: string[]): string => keys.join('|');
    const expected = stepKeys(scenario.scenes.flatMap((scene) => scene.steps.map((step) => `${scene.id}/${step.id}`)));
    if (stepKeys(recorded.steps.map((step) => `${step.scene}/${step.step}`)) !== expected) {
        throw new Error(`Recording older than the scenario: run demo-studio record ${id}.`);
    }
    const anchors = new Map(
        scenario.scenes.flatMap((scene) => scene.steps.map((step) => [`${scene.id}/${step.id}`, step.anchor ?? null]))
    );
    const recording = {
        ...recorded,
        steps: recorded.steps.map((step) => ({ ...step, anchor: anchors.get(`${step.scene}/${step.step}`) ?? null })),
    };
    const narration = NarrationSchema.parse(readJson(join(work, 'narration.json')));
    const spoken = (sentences: { text: string }[]): string => sentences.map((sentence) => sentence.text).join('|');
    const current =
        spoken(narration.introduction) === splitSentences(plan.introduction).join('|') &&
        plan.scenes.every(
            (scene) =>
                spoken(narration.scenes.find((voice) => voice.id === scene.id)?.sentences ?? []) ===
                splitSentences(scene.narrative).join('|')
        );
    if (!current) {
        throw new Error(`Narration older than the plan: run demo-studio narrate ${id}.`);
    }
    const timeline = buildTimeline(
        plan,
        recording,
        narration,
        copyLogo(context, work),
        excerptSources(context, work, plan),
        context.project.config.browser.viewport
    );
    writeJson(join(work, 'timeline.json'), timeline);
    writeText(join(work, 'video.srt'), toSrt(timeline.captions));
    timeline.warnings.forEach((warning) => console.log(`  ⚠ ${warning}`));
    console.log(
        `Timeline: ${plural(timeline.scenes.length, 'scene')}, ${Math.round(timeline.durationMs / 1000)} s, ${plural(timeline.captions.length, 'subtitle')}.`
    );
    for (const scene of timeline.scenes) {
        const frozen = scene.segments
            .filter((segment) => segment.frozen)
            .reduce((sum, segment) => sum + segment.durationMs, 0);
        console.log(
            `  ${scene.id}: ${Math.round(scene.durationMs / 1000)} s, of which ${Math.round(frozen / 1000)} s frozen`
        );
    }
}

function branding(context: Context): Branding {
    const { branding: brand } = context.project.config;
    let productName = brand.productName;
    if (null === productName) {
        try {
            productName = context.catalog().product?.name ?? null;
        } catch {
            productName = null;
        }
    }

    return {
        productName,
        primaryColor: brand.primaryColor,
        inkColor: brand.inkColor,
        backgroundColor: brand.backgroundColor,
        fontFamily: brand.fontFamily,
        fontUrl: brand.fontUrl,
    };
}

function tracksOption(argv: string[]): { id: string; tracks: Tracks } {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { tracks: { type: 'string' } },
    });

    return { id: demoId(positionals), tracks: parseTracks(values.tracks) };
}

/** Renders the MP4 with Remotion from the timeline: with the voice, burned-in subtitles, or both. */
async function runRender(context: Context, argv: string[]): Promise<void> {
    const { id, tracks } = tracksOption(argv);
    runTimeline(context, [id]);
    const work = context.store.workDir(id);
    const timeline = TimelineSchema.parse(readJson(join(work, 'timeline.json')));
    const voiced = timeline.introAudio.length > 0 || timeline.scenes.some((scene) => scene.audio.length > 0);
    if (tracks.includes('voice') && !voiced) {
        throw new Error(
            `The narration of ${id} has no voice (--text-only): synthesise it (demo-studio narrate ${id}) or render --tracks subtitles.`
        );
    }
    const output = join(work, videoFileName(tracks));
    let reported = -1;
    const startedAt = Date.now();
    const { config, paths } = context.project;
    await renderVideo(timeline, {
        runDir: work,
        tracks,
        branding: branding(context),
        output,
        browser: findBrowser(process.env.DEMO_STUDIO_CHROME ?? config.browser.chromePath),
        concurrency: process.env.DEMO_STUDIO_RENDER_CONCURRENCY
            ? Number(process.env.DEMO_STUDIO_RENDER_CONCURRENCY)
            : null,
        onProgress: (step, progress) => {
            const tenth = Math.floor(progress * 10);
            if ('render' === step && tenth !== reported) {
                reported = tenth;
                console.log(`  Rendering: ${tenth * 10} %`);
            }
        },
    });
    const git = gitInfo(paths.root);
    context.store.updateLock(id, {
        video: {
            durationMs: timeline.durationMs,
            sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
            gitCommit: git.commit,
            gitDirty: git.dirty,
            tracks,
            at: new Date().toISOString(),
            url: null,
        },
    });
    console.log(
        `Video: ${rel(context, output)} (${Math.round(timeline.durationMs / 1000)} s, rendered in ${Math.round((Date.now() - startedAt) / 1000)} s)`
    );
    console.log(`Tracks: ${tracks.join(' and ')}. Subtitles also as a file: ${rel(context, join(work, 'video.srt'))}`);
}

/** The whole video of a demo already played dry: narration, recording, timeline, render. */
async function runVideo(context: Context, argv: string[]): Promise<void> {
    const { id, tracks } = tracksOption(argv);
    await runNarrate(context, tracks.includes('voice') ? [id] : [id, '--text-only']);
    await runRecord(context, [id]);
    await runRender(context, [id, '--tracks', tracks.join(',')]);
}

/** Restores the demo data through the project's own command; it erases the app's data, hence the confirmation. */
function reset(context: Context): void {
    const { reset: command } = context.project.config;
    if (!command) {
        throw new Error('No `reset` command in the config.');
    }
    if ('1' !== process.env.DEMO_RESET_CONFIRM) {
        throw new Failure(
            `reset runs "${command.command}", which erases the app's data: run again with DEMO_RESET_CONFIRM=1.`
        );
    }
    const result = spawnSync(command.command, { cwd: context.project.paths.root, shell: true, stdio: 'inherit' });
    if (0 !== result.status) {
        throw new Failure(`Reset command exited with status ${result.status ?? result.error?.message}.`);
    }
}

function installBrowser(): void {
    const playwright = dirname(createRequire(import.meta.url).resolve('playwright-core'));
    const result = spawnSync(process.execPath, [join(playwright, 'cli.js'), 'install', 'chromium-headless-shell'], {
        stdio: 'inherit',
    });
    if (0 !== result.status) {
        throw new Failure('Chromium installation failed.');
    }
}

function splitConfigOption(argv: string[]): { configPath: string | undefined; rest: string[] } {
    const rest: string[] = [];
    let configPath: string | undefined;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if ('--config' === arg) {
            configPath = argv[++index];
        } else if (arg.startsWith('--config=')) {
            configPath = arg.slice('--config='.length);
        } else {
            rest.push(arg);
        }
    }

    return { configPath, rest };
}

const COMMANDS: Record<string, (context: Context, argv: string[]) => void | Promise<void>> = {
    list: (context) => list(context),
    check,
    catalog: (context) => showCatalog(context),
    context: prepareContext,
    validate: (context, argv) => void validate(context, argv),
    'scenario-check': (context, argv) => void validate(context, argv, true),
    resolve,
    'dry-run': runDry,
    narrate: runNarrate,
    record: runRecord,
    timeline: runTimeline,
    render: runRender,
    video: runVideo,
    reset: (context) => reset(context),
};

async function main(): Promise<void> {
    const { configPath, rest } = splitConfigOption(process.argv.slice(2));
    const [command, ...argv] = rest;
    if ('browser' === command) {
        return installBrowser();
    }
    const run = command ? COMMANDS[command] : undefined;
    if (!run) {
        console.error(USAGE);
        process.exitCode = 2;

        return;
    }
    const project = await loadProject(configPath);
    let catalog: Catalog | null = null;
    const context: Context = {
        project,
        store: new DemoStore(project.paths.demos, project.paths.work),
        catalog: () => (catalog ??= loadCatalog(project.paths.catalog, project.paths.root)),
    };
    await run(context, argv);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
