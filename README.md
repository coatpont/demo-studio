# Demo Studio

Narrated demo videos of a web app, made from a plain-language request, showing only what the app really does.

- **A coding agent writes** the plan and the scenario (Claude Code, with the skill in [`skills/demo-studio/`](skills/demo-studio/SKILL.md)). The tool never calls an LLM.
- **The tool checks and plays.** It freezes what the agent may cite (a catalog of the app's features), refuses any id the catalog does not hold, plays the scenario in a real browser with Playwright, synthesises the voice with ElevenLabs (or goes subtitles-only), times the picture on the voice, and renders an MP4 with Remotion.
- **Demos are sources**, versioned in your repository and reviewed like code: a manifest, a plan, a scenario and a lock file per demo. `demo-studio check` fails in CI when a reference demo no longer matches the catalog.

```
request ─▶ context ─▶ plan.yaml ─▶ validate ─▶ scenario.yaml ─▶ scenario-check ─▶ resolve ─▶ dry-run
 (you)      (tool)     (agent)      (tool)       (agent)            (tool)          (your app) (browser)
                                                                                                │
             video.mp4 ◀── render ◀── timeline ◀── record (browser) ◀── narrate (ElevenLabs | text)
```

Integrating a project means writing two files: `demo-studio.config.ts` (how to reach and log into the app) and `catalog.yaml` (what the app can show). Nothing else to code for a simple project.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Writing your catalog](#writing-your-catalog)
- [Catalog reference](#catalog-reference)
- [Demo sources](#demo-sources)
- [Scenario reference](#scenario-reference)
- [Narration, tracks and costs](#narration-tracks-and-costs)
- [Guards](#guards)
- [Output layout](#output-layout)
- [CI](#ci)
- [The Claude Code skill](#the-claude-code-skill)
- [Limits and troubleshooting](#limits-and-troubleshooting)
- [Developing Demo Studio](#developing-demo-studio)

## Install

Node 22.18 or later (it runs TypeScript configs natively).

```bash
npm install --save-dev git+https://<host>/<you>/demo-studio.git   # or a local path: npm i -D ../demo-studio
npx demo-studio browser                                         # once: Playwright's Chromium (headless shell)
echo ".demo-studio/" >> .gitignore                              # work directory, regenerated
```

`npx demo-studio browser` is not needed if a Chrome is installed and named in `browser.chromePath` (or `DEMO_STUDIO_CHROME`). Remotion downloads its own headless Chrome for rendering if none is found.

## Quick start

1. **Config** at your project root, `demo-studio.config.ts`:

    ```ts
    import type { DemoStudioConfigInput } from 'demo-studio';

    export default {
        baseUrl: 'http://localhost:3000',
        login: {
            url: '/login',
            fields: [
                { target: { label: 'Email' }, value: { account: 'email' } },
                { target: { label: 'Password' }, value: { env: 'DEMO_PASSWORD' } },
            ],
            submit: { role: 'button', name: 'Sign in' },
        },
        accounts: [{ id: 'manager', values: { email: 'manager@example.test' } }],
        resolve: { command: 'node scripts/demo-resolve.mjs' },
        reset: { command: 'npm run db:seed' },
    } satisfies DemoStudioConfigInput;
    ```

2. **Catalog**, `catalog.yaml`: the modules, features, routes, navigation, accounts and demo data the agent may cite. See [Writing your catalog](#writing-your-catalog).

3. **Check both**: `npx demo-studio catalog`.

4. **Install the skill** in Claude Code (see [The Claude Code skill](#the-claude-code-skill)) and ask:

    ```
    /demo-studio a 2-minute deep dive of the tasks module for team leads
    /demo-studio update the demo team-onboarding
    ```

    The agent runs `context`, writes `demos/<id>/plan.yaml`, runs `validate`, writes `scenario.yaml`, plays it dry, and on request produces the video.

A complete fictional example lives in [`examples/task-tracker/`](examples/task-tracker/): a config, a catalog and one demo. It passes `validate` and `scenario-check`, but cannot be played, since the app does not exist:

```bash
cd examples/task-tracker && npx demo-studio scenario-check assign-and-close
```

## Commands

Every command finds `demo-studio.config.(ts|mts|mjs|js|json)` from the current directory upwards, or takes `--config <path>`. A demo is named by its id, the name of its directory under `demosDir`.

| Command | What it does |
|---|---|
| `list` | the demos, their status, last dry run and video |
| `check [<demo>…]` | every demo against the current catalog, without a browser; fails if a `reference` demo is invalid or has no passed dry run |
| `catalog` | validates the catalog, prints what it holds, writes `.demo-studio/catalog.json` |
| `context <demo> [options]` | creates the demo's `demo.yaml` if new, writes `context.md` and `plan.schema.json` for the agent |
| `validate <demo>` | plan and, if written, scenario against the catalog; writes the validated plan and its coverage |
| `scenario-check <demo>` | the same, the scenario being required |
| `resolve <demo>` | `scenario-check`, then the ids of the scenario's lookups from your resolver |
| `dry-run <demo>` | `resolve`, then plays the scenario in the browser without video |
| `narrate <demo> [--text-only]` | `validate`, then synthesises the narration (or subtitle-only timing, nothing billed) |
| `record <demo>` | `resolve`, then plays the scenario while capturing the screen |
| `timeline <demo>` | matches recording and narration; writes `timeline.json` and `video.srt` |
| `render <demo> [--tracks …]` | `timeline`, then the MP4 |
| `video <demo> [--tracks …]` | `narrate`, `record`, `render` |
| `reset` | runs your `reset` command; requires `DEMO_RESET_CONFIRM=1` |
| `browser` | installs Playwright's Chromium |

Options of `context`, read only when the demo is created (afterwards, edit `demo.yaml`):

| Option | Meaning | Default |
|---|---|---|
| `--module <id>` | module(s) to show; repeatable or comma-separated; id or title | — |
| `--prompt <text>` | free brief; a module named in it becomes the scope | — |
| `--mode overview\|deep-dive` | general presentation, or a detailed module demo | `deep-dive` with a module, else `overview` |
| `--language <code>` | narration language, also sent to the browser as its locale | `defaultLanguage` |
| `--audience <text>` | target audience | `defaultAudience` |
| `--duration <d>` | target duration: `300`, `300s`, `5m`, `4m30s` | free |
| `--title`, `--description` | manifest fields | the brief or the modules; "To write" |

Environment variables: `DEMO_STUDIO_BASE_URL` (overrides `baseUrl`), `DEMO_STUDIO_CHROME`, `DEMO_STUDIO_TIMEOUT_MS`, `DEMO_STUDIO_RENDER_CONCURRENCY`, `DEMO_RESET_CONFIRM`, and the narration ones below.

## Configuration

Paths are relative to the config file's directory. Every key but `baseUrl` is optional.

| Key | Meaning | Default |
|---|---|---|
| `baseUrl` | the app as the browser reaches it | required |
| `allowedHosts` | hosts a run accepts; `*.` matches any subdomain. A demo never runs against production | `localhost`, `127.0.0.1`, `*.localhost`, `*.test` |
| `allowedExternalHosts` | external hosts the page may load; everything else is blocked (chat widgets, analytics) | Google Fonts |
| `demosDir` | demo sources, versioned | `demos` |
| `workDir` | regenerated output, to gitignore | `.demo-studio` |
| `catalog` | the catalog file | `catalog.yaml` |
| `defaultLanguage`, `defaultAudience` | defaults of `context` | `en`, "people discovering the product" |
| `browser.viewport` | window size, also the video size | `1920×1080` |
| `browser.timezone` | browser timezone | `UTC` |
| `browser.testIdAttribute` | attribute a `testId` target matches | `data-testid` |
| `browser.timeoutMs` | maximum wait for an element | `10000` |
| `browser.chromePath` | a Chrome to use if present | Playwright's Chromium |
| `browser.hideSelectors` | CSS selectors hidden on every page: debug toolbars, cookie banners | `[]` |
| `login` | default login of the accounts | — |
| `accounts` | `{ id, description?, values?, login? }` per account | `[]` |
| `resolve` | how lookups become ids: `{ command, timeoutMs? }` or `{ values }` | — |
| `reset` | `{ command }` restoring the demo data | — |
| `branding` | `productName`, `logo`, `primaryColor`, `inkColor`, `backgroundColor`, `fontFamily`, `fontUrl` | neutral blue, system sans-serif |
| `narration` | `provider` (`elevenlabs` \| `text`), `modelId`, `apiKeyEnv`, `voiceIdEnv`, `voiceSettings`, `pronunciations` | `elevenlabs`, `eleven_v4`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |

A JSON config cannot hold functions; a `.ts` or `.mjs` config can (`login` functions). Unknown keys are refused, with the path of each error.

### Accounts and login

Each scene plays as an account of the catalog; the config says how to log in as it. The login happens off camera, before the scene.

- **Declarative**, for a login form: `url`, `fields` (a target and a value each), `submit`, an optional `success` check (`url`: the path must start with it; `visible`: a target that must appear; by default, having left the login page), and `after`: preparation steps (`goto`, `click`, `check`, `fill`, each with `optional: true` to skip when its element is absent: terms to accept, a language to set; `{language}` in a `goto` becomes the demo's language).
- **A function**, in a `.ts`/`.mjs` config, for SSO, magic links or API logins: `login: async (page, account, { baseUrl, language, timeoutMs, value, env }) => { … }` with a Playwright `page`.
- **`'none'`** for a visitor of public pages.

A value is a literal string, `{ env: 'NAME' }` (from the environment, then `.env.local`, then `.env` at the project root), or `{ account: 'key' }` (the account's `values[key]`, itself a literal or `{ env }`). Values are resolved at the last moment and never printed; an error names the variable, not its content. Keep passwords in env vars.

```ts
login: { url: '/login', fields: [...], submit: { role: 'button', name: 'Sign in' },
         after: [{ click: { role: 'button', name: 'Accept the terms' }, optional: true }, { goto: '/settings/language/{language}' }] },
accounts: [
    { id: 'manager', values: { email: 'manager@example.test' } },
    { id: 'sso-admin', login: async (page, account, { env }) => { await page.goto(`/dev/login-as?token=${env('DEV_TOKEN')}`); } },
    { id: 'visitor', login: 'none' },
],
```

### Resolving lookups

A scenario never hard-codes an id: it names data by criteria (`{ entity: Task, where: { title: 'Design the landing page' } }`) and the resolver finds the id in the running app, read-only.

- **`{ command }`**: any program, any language. It receives on stdin `{ "<lookup>": { "entity": "Task", "where": { "title": "…", "project.name": "Apollo" } }, … }` and prints on stdout `{ "<lookup>": 42 }` — an id (string or number), a list of ids, or `null`. A run refuses to start unless each lookup has exactly one id, so return every match: ambiguity must show. Restrict it to development environments.
- **`{ values: { "<lookup>": 42 } }`**: no backend; ids written in the config, for apps whose demo data has stable ids.

A minimal resolver against an HTTP API:

```js
// scripts/demo-resolve.mjs
let input = '';
for await (const chunk of process.stdin) input += chunk;
const lookups = JSON.parse(input);
const result = {};
for (const [key, { entity, where }] of Object.entries(lookups)) {
    const response = await fetch(`http://localhost:3000/dev/lookup/${entity}?${new URLSearchParams(where)}`);
    result[key] = (await response.json()).map((record) => record.id);
}
console.log(JSON.stringify(result));
```

### Resetting the demo data

A scenario that changes data leaves the app in another state, even when it fails. `reset.command` restores the demo data (`npm run db:seed`, `docker compose exec app ./reset-demo-data`). It erases what is in the app, so `demo-studio reset` runs only with `DEMO_RESET_CONFIRM=1`. Make the command itself refuse anything but a development database.

## Writing your catalog

The catalog is the only knowledge the agent may cite; the validator refuses any feature, case, route, account or data id it does not hold. It replaces discovery: you, or your coding agent, derive it once from the app and keep it current like any other doc.

1. **Modules** from your app's sections or bounded contexts: an id, a title, a description, and `knowledge`: what someone must know before showing it (rules, pitfalls, vocabulary).
2. **Features** from your functional docs, test plans or acceptance criteria. Mark each `verified` (a test pass is recorded: manual test log, end-to-end suite), `documented` (described, never confirmed) or `inferred` (only seen in the code: a route, a menu entry). The agent prefers `verified` and shows `inferred` only in overviews. Give **cases** (`id`, `action`, `expected`) for what a scene can show and assert; case ids are unique within a module. Never renumber a case: mark it `obsolete: true` instead, so its id never changes meaning.
3. **Routes** from your router (`rails routes`, `php bin/console debug:router`, `next build` output, a Django `urls.py`, an OpenAPI spec): a name, a path template (`{id}` required, `{id?}` optional, `{path*}` several segments), a kind (`page` you can display, `api`, `action` such as a POST), and the module(s). Only `page` routes can open a scene.
4. **Navigation** from your menu: `"Section > Label"` → route. The agent shows the way to each screen through it.
5. **Accounts** from your seed or fixtures: one per role worth showing, described by what it can do. Their logins live in the config.
6. **Data** from your seed: the named records a demo can open (`project-apollo: Project "Apollo", twelve tasks of which three are overdue`). Describe them so that the agent can write criteria and narration without guessing. Prefer deterministic seeds: a random count cannot be narrated.

Asking Claude Code to draft it works well: *"Read the router, the main menu template, `docs/features/` and the seed files, and write `catalog.yaml` for demo-studio following its README; mark as verified only the features covered by the e2e suite."* Then review it like code. Run `demo-studio catalog` after each change.

## Catalog reference

```yaml
product: { name: Task Tracker, description: Plan projects and follow tasks. }   # optional
homeRoute: dashboard            # where scenes start; null disables the "show the way" advice
modules:
  - id: tasks                   # letters, digits, . _ - (no ':' — the plan cites `tasks:list`, `tasks:L1`)
    title: Tasks
    description: Create, assign and close tasks.
    knowledge: Overdue tasks are red. Closing asks for a confirmation.
    features:
      - id: list
        title: Task list
        description: Filterable by assignee.
        confidence: verified    # verified | documented | inferred
        cases:
          - { id: L1, action: Open a project's tasks, expected: Overdue ones in red, tags: [], obsolete: false }
routes:
  - { name: task_show, path: '/tasks/{id}', kind: page, module: tasks, description: A task and its side panel }
  - { name: dashboard, path: /, module: [tasks, reports] }
navigation:
  - { path: Projects > Tasks, route: project_tasks }
accounts:
  - { id: manager, description: Assigns and closes tasks, permissions: [tasks.assign] }
data:
  - { id: project-apollo, description: Project "Apollo", twelve tasks, entity: Project, modules: [tasks] }
```

The plan cites a feature as `<module>:<feature>` and a case as `<module>:<case>`. A plan's scene must use an entry route belonging to one of its features' modules. The catalog version is a hash of its content: it changes only when the catalog does, and the lock file records against which version a demo was validated and played.

## Demo sources

Each demo is a directory `demosDir/<id>/` (lowercase, digits, dashes):

| File | Written by | Content |
|---|---|---|
| `demo.yaml` | `context`, then by hand | id, title, description, status, audience, language, mode, modules, prompt, target duration |
| `plan.yaml` | the agent, then by hand | introduction, scenes and their narration, features shown and excluded with reasons |
| `scenario.yaml` | the agent, then by hand | per scene, the account and the steps, with anchors timing them on the voice |
| `demo.lock.json` | the tools only | catalog version validated and played dry, voice, last video. Rewritten only when what it records changes, not for a timestamp |

Plan and scenario are YAML so that they read and edit by hand; JSON is accepted. Their exact shape: `plan.schema.json` (written by `context`) and [`src/schema/scenario.ts`](src/schema/scenario.ts).

**Statuses.** `draft`: being written, or relying on data that does not replay identically. `reference`: kept in step with the code; `check` fails if it no longer validates or if its last dry run did not pass. Promote a demo to `reference` only once it replays identically (no fixed date, no random data) and its dry run passes.

**Plan.** Each scene has `id`, `title`, `featureIds`, `caseIds`, `entryRouteName` (a page route, or `null` when the scene continues on the previous screen), `account`, `dataRecords`, `dataRequirements`, `dataGaps`, `narrative` (read by the voice), `userActions`, `expectedOutcome`, `estimatedDurationSeconds` and `excerpt`. Every feature in scope that is not shown goes in `excludedFeatures` with a reason; what the brief asks and the catalog lacks goes in `unsupportedRequests`. No optional field: write `null` or `[]`, so that an omission differs from a choice. `validate` writes `coverage.md`: features shown out of those in scope, reasons for the others, data gaps, warnings.

**Excerpts.** A plan scene with `excerpt: { demo, scene }` reuses a scene already rendered in another demo (its frames and cursor) under new narration, spoken in one go: the way to compose a demo from others, or to show what has no screen. It has no scenario scene. The source's freezes are shortened in proportion to the new voice (0.4 s at least each), moving footage keeps its speed, and the last frame holds if the voice is longer. The source demo must have been rendered.

## Scenario reference

```yaml
scenarioVersion: 1
lookups:
  landing: { entity: Task, where: { title: Design the landing page }, dataRecord: task-landing-page }
scenes:
  - id: s2-assign                       # same ids, order and account as the plan's recorded scenes
    account: manager
    steps:
      - { id: open, action: goto, route: task_show, params: { id: { lookup: landing } } }
      - { id: pick, action: select, target: { label: Assignee }, option: Ada Lovelace, anchor: she picks Ada }
      - { id: due, action: fill, target: { label: Due date }, value: { daysFromToday: 7 } }
      - { id: shown, action: expectText, target: { testId: task-assignee }, text: Ada Lovelace }
```

**Closed registry of actions** — no arbitrary code: `goto` (route, `params`, `query`), `click`, `fill` (text, or a relative date), `select` (native `<select>`, by option label), `select2` (a Select2 widget: `search`, then an `option` that must match exactly one entry), `check`, `press` (`key`, optional target), `waitFor` (`state: visible|hidden`), `expectVisible`, `expectText` (`text`), `scrollTo`, `hold` (`ms`, at most 5000: reading time for the viewer, never to wait for the app).

**Targets**, from most to least robust, exactly one per target: `role` (+ `name`), `label`, `text`, `placeholder`, `testId`, `css`. Modifiers: `exact`, `nth` (0-based), `within` (another target as container).

**Dates** are relative to the day of the run: `{ daysFromToday: 7, format: dd/MM/yyyy }` (tokens `dd`, `MM`, `yyyy`; default `yyyy-MM-dd`).

**Anchors**: `anchor` quotes, word for word, a passage of one sentence of the scene's narration. In the edit, the picture freezes until the voice reaches it, then the cursor lands. One anchored gesture per sentence: a sentence already started cannot wait for the picture.

`scenario-check` refuses: scenes differing from the plan, a first step that is not a `goto`, unknown or non-page routes, missing parameters, undeclared lookups, unknown data records, anchors not in the narration, actions or keys outside the schema, accounts without a login in the config. It warns about each `goto` that does not start from `homeRoute` (with the navigation path to use), hard-coded ids and CSS targets.

## Narration, tracks and costs

- **ElevenLabs** (`narration.provider: elevenlabs`): each sentence is synthesised alone through `/with-timestamps` (MP3 128 kb/s), its neighbours sent as context for the intonation, and the character alignment times the anchors and subtitles. Model `eleven_v4` by default (`narration.modelId`, or `ELEVENLABS_MODEL_ID`). The key is read from `ELEVENLABS_API_KEY` (`narration.apiKeyEnv`), the voice from `ELEVENLABS_VOICE_ID_<LANG>` then `ELEVENLABS_VOICE_ID` (`narration.voiceIdEnv`); voice settings from `narration.voiceSettings`, overridden by `ELEVENLABS_STABILITY`, `ELEVENLABS_SIMILARITY_BOOST`, `ELEVENLABS_STYLE`, `ELEVENLABS_SPEED`. Put them in `.env.local`, never on a command line; the key is written nowhere.
- **Cache and cost**: sentences are cached in `.demo-studio/cache/narration/`, keyed by voice, model, language, settings, the sentence and its neighbours. Changing one sentence bills it and its two neighbours again; changing the voice or settings bills everything. `narrate` prints the characters billed. Do not retouch a synthesised narration lightly.
- **Pronunciations**: `narration.pronunciations: { en: [{ written: 'kubectl', spoken: 'cube control' }] }` dictates another spelling to the voice (a regular expression, flags `gi` by default); subtitles and anchors keep the written text.
- **Text only** (`--text-only`, or `provider: text`): no synthesis, nothing billed; each sentence lasts the time to read it (15 characters per second, 1.8 s at least).

| `--tracks` | Narration needed | File |
|---|---|---|
| `voice` (default) | synthesised | `video.mp4` |
| `subtitles` | any, `--text-only` is enough | `video-subtitles.mp4` (no audio track) |
| `voice,subtitles` | synthesised | `video-voice-subtitles.mp4` |

Variants coexist; once recorded, another variant is only a `render`. A text-only narration replaces `narration.json`: run `narrate` again (free from the cache) before rendering a voiced variant. `video.srt` is always written, for platforms showing their own subtitles.

Remotion has its own license: free for individuals and small companies, a company license above that size. Check [remotion.dev/license](https://www.remotion.dev/license) before using it at work.

## Guards

- A run refuses any `baseUrl` host outside `allowedHosts`, and blocks every external request outside `allowedExternalHosts` (listed after the run).
- It refuses to start if a lookup does not designate exactly one record, or if lookups changed since they were resolved.
- It stops at the first failing step, skipping nothing; a `goto` that redirects elsewhere (expired session, missing permission) fails; a `select2` matching several options fails rather than taking the first.
- Each scene starts from a fresh browser session, logged in off camera: what passes dry passes on camera. At the end, each scene must have opened the screen its plan announces (`entryRouteName`), otherwise a warning says so.
- A failed login leaves a screenshot in `diagnostics/login--<account>.png` (no DOM: it could hold the password).
- On failure, `diagnostics/` holds a full-page screenshot, the DOM and a Playwright trace (`npx playwright show-trace <file>`), and `execution.json` the log of each step (time, URL, element position, anchor) and the last console errors.
- `timeline` refuses a recording older than the scenario (step added, removed or renamed) and a narration older than the plan.

## Output layout

Everything regenerates from the sources, under `workDir` (`.demo-studio/`):

| Path | Written by | Content |
|---|---|---|
| `catalog.json` | `catalog` | the normalised catalog |
| `demos/<id>/catalog.json` | `context`, `validate` | the catalog the demo was checked against |
| `demos/<id>/context.md`, `plan.schema.json` | `context` | what the agent reads before writing; the plan's JSON schema |
| `demos/<id>/plan.json`, `coverage.json`, `coverage.md` | `validate` | the validated plan with its coverage |
| `demos/<id>/lookups.json`, `resolved.json` | `validate`, `resolve` | the lookups, then the ids found |
| `demos/<id>/execution.json`, `diagnostics/` | `dry-run` | step log; screenshot, DOM, trace on failure |
| `demos/<id>/narration.json`, `narration/` | `narrate` | one MP3 per sentence, its duration and character timing |
| `demos/<id>/recording.json`, `frames/` | `record` | step log and captured frames, on the same clock |
| `demos/<id>/timeline.json`, `video.srt` | `timeline` | per scene, played and frozen segments, cursor, voice clips |
| `demos/<id>/video*.mp4` | `render` | the video, at the viewport size, 30 fps |
| `cache/narration/` | `narrate` | sentence cache, shared by all demos |

## CI

`check` needs no browser, no app and no API key: run it on every change to catch demos outdated by a catalog change.

```yaml
demo-check:
  image: node:22
  script:
    - npm ci
    - npx demo-studio check
```

Replaying dry runs needs the app and its demo data: a nightly job can `reset`, then `dry-run` each reference demo, and commit nothing (the lock only changes if the result does). Rendering needs Chrome and minutes per demo: keep it a deliberate step.

## The Claude Code skill

[`skills/demo-studio/SKILL.md`](skills/demo-studio/SKILL.md) holds the method: what to read before writing, the rules a plan and a scenario must follow, what makes a good demo, how to repair a failing dry run, and what never to do (invent a feature, reset the data without asking). Install it in a project:

```bash
mkdir -p .claude/skills && cp -r node_modules/demo-studio/skills/demo-studio .claude/skills/
```

Commit it, then `/demo-studio <request>` in Claude Code. Adapt it freely: add your app's known pitfalls (a widget that needs a particular action, a panel hidden from assistive technologies) to its "Known pitfalls" section. Other coding agents can follow the same file as instructions.

## Limits and troubleshooting

- The registry is closed on purpose: drag and drop, file uploads, canvas drawing, multi-tab flows and hover-only menus are not supported. Report a missing gesture rather than working around it with `css` and `press`.
- One browser: Chromium. The video is the viewport size (1920×1080 by default) at 30 fps.
- Scenes show one account each; a flow involving two people is two scenes.
- Narration: ElevenLabs only for voice; any language it supports.

| Symptom | Cause and remedy |
|---|---|
| `Demo … refused (n errors)` | each error names the scene and the id; fix `plan.yaml` or `scenario.yaml` from `context.md` |
| `Invalid catalog` | each line names the module, route or record; `demo-studio catalog` to recheck |
| `Host "…" refused` | add the development host to `allowedHosts`; never a production host |
| `Executable doesn't exist` | `npx demo-studio browser`, or set `browser.chromePath` |
| `Demo data missing or ambiguous` | `DEMO_RESET_CONFIRM=1 npx demo-studio reset`, or fix the lookup criteria |
| `Login refused for account …` | look at `diagnostics/login--<account>.png`; check the login targets and `success` |
| `Environment variable … is not set` | add it to `.env.local` |
| `ElevenLabs refused the synthesis (HTTP 401)` | key without the text-to-speech permission, or quota exhausted |
| `anchor "…" is not in the scene's narration` | the anchor must quote one sentence of the plan's narrative word for word |
| `element off screen at the time of the gesture` | add a `scrollTo`, or target another element |
| recording fails where the dry run passed | the data was not reset: `reset`, then `record` |

## Developing Demo Studio

```bash
npm install          # also builds dist/ (prepare)
npm test             # Vitest; no browser needed
npm run type-check
npm run test:format
npm run demo-studio -- --config examples/task-tracker/demo-studio.config.ts check
```

From a git checkout without `dist/`, the bin runs the TypeScript sources directly. Remotion bundles the video composition from `src/video/`, which is why the sources ship with the package.

## License

[MIT](LICENSE). Remotion, a dependency, is licensed separately: see [remotion.dev/license](https://www.remotion.dev/license).
