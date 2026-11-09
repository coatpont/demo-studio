import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/load.ts';
import { loadProject } from '../src/config/load.ts';
import { DemoStore, PLAN_FILE, requestOf, SCENARIO_FILE } from '../src/demos/store.ts';
import { checkPlan } from '../src/planner/plan.ts';
import { accountErrors } from '../src/runner/login.ts';
import { checkScenario } from '../src/scenario/check.ts';

const EXAMPLE = fileURLToPath(new URL('../examples/task-tracker/', import.meta.url));

// The shipped example must keep passing what `validate` and `scenario-check` enforce.
describe('task-tracker example', async () => {
    const { config, paths } = await loadProject('demo-studio.config.ts', EXAMPLE);
    const catalog = loadCatalog(paths.catalog, paths.root);
    const store = new DemoStore(paths.demos, paths.work);

    it.each(store.ids())('%s validates against the catalog and the config', (id) => {
        const manifest = store.manifest(id);
        const planCheck = checkPlan(store.source(id, PLAN_FILE) ?? '', catalog, requestOf(manifest));
        expect(planCheck.errors).toEqual([]);
        const scenarioCheck = checkScenario(store.source(id, SCENARIO_FILE) ?? '', planCheck.plan!, catalog);
        expect(scenarioCheck.errors).toEqual([]);
        const accounts = scenarioCheck.scenario!.scenes.map((scene) => scene.account);
        expect(accountErrors(accounts, config)).toEqual([]);
    });
});
