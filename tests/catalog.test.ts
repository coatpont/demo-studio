import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { buildCatalog, CatalogError, loadCatalog, navigationPaths, parseRoutePath } from '../src/catalog/load.ts';
import { FIXTURE_CATALOG, fixtureCatalog } from './helpers.ts';

const git = { commit: null, branch: null, dirty: null };

function raw(): Record<string, unknown> {
    return parse(readFileSync(FIXTURE_CATALOG, 'utf8')) as Record<string, unknown>;
}

function errorsOf(input: unknown): string[] {
    try {
        buildCatalog(input, 'catalog.yaml', git);
    } catch (error) {
        if (error instanceof CatalogError) {
            return error.errors;
        }
        throw error;
    }

    return [];
}

describe('catalog loading', () => {
    const catalog = fixtureCatalog();

    it('normalises routes: parameters, optional and catch-all markers, modules', () => {
        const routes = Object.fromEntries(catalog.routes.map((route) => [route.name, route]));
        expect(routes.task_list).toMatchObject({
            path: '/projects/{project}/tasks',
            parameters: ['project'],
            kind: 'page',
            modules: ['tasks'],
        });
        expect(routes.report_week).toMatchObject({
            path: '/reports/{week}',
            parameters: [],
            optionalParameters: ['week'],
        });
        expect(routes.docs).toMatchObject({ parameters: ['page'], catchAllParameters: ['page'], modules: [] });
        expect(routes.dashboard.modules).toEqual(['tasks', 'reports']);
        expect(navigationPaths(catalog).get('task_list')).toEqual(['Work > Tasks']);
    });

    it('applies the defaults of optional fields', () => {
        const reports = catalog.modules.find((module) => 'reports' === module.id);
        expect(reports?.knowledge).toBe('');
        expect(reports?.features[0].cases).toEqual([]);
        expect(catalog.data.find((record) => 'user-ada' === record.id)).toMatchObject({ modules: [], entity: 'User' });
        expect(catalog.accounts.find((account) => 'guest' === account.id)?.permissions).toEqual([]);
    });

    it('keeps the same version as long as the content does not change', () => {
        expect(catalog.catalogVersion).toMatch(/^[0-9a-f]{16}$/);
        expect(buildCatalog(raw(), 'catalog.yaml', { commit: 'abc', branch: 'main', dirty: true }).catalogVersion).toBe(
            catalog.catalogVersion
        );
        const changed = raw();
        (changed.accounts as { description: string }[])[0].description = 'Another description';
        expect(buildCatalog(changed, 'catalog.yaml', git).catalogVersion).not.toBe(catalog.catalogVersion);
    });

    it('lists every broken cross-reference at once', () => {
        const input = raw();
        const modules = input.modules as { id: string; features: { id: string; cases: { id: string }[] }[] }[];
        modules.push({ ...modules[1], id: 'tasks' });
        modules[0].features[1].id = 'list';
        modules[0].features[1].cases[0].id = 'L1';
        (input.routes as Record<string, unknown>[]).push(
            { name: 'task_show', path: '/x' },
            { name: 'orphan', path: '/o/{id}/{id}', module: 'billing' }
        );
        (input.navigation as Record<string, unknown>[]).push({ path: 'Billing', route: 'invoices' });
        input.homeRoute = 'task_api';
        (input.data as Record<string, unknown>[]).push({ id: 'user-ada', description: 'twice', modules: ['crm'] });
        expect(errorsOf(input)).toEqual([
            'modules: duplicate id "tasks".',
            'module tasks: duplicate feature id "list".',
            'module tasks: duplicate case id "L1" (case ids are unique within a module).',
            'routes: duplicate name "task_show".',
            'route orphan: unknown module "billing".',
            'route orphan: parameter "id" appears twice in /o/{id}/{id}.',
            'navigation "Billing": unknown route "invoices".',
            'homeRoute: "task_api" is not a page (api).',
            'data: duplicate id "user-ada".',
            'data user-ada: unknown module "crm".',
        ]);
    });

    it('refuses an id that the plan could not cite, and unknown keys', () => {
        const input = raw();
        (input.modules as { id: string }[])[0].id = 'my tasks';
        input.colour = 'blue';
        const [error] = errorsOf(input);
        expect(error).toContain('module id');
        expect(error).toContain('colour');
    });

    it('reports invalid YAML and a missing file', () => {
        const directory = mkdtempSync(join(tmpdir(), 'catalog-'));
        writeFileSync(join(directory, 'catalog.yaml'), 'modules: [unclosed');
        expect(() => loadCatalog(join(directory, 'catalog.yaml'))).toThrow(/invalid YAML/);
        expect(() => loadCatalog(join(directory, 'absent.yaml'))).toThrow(/not found/);
    });
});

describe('parseRoutePath', () => {
    it('reads required, optional and catch-all parameters', () => {
        expect(parseRoutePath('/a/{id}/{tab?}/{rest*}')).toEqual({
            path: '/a/{id}/{tab}/{rest}',
            parameters: ['id', 'rest'],
            optionalParameters: ['tab'],
            catchAllParameters: ['rest'],
        });
    });
});
