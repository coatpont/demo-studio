import { describe, expect, it } from 'vitest';
import { buildPlannerContext } from '../src/planner/context.ts';
import { coverageMarkdown } from '../src/planner/coverage.ts';
import { checkPlan, plannerOutputJsonSchema } from '../src/planner/plan.ts';
import { buildScope, resolveModulesAndMode } from '../src/planner/scope.ts';
import { validatePlan } from '../src/planner/validate.ts';
import type { PlannerOutput, PlanRequest } from '../src/schema/plan.ts';
import { fixtureCatalog } from './helpers.ts';

const catalog = fixtureCatalog();
const request: PlanRequest = {
    prompt: null,
    modules: ['tasks'],
    mode: 'deep-dive',
    audience: 'team leads',
    language: 'en',
    targetDurationSeconds: 60,
};

function validPlan(): PlannerOutput {
    return {
        title: 'Follow your tasks',
        objectives: ['Show the list'],
        audience: 'team leads',
        language: 'en',
        storyline: 'From the list to an assigned task.',
        introduction: 'Welcome to this demonstration of task tracking.',
        scenes: [
            {
                id: 's1',
                title: 'The list',
                featureIds: ['tasks:list'],
                caseIds: ['tasks:L1'],
                entryRouteName: 'task_list',
                account: 'manager',
                dataRecords: ['project-apollo'],
                dataRequirements: ['a project with overdue tasks'],
                dataGaps: [],
                narrative: 'The list gathers the tasks of the project.',
                userActions: ['Open the list'],
                expectedOutcome: 'Three tasks are shown in red',
                estimatedDurationSeconds: 30,
                excerpt: null,
            },
            {
                id: 's2',
                title: 'Assign',
                featureIds: ['tasks:assign'],
                caseIds: ['tasks:A1'],
                entryRouteName: null,
                account: 'admin',
                dataRecords: [],
                dataRequirements: [],
                dataGaps: ['a task without assignee'],
                narrative: 'We assign a task.',
                userActions: ['Assign a task'],
                expectedOutcome: 'The avatar appears',
                estimatedDurationSeconds: 30,
                excerpt: null,
            },
        ],
        excludedFeatures: [{ featureId: 'tasks:refusal', reason: 'technical case' }],
        unsupportedRequests: [{ request: 'the mobile app', reason: 'not in the catalog' }],
    };
}

describe('resolveModulesAndMode', () => {
    it('chooses a deep dive on a module named in the brief, otherwise an overview', () => {
        expect(
            resolveModulesAndMode(catalog, { modules: [], prompt: 'A thorough demo of the Tasks', mode: null })
        ).toEqual({
            modules: ['tasks'],
            mode: 'deep-dive',
        });
        expect(resolveModulesAndMode(catalog, { modules: [], prompt: 'Present the product', mode: null })).toEqual({
            modules: [],
            mode: 'overview',
        });
        expect(() => resolveModulesAndMode(catalog, { modules: ['unknown'], prompt: null, mode: null })).toThrow(
            /not found/
        );
    });
});

describe('buildScope', () => {
    it('keeps features without cases and drops the obsolete cases', () => {
        const scope = buildScope(catalog, { ...request, modules: [], mode: 'overview' });
        expect(scope.features.map((feature) => feature.id)).toEqual([
            'tasks:list',
            'tasks:assign',
            'tasks:refusal',
            'reports:burndown',
        ]);
        expect(scope.features[0].cases.map((item) => item.id)).toEqual(['L1', 'L2']);
        expect(scope.features[3].routeNames).toEqual(['dashboard', 'report_week']);
    });
});

describe('buildPlannerContext', () => {
    it('gives the writer the live cases, entry points, accounts, knowledge and data', () => {
        const context = buildPlannerContext(catalog, request, buildScope(catalog, request));
        expect(context).toContain('`tasks:L1`');
        expect(context).not.toContain('tasks:L3');
        expect(context).toContain('Navigation "Work > Tasks" → route `task_list`');
        expect(context).toContain('Page `task_show`: /tasks/{id} — A task with its history and comments');
        expect(context).toContain('- `manager`: Project manager; creates and assigns tasks (permissions: tasks.edit)');
        expect(context).toContain('Overdue tasks are shown in red.');
        expect(context).toContain('`user-ada` (User)');
        expect(context).toContain('`project-apollo` (Project)');
        expect(context).toContain('# Home page: route `dashboard`');
    });

    it('summarises every module in an overview', () => {
        const overview = { ...request, modules: [], mode: 'overview' as const };
        const context = buildPlannerContext(catalog, overview, buildScope(catalog, overview));
        expect(context).toContain('- `tasks:list` Task list [verified, 2 cases]');
        expect(context).toContain('- `reports:burndown` Burndown chart [inferred, 0 cases]');
        expect(context).not.toContain('`tasks:L1`');
    });
});

describe('validatePlan', () => {
    const scope = buildScope(catalog, request);

    it('accepts a plan that cites only the catalog', () => {
        expect(validatePlan(validPlan(), catalog, request, scope).errors).toEqual([]);
    });

    it('refuses any invented or out-of-scope id', () => {
        const plan = validPlan();
        plan.scenes[0].featureIds = ['tasks:invented'];
        plan.scenes[0].caseIds = ['tasks:L1'];
        plan.scenes[0].entryRouteName = 'task_api';
        plan.scenes[0].account = 'ceo';
        plan.scenes[0].dataRecords = ['project-zeus'];
        plan.scenes[1].id = 's1';
        const { errors } = validatePlan(plan, catalog, request, scope);
        expect(errors).toEqual([
            'Scene s1: feature "tasks:invented" is not in the catalog or outside the requested scope.',
            'Scene s1: case "tasks:L1" is unknown or belongs to none of the scene\'s features.',
            'Scene s1: route "task_api" is not a page (api).',
            'Scene s1: account "ceo" is not in the catalog.',
            'Scene s1: unknown data record "project-zeus".',
            'Scene s1: duplicate scene id.',
        ]);
    });

    it('refuses an entry page of another module, and a feature outside the requested modules', () => {
        const plan = validPlan();
        plan.scenes[0].entryRouteName = 'report_week';
        plan.scenes[1].featureIds = ['reports:burndown'];
        plan.scenes[1].caseIds = [];
        expect(validatePlan(plan, catalog, request, scope).errors).toEqual([
            'Scene s1: route "report_week" belongs to none of the scene\'s modules.',
            'Scene s2: feature "reports:burndown" is not in the catalog or outside the requested scope.',
        ]);
    });

    it('refuses an empty introduction and another language', () => {
        const plan = validPlan();
        plan.introduction = ' ';
        plan.language = 'fr';
        expect(validatePlan(plan, catalog, request, scope).errors).toEqual([
            'The introduction is empty: it is read on the title card.',
            'Language "fr" instead of "en".',
        ]);
    });

    it('warns without blocking about a duration far from the target and an inferred feature', () => {
        const plan = validPlan();
        plan.scenes[0].estimatedDurationSeconds = 200;
        expect(validatePlan(plan, catalog, request, scope).warnings).toEqual([
            'Estimated duration 230 s for a target of 60 s.',
        ]);
        const overview = { ...request, modules: [], mode: 'overview' as const };
        const inferred = validPlan();
        inferred.scenes[1].featureIds = ['reports:burndown'];
        inferred.scenes[1].caseIds = [];
        expect(validatePlan(inferred, catalog, overview, buildScope(catalog, overview)).warnings).toContain(
            'Scene s2: shows a feature only inferred from the code, without a documented case.'
        );
    });
});

describe('checkPlan', () => {
    it('refuses an unreadable draft or one outside the schema, with details', () => {
        expect(checkPlan('title: [unclosed', catalog, request).errors[0]).toMatch(/^invalid YAML/);
        const { errors, plan } = checkPlan('{"title": 3}', catalog, request);
        expect(plan).toBeNull();
        expect(errors[0]).toContain('title');
    });

    it('refuses a draft citing an unknown case', () => {
        const wrong = validPlan();
        wrong.scenes[0].caseIds = ['tasks:L9'];
        const { errors, plan } = checkPlan(JSON.stringify(wrong), catalog, request);
        expect(plan).toBeNull();
        expect(errors).toEqual(['Scene s1: case "tasks:L9" is unknown or belongs to none of the scene\'s features.']);
    });

    it('refuses an obsolete case', () => {
        const wrong = validPlan();
        wrong.scenes[0].caseIds = ['tasks:L3'];
        expect(checkPlan(JSON.stringify(wrong), catalog, request).plan).toBeNull();
    });

    it('turns a valid draft into a plan dated by the catalog, with its coverage', () => {
        const { plan } = checkPlan(JSON.stringify(validPlan()), catalog, request);
        expect(plan).toMatchObject({
            planVersion: 1,
            mode: 'deep-dive',
            catalogVersion: catalog.catalogVersion,
            estimatedDurationSeconds: 60,
        });
        expect(plan?.coverage.features.map((entry) => [entry.featureId, entry.status, entry.reason])).toEqual([
            ['tasks:list', 'included', null],
            ['tasks:assign', 'included', null],
            ['tasks:refusal', 'excluded', 'technical case'],
        ]);
        expect(plan?.coverage.summary).toEqual({
            featuresInScope: 3,
            featuresIncluded: 2,
            casesInScope: 5,
            casesIncluded: 2,
        });
        expect(plan?.coverage.dataGaps).toEqual([{ scene: 's2', gap: 'a task without assignee' }]);
        const markdown = coverageMarkdown(plan?.title ?? '', plan!.coverage);
        expect(markdown).toContain('| `tasks:refusal` Refusals | documented | excluded |  |  | technical case |');
        expect(markdown).toContain('- the mobile app: not in the catalog');
    });

    it('publishes the draft schema', () => {
        const schema = plannerOutputJsonSchema() as { properties: Record<string, unknown> };
        expect(Object.keys(schema.properties)).toContain('scenes');
    });
});
