import { describe, expect, it } from 'vitest';
import { catalogRoutes } from '../src/catalog/load.ts';
import { checkPlan } from '../src/planner/plan.ts';
import { formatRelativeDate, landedWhereAsked } from '../src/runner/actions.ts';
import { assertAllowedBaseUrl, assertLookupsResolved, hostMatches, isRequestAllowed } from '../src/runner/run.ts';
import { describeTarget } from '../src/runner/targets.ts';
import { checkScenario, lookupRequests, routePath, routePattern } from '../src/scenario/check.ts';
import type { DemoPlan, PlanRequest } from '../src/schema/plan.ts';
import type { Scenario } from '../src/schema/scenario.ts';
import { fixtureCatalog } from './helpers.ts';

const catalog = fixtureCatalog();
const request: PlanRequest = {
    prompt: null,
    modules: ['tasks'],
    mode: 'deep-dive',
    audience: 'team leads',
    language: 'en',
    targetDurationSeconds: null,
};
const plan = checkPlan(
    JSON.stringify({
        title: 'Demo',
        objectives: [],
        audience: 'team leads',
        language: 'en',
        storyline: '',
        introduction: 'Welcome.',
        scenes: [
            {
                id: 's1',
                title: 'List',
                featureIds: ['tasks:list'],
                caseIds: [],
                entryRouteName: 'task_list',
                account: 'manager',
                dataRecords: [],
                dataRequirements: [],
                dataGaps: [],
                narrative: 'The task list.',
                userActions: [],
                expectedOutcome: '',
                estimatedDurationSeconds: 10,
            },
        ],
        excludedFeatures: [],
        unsupportedRequests: [],
    }),
    catalog,
    request
).plan as DemoPlan;

function scenario(overrides: Partial<Scenario> = {}): Scenario {
    return {
        scenarioVersion: 1,
        lookups: {
            landing: {
                entity: 'Task',
                where: { title: 'Design the landing page' },
                dataRecord: 'task-landing-page',
            },
        },
        scenes: [
            {
                id: 's1',
                account: 'manager',
                steps: [
                    { id: 'open', action: 'goto', route: 'task_show', params: { id: { lookup: 'landing' } } },
                    { id: 'tab', action: 'click', target: { role: 'tab', name: 'History' } },
                ],
            },
        ],
        ...overrides,
    };
}

describe('checkScenario', () => {
    it('accepts a scenario consistent with the plan and the catalog', () => {
        const check = checkScenario(JSON.stringify(scenario()), plan, catalog);
        expect(check.errors).toEqual([]);
        expect(check.scenario).not.toBeNull();
    });

    it('refuses a target designating the element two ways, or none', () => {
        const bad = scenario();
        bad.scenes[0].steps[1] = { id: 'tab', action: 'click', target: { role: 'tab', text: 'x' } };
        expect(checkScenario(JSON.stringify(bad), plan, catalog).errors[0]).toContain('exactly one of these keys');
    });

    it('refuses an action outside the registry', () => {
        const bad = JSON.parse(JSON.stringify(scenario()));
        bad.scenes[0].steps[1] = { id: 'x', action: 'evaluate', script: 'alert(1)' };
        expect(checkScenario(JSON.stringify(bad), plan, catalog).scenario).toBeNull();
    });

    it('refuses deviations from the plan, the routes, the parameters and the lookups', () => {
        const bad = scenario({
            lookups: { landing: { entity: 'Task', where: {}, dataRecord: 'task-invented' } },
        });
        bad.scenes[0].account = 'admin';
        bad.scenes[0].steps = [
            { id: 'a', action: 'click', target: { text: 'x' } },
            { id: 'b', action: 'goto', route: 'task_api' },
            { id: 'c', action: 'goto', route: 'task_show' },
            { id: 'c', action: 'goto', route: 'task_show', params: { id: { lookup: 'unknown' } } },
        ];
        expect(checkScenario(JSON.stringify(bad), plan, catalog).errors).toEqual([
            'Lookup "landing": unknown data record "task-invented".',
            'Scene s1: account "admin" instead of "manager" planned by the plan.',
            'Scene s1: the first step must open a page (goto), so that the scene replays alone.',
            'Scene s1, step b: route "task_api" is not a page (api).',
            'Scene s1, step c: parameter "id" of "/tasks/{id}" is not set.',
            'Scene s1, step c: duplicate step id.',
            'Scene s1, step c: lookup "unknown" is not declared.',
        ]);
    });

    it('refuses scenes that differ from the plan', () => {
        const bad = scenario();
        bad.scenes[0].id = 's9';
        expect(checkScenario(JSON.stringify(bad), plan, catalog).errors).toEqual([
            "Scenes s9 instead of the plan's scenes to record, in order: s1.",
        ]);
    });

    it('refuses an anchor absent from the scene narration', () => {
        const bad = scenario();
        bad.scenes[0].steps[1] = { ...bad.scenes[0].steps[1], anchor: 'A sentence never said' };
        expect(checkScenario(JSON.stringify(bad), plan, catalog).errors).toEqual([
            'Scene s1, step tab: anchor "A sentence never said" is not in the scene\'s narration.',
        ]);
        const good = scenario();
        good.scenes[0].steps[1] = { ...good.scenes[0].steps[1], anchor: 'the task list' };
        expect(checkScenario(JSON.stringify(good), plan, catalog).errors).toEqual([]);
    });

    it('warns about a page opened by its URL rather than from the home page', () => {
        const { warnings } = checkScenario(JSON.stringify(scenario()), plan, catalog);
        expect(warnings).toContain(
            'Scene s1, step open: "task_show" opens by its URL, without showing how to get there: ' +
                'start from the home page (dashboard) and get there by clicking, or justify the URL in the report.'
        );
        const byMenu = scenario();
        byMenu.scenes[0].steps = [
            { id: 'home', action: 'goto', route: 'dashboard' },
            { id: 'menu', action: 'goto', route: 'task_list', params: { project: 'apollo' } },
        ];
        const check = checkScenario(JSON.stringify(byMenu), plan, catalog);
        expect(check.errors).toEqual([]);
        expect(check.warnings.filter((warning) => warning.includes('opens by its URL'))).toEqual([
            'Scene s1, step menu: "task_list" opens by its URL, without showing how to get there: ' +
                'start from the home page (dashboard) and use the navigation "Work > Tasks".',
        ]);
    });

    it('asks for a home route when the catalog declares none', () => {
        const homeless = { ...catalog, homeRoute: null };
        const { warnings } = checkScenario(JSON.stringify(scenario()), plan, homeless);
        expect(warnings[0]).toContain('declare `homeRoute` in the catalog, start from it');
    });

    it('warns about a hard-coded id and a CSS target', () => {
        const loose = scenario();
        loose.scenes[0].steps = [
            { id: 'open', action: 'goto', route: 'task_show', params: { id: 7 } },
            { id: 'x', action: 'click', target: { css: '#register' } },
        ];
        const { warnings } = checkScenario(JSON.stringify(loose), plan, catalog);
        expect(warnings).toContain('Scene s1, step open: parameter "id" is hard-coded (7) instead of a lookup.');
        expect(warnings.some((warning) => warning.includes('CSS selector'))).toBe(true);
    });
});

describe('routePath', () => {
    const route = catalogRoutes(catalog).get('task_show')!;

    it('replaces the parameters by the ids found', () => {
        expect(routePath(route, { id: { lookup: 'landing' } }, { landing: [7] }, { tab: 'history' })).toBe(
            '/tasks/7?tab=history'
        );
        expect(routePath(route, { id: { lookup: 'landing' } }, { landing: ['a1b2'] })).toBe('/tasks/a1b2');
    });

    it('refuses a missing or ambiguous lookup', () => {
        expect(() => routePath(route, { id: { lookup: 'landing' } }, { landing: [] })).toThrow(/0 result/);
        expect(() => routePath(route, { id: { lookup: 'landing' } }, { landing: [7, 8] })).toThrow(/2 result/);
    });

    it('keeps the slashes of a catch-all parameter', () => {
        const docs = catalogRoutes(catalog).get('docs')!;
        expect(routePath(docs, { page: 'guides/getting started' }, {})).toBe('/docs/guides/getting%20started');
    });
});

describe('run guards', () => {
    it('accepts only the allowed hosts', () => {
        const allowed = ['localhost', '127.0.0.1', '*.localhost', '*.test'];
        expect(() => assertAllowedBaseUrl('http://tracker.test', allowed)).not.toThrow();
        expect(() => assertAllowedBaseUrl('https://localhost:8443', allowed)).not.toThrow();
        expect(() => assertAllowedBaseUrl('http://app.localhost', allowed)).not.toThrow();
        expect(() => assertAllowedBaseUrl('https://tracker.example.com', allowed)).toThrow(/allowedHosts/);
        expect(hostMatches('test', '*.test')).toBe(false);
        expect(hostMatches('A.Test', '*.test')).toBe(true);
    });

    it('blocks external services, except the allowed ones', () => {
        const base = 'http://tracker.test';
        const fonts = ['fonts.googleapis.com', 'fonts.gstatic.com'];
        expect(isRequestAllowed(`${base}/tasks/`, base, fonts)).toBe(true);
        expect(isRequestAllowed('https://fonts.gstatic.com/s/inter.woff2', base, fonts)).toBe(true);
        expect(isRequestAllowed('https://widget.example.com/chat.js', base, fonts)).toBe(false);
        expect(isRequestAllowed('data:image/png;base64,xx', base, fonts)).toBe(true);
        expect(isRequestAllowed('wss://widget.example.com/socket', base, fonts)).toBe(false);
        expect(isRequestAllowed('ws://tracker.test/hub', base, fonts)).toBe(true);
    });

    it('requires each lookup to designate exactly one record', () => {
        expect(() => assertLookupsResolved(scenario(), { landing: [7] })).not.toThrow();
        expect(() => assertLookupsResolved(scenario(), { landing: [] })).toThrow(/"landing" .* not found/);
        expect(() => assertLookupsResolved(scenario(), { landing: [1, 2] })).toThrow(/2 results/);
    });

    it('prepares the lookups for the resolver, without the descriptive fields', () => {
        expect(lookupRequests(scenario())).toEqual({
            landing: { entity: 'Task', where: { title: 'Design the landing page' } },
        });
    });

    it('describes a target readably for the logs', () => {
        expect(describeTarget({ text: 'Close', within: { css: '.drawer.open' }, nth: 1 })).toBe(
            'text "Close" #2 within css ".drawer.open"'
        );
    });

    it('counts a date from the day of the run, in the field format', () => {
        const today = new Date(2026, 7, 28);
        expect(formatRelativeDate({ daysFromToday: 7, format: 'dd/MM/yyyy' }, today)).toBe('04/09/2026');
        expect(formatRelativeDate({ daysFromToday: -1, format: 'yyyy-MM-dd' }, today)).toBe('2026-08-27');
    });
});

describe('optional parameters and path matching', () => {
    const route = {
        ...catalogRoutes(catalog).get('task_show')!,
        path: '/reports/{type}/{year}',
        parameters: ['type'],
        optionalParameters: ['year'],
    };

    it('removes an absent optional parameter, and fills it when given', () => {
        expect(routePath(route, { type: 'weekly' }, {})).toBe('/reports/weekly');
        expect(routePath(route, { type: 'weekly', year: 2027 }, {})).toBe('/reports/weekly/2027');
    });

    it('matches the path with or without the optional parameter', () => {
        const pattern = routePattern(route);
        expect(pattern.test('/reports/weekly')).toBe(true);
        expect(pattern.test('/reports/weekly/2027/')).toBe(true);
        expect(pattern.test('/reports')).toBe(false);
        expect(routePattern({ ...route, path: '/', parameters: [], optionalParameters: [] }).test('/')).toBe(true);
        const app = { ...route, path: '/app/{view}', parameters: ['view'], optionalParameters: [] };
        expect(routePattern(app).test('/app/board/settings')).toBe(false);
        expect(routePattern({ ...app, catchAllParameters: ['view'] }).test('/app/board/settings')).toBe(true);
    });
});

describe('redirect after a goto', () => {
    it('accepts a sub-page opened by the application, not another URL', () => {
        expect(landedWhereAsked('/signup/abc/step-1', '/signup/abc')).toBe(true);
        expect(landedWhereAsked('/tasks/', '/tasks')).toBe(true);
        expect(landedWhereAsked('/login', '/tasks')).toBe(false);
        expect(landedWhereAsked('/signup/abcd', '/signup/abc')).toBe(false);
        expect(landedWhereAsked('/login', '/')).toBe(false);
    });
});

describe('demo made of excerpts', () => {
    it('expects from the scenario only the scenes to record', () => {
        const excerpts = {
            ...plan,
            scenes: plan.scenes.map((scene) => ({ ...scene, excerpt: { demo: 'other', scene: scene.id } })),
        };
        const check = checkScenario(JSON.stringify({ scenarioVersion: 1, lookups: {}, scenes: [] }), excerpts, catalog);
        expect(check.errors).toEqual([]);
        expect(checkScenario(JSON.stringify(scenario()), excerpts, catalog).errors[0]).toContain(
            "instead of the plan's scenes to record"
        );
    });
});
