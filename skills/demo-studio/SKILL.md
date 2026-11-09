---
name: demo-studio
description: Prepare a narrated demo video of this web app from a plain-language request — you write the plan and the scenario yourself, no LLM API is called. The `demo-studio` CLI freezes what the app can show (its `catalog.yaml`), prepares the writing context, validates what you write against the catalog and computes its feature coverage, then plays the scenario in a browser, synthesises the narration (ElevenLabs) or subtitle-only timing, matches picture and voice, and renders an MP4 with the voice, burned-in subtitles, or both. Demos are versioned sources in the demos directory (manifest, plan, scenario, lock) checked against the current catalog. Covers overview or deep-dive mode, audience, language, target duration, choice of accounts and demo data, narration, scenes, excluded features and their reasons, missing data, the executable scenario, dry run and repair, narration, recording, timeline, render, video tracks, excerpts of other demos, and updating an existing demo. Use whenever the user talks about a demo video, product demo, walkthrough video, narration, voice-over, subtitles, demo-studio, demo plan, showing a module, feature coverage of a demo, reference demos, or updating a demo.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# Prepare a demo video

The scripts write nothing: they establish what exists, freeze the context and check the result. **You** write the plan and the scenario, reading the app's code whenever the context is not enough. The validator refuses any id missing from the catalog: never try to get around it — go back to the code, or tell the user the catalog lacks something.

Package documentation: the `demo-studio` README (`node_modules/demo-studio/README.md`, or the repository it was installed from).

## Before anything

- Read `demo-studio.config.(ts|mjs|json)` at the project root: base URL, demos directory (`demosDir`, default `demos/`), work directory (`workDir`, default `.demo-studio/`), catalog path, accounts and how they log in, whether `resolve` and `reset` are configured, narration provider.
- Read `catalog.yaml` (or the path in the config) once, to know the modules, accounts and demo data. If it is missing or `npx demo-studio catalog` refuses it, stop and help the user write or fix it (README, "Writing your catalog"); never write a demo against a catalog you made up for the occasion.
- All commands are `npx demo-studio <command> <demo>`; add `--config <path>` if the config is not found from the current directory. `npx demo-studio list` shows the existing demos.

## Arguments

Read the request from the arguments or the message: module(s), mode (`overview` or `deep-dive`), audience, narration language (config's `defaultLanguage` otherwise), target duration, free brief. What is not said takes the script's default; only ask the user about what really changes the plan.

## Where things are

- **Sources**, versioned: `<demosDir>/<demo>/` — `demo.yaml` (manifest), `plan.yaml`, `scenario.yaml` (you write them, in YAML), `demo.lock.json` (written by the tools only, committed with the demo).
- **Work**, regenerated: `<workDir>/demos/<demo>/` — context, validated plan, coverage, frames, voice, video.

## Updating an existing demo

When the user asks to update a demo (or `npx demo-studio check` reports one): `npx demo-studio context <demo>` for a fresh context, `npx demo-studio validate <demo>`, fix `plan.yaml` then `scenario.yaml` from the errors, replay dry (steps 6 and 7). Keep the narration as it is unless the screen or the feature changed: every retouched sentence is billed again by the synthesis, and the user has reviewed the narration. List the narration changes in your report, sentence by sentence.

## A new demo

### 1. Create the demo

```bash
npx demo-studio context tasks-deep-dive --module tasks --mode deep-dive --language en --duration 3m
npx demo-studio context product-tour --prompt "Present the product to a new customer" --duration 2m
```

The id (lowercase, digits, dashes) names the directory. The script creates `<demosDir>/<demo>/demo.yaml` (status `draft`), resolves the scope (a module named in the brief makes a `deep-dive`) and writes `context.md` and `plan.schema.json` to the work directory. Complete the manifest's title and description (what the demo shows, to whom, why). Set the status to `reference` only once the demo replays identically (no fixed date, no random data), it passed its dry run (`check` requires it, in CI) and the user approved it.

An unknown module: the script suggests close ones. The id is the module id of the catalog.

### 2. Read before writing

- `context.md` **in full**: request, accounts, shared demo data, then for each module its knowledge, entry points (navigation paths, pages), features with their cases and confidence, and its demo data.
- `plan.schema.json`: the exact shape of the draft.
- In `deep-dive`, the module's whole catalog entry, and where its demo data comes from (seed files, fixtures).
- **For each scene you keep, the code of what it shows**: the page's template or component and what it includes, for the real labels of buttons, tabs, fields and columns (resolve translation keys in the app's translation files for the demo's language); the route handler, policy or guard, for the permissions of the chosen account. A gesture whose button you cannot find does not go in the plan.

### 3. Write `plan.yaml`

Absolute rules:

- Cite only features, cases, routes, accounts and data records present in `context.md`, copying their ids exactly: `<module>:<feature>` for a feature (`tasks:assign`), `<module>:<case>` for a case (`tasks:A1`).
- `caseIds` cites only cases listed in the context. In `overview`, the context does not detail cases: leave `caseIds` empty.
- What the brief asks and the catalog does not hold goes in `unsupportedRequests`, with the reason.
- Every feature in scope that is not shown goes in `excludedFeatures`, with a short, concrete reason (duration, test-only case, data missing from the seed, redundant with another scene…).
- `entryRouteName`: a `page` route of one of the scene's modules, or `null` if the scene continues on the previous screen.
- `account`: an account of the context, the least privileged one with the permissions needed according to the route handler, the policy and the navigation; failing that, the administrator.
- `dataRecords`: the records the scene opens or changes. `dataRequirements` describes the data needed in plain words; `dataGaps` lists what the demo data does not provide (empty if everything is covered). Do not exclude a feature for "missing data" without reading the seed.

What makes a good demo:

- Leave out cases that check a technical refusal (request without a token, direct URL call, database check): they are for testing. A refusal visible and useful to the user (a button absent for an account without the permission) can be shown.
- Prefer `verified` features to `documented` ones; an `inferred` feature only in an overview.
- Order the scenes as a business journey: you welcome, follow, move forward, measure.
- In `deep-dive`, cover as many of the module's features as the duration allows. In `overview`, a few representative features of several modules, tied by a storyline.
- `introduction`: the welcome read on the title card, before the first scene, in two or three sentences (fifty words at most). It welcomes the viewer, says what the demo will show and to whom, and states that the people and data shown are fictional. No list of the scenes: one sentence on the storyline is enough.
- `narrative`: the text the voice reads during the scene, in the requested language. It says what the user does and why it helps, never citing a selector, an id, a route, a data record or an assertion. About 2.5 words per second for `estimatedDurationSeconds`.
- `userActions`: the gestures on screen in order, in short sentences, with the real labels read in the code ("click "Close task"").
- `expectedOutcome`: what must be visible at the end of the scene, from the expected result of the cases cited.
- **Excerpt scene** (`excerpt: { demo: <demo>, scene: <scene> }`): it reuses a scene already edited in another demo (its frames, its cursor), under this demo's narration, spoken in one go. It is the way to present what has no screen in the app (the tool itself, a process) or to compose a demo from others. Copy `featureIds`, `entryRouteName` and `account` from the source scene; the source demo must have been rendered (`npx demo-studio render <source>`). An excerpt scene has no scenario scene: if all are excerpts, `scenario.yaml` has `scenes: []`. Its narration anchors on no gesture. The scene fits itself to it: the source's freezes, which waited for the old voice, are shortened in proportion (0.4 s at least each), moving footage keeps its speed, and if the voice outlasts the source, the last frame stays. Aim for a narration at least as long as the moving parts of the source (`timeline.json` of the source, non-frozen segments), otherwise the end of the excerpt runs without voice.

### 4. Validate

```bash
npx demo-studio validate <demo>
```

Refused: fix `plan.yaml` from each error and run again. An error that comes back after a fix signals a misunderstanding of the catalog: reread `context.md` rather than trying a variant. Accepted: the script writes `plan.json`, `coverage.json` and `coverage.md` to the work directory and prints the warnings (duration far from the target, feature without a recorded test pass).

## Phase 2: executable scenario and dry run

From a validated plan, and only if the user asks to go as far as running it.

### 5. Write `scenario.yaml`

Format: `src/schema/scenario.ts` of the package, and the README's "Scenario reference". One scenario scene per recorded plan scene, same ids, same order, same account. Each scene starts with a `goto`, so that it replays alone.

- **Show the way**: the viewer must be able to redo the journey. A scene starts from the home page (`goto` on the catalog's `homeRoute`) and reaches its screens by clicking, through the navigation when the screen is in it ("Section > Label" paths in `context.md`), otherwise through the page's links (a record from a list or the search). A `goto` to another page is kept only if the way has been shown in a previous scene or has nothing useful to show, and is justified in your report; the check warns about each `goto` that does not start from the home page. Anchor the navigation click on the sentence that names the screen.
- **Closed registry**: `goto`, `click`, `fill`, `select`, `select2`, `check`, `press`, `waitFor`, `expectVisible`, `expectText`, `scrollTo`, `hold`. No arbitrary code. A gesture the registry cannot do is reported to the user; the registry is never widened on the quiet.
- **Targets**, by order of preference: `role` + `name`, `label`, `text`, `placeholder`, `testId`, `css` as a last resort. `within` restricts to a container. A target has exactly one designation key.
- **Dates**: never a fixed date in an entry, it would stop being valid. `value: { daysFromToday: 7 }` (format `yyyy-MM-dd` by default, `format:` otherwise, with `dd`, `MM`, `yyyy`) counts from the day of the run; stay inside the current period if the screen filters by period.
- **Select2**: `option` is an extract of the label, but it must designate exactly one option of the list; otherwise the step fails.
- **Data**: never a hard-coded id. A route parameter takes `{ lookup: <key> }`, and the key is declared in `lookups` (entity, criteria, `dataRecord` from the catalog). Declare a lookup for every record the scene relies on too: the run refuses to start if a lookup does not designate exactly one record. Write criteria that your resolver understands (read the `resolve` command or its documentation).
- `anchor`: the passage of the narration the gesture must coincide with, copied word for word from a single sentence (the check refuses an anchor it cannot find). In the edit, the picture freezes until the voice reaches that passage. Anchor visible gestures (tab, button, row found), not technical waits. A sentence carrying several anchors cannot wait for the picture once started: for a run of close gestures (a form), one short sentence per anchored gesture; `timeline` warns when a gesture comes after the words of its anchor.
- The `expect…` steps say what the viewer must see: the expected outcome of the plan, nothing more.

**Known pitfalls** (add your app's own here): a panel or drawer marked `aria-hidden="true"` even when open hides its content from `role` and `label`: target by `text` within the panel's container. A tab's accessible name can include its counter: do not use `exact`. A page with tabs can reopen the last tab visited: click the wanted tab explicitly at the start of each scene. A table row is selected by clicking a cell that is not a link.

### 6. Check, then play dry

```bash
npx demo-studio scenario-check <demo>   # shape, plan, routes, lookups, accounts
npx demo-studio dry-run <demo>          # + lookups resolved in the app + browser
```

First use on a machine: `npx demo-studio browser` (Playwright's Chromium), unless a Chrome is configured.

The run stops at the first failing step and leaves the screenshot, the DOM and the Playwright trace in `diagnostics/`, and in `execution.json` the log of each step (time, element position, URL).

### 7. Repair

- Read the screenshot and the error, search the captured DOM for the real label, fix the step. If the screen contradicts the plan (data missing, feature done otherwise), fix the plan first (`plan.yaml`, `validate`), then the scenario.
- **A scenario that changes data** leaves the app in another state after a pass, even a failed one: the data must be reset before replaying from the start. `npx demo-studio reset` erases the app's data: **ask the user before every reset**, and run it with `DEMO_RESET_CONFIRM=1` only once they have agreed.
- **Five passes at most** for a scenario. Beyond, stop and report what blocks, with the screenshot.
- A defect of the app discovered on the way (accessibility, server error…) is reported to the user at once, without fixing it in the demo's branch.

## Phase 3: the video

From a scenario that passes dry, and only if the user asks for the video.

### 8. Choose the tracks, then produce

The video carries, as the user chooses, the **voice** (spoken narration), **subtitles** burned into the picture, or both. Without a word on it, the voice alone. `--tracks` tells the whole chain:

| Request | `--tracks` | Narration | File produced |
|---|---|---|---|
| voice only (default) | `voice` | ElevenLabs synthesis | `video.mp4` |
| subtitles only, no sound | `subtitles` | no synthesis: each sentence stays the time to read it (15 characters per second, 1.8 s at least), nothing billed | `video-subtitles.mp4` |
| voice and subtitles | `voice,subtitles` | ElevenLabs synthesis, subtitles timed on the voice | `video-voice-subtitles.mp4` |

```bash
DEMO_RESET_CONFIRM=1 npx demo-studio reset                  # with the user's agreement, if the scenario changes data
npx demo-studio video <demo> --tracks voice,subtitles       # narration, recording, timeline, render
npx demo-studio render <demo> --tracks subtitles            # another variant, without recording again
```

- A request "with subtitles" or "without sound" translates into `--tracks`, without changing the plan or the scenario. An ambiguous request ("subtitles": on top of the voice, or instead of it?) is settled with the user before running the synthesis, which is billed.
- Variants coexist in the work directory: once recorded, each other variant is only a `render`. But the narration without voice (`--text-only`) replaces `narration.json`: to go back to a voiced variant, run `npx demo-studio narrate <demo>` again (the voice comes back from the cache, nothing is billed again), then `render`. A voiced variant is refused while the narration has no voice.
- The pace of a video without voice is the reading pace, often a little shorter than the voice: anchors stay valid, the timeline places them in proportion to the sentence.
- `video.srt` always comes with the video, whatever the tracks: it is the file to give a platform that shows its own subtitles.

The ElevenLabs key and voice come from the environment or `.env.local` (names in the config's `narration`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` or `ELEVENLABS_VOICE_ID_<LANG>` by default): never write them anywhere else, never print them. The narration is cached, but every sentence changed in the plan is billed again: do not retouch a synthesised narration lightly.

### 9. Look before reporting

Do not announce a successful video on the sole faith of the commands. Extract a few frames of the produced video at the times of the anchored gestures (scene start + end of the frozen segment preceding the gesture in `timeline.json`, e.g. with `ffmpeg -ss <s> -i video.mp4 -frames:v 1 frame.png`) and look at them: is the element the voice talks about on screen, the cursor on the right target? The warnings of `timeline` (anchor missing, element off screen) are fixed in the scenario, then replayed from a reset.

With burned-in subtitles, also check that they do not hide the element the sentence talks about, at the bottom of the screen; if they do, bring the element higher in the scenario (`scrollTo`). Without voice, check the track: `ffprobe` must list a single video stream.

## Report

- The title, the scenes (one line each: what it shows, account, data), the estimated duration.
- The coverage: features shown out of the total, and the excluded ones with their reason, grouped.
- The data missing from the demo data and the validator's warnings.
- What was checked in the code (labels, permissions) and what only came from the context.
- The path of the sources (`<demosDir>/<demo>/`) and of `coverage.md`; for a video, the path of each variant produced and its tracks (voice, subtitles), with what the synthesis cost (characters billed, or nothing without voice).

## Never

- Write `demo.lock.json` or the work directory's files by hand: only the tools produce them.
- Reset the app's data without the user's explicit agreement: `reset` erases everything in it, including data they may have imported.
- Invent a feature, a label or a record to fill the duration: a shorter, exact demo is worth more.
- Add a feature to `catalog.yaml` to make your plan pass: the catalog describes the app; changing it is a separate decision for the user.
- Point `baseUrl` or `allowedHosts` at a production host.
