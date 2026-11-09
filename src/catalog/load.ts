import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { gitInfo, type GitInfo } from '../project/git.ts';
import { CatalogInputSchema, type Catalog, type CatalogInput, type Route } from './schema.ts';

export class CatalogError extends Error {
    readonly errors: string[];

    constructor(file: string, errors: string[]) {
        super(
            `Invalid catalog ${file} (${errors.length} error${1 === errors.length ? '' : 's'}):\n- ${errors.join('\n- ')}`
        );
        this.errors = errors;
    }
}

/** `{id}` required, `{id?}` optional, `{path*}` catch-all; the stored path keeps plain `{id}`. */
export function parseRoutePath(
    template: string
): Pick<Route, 'path' | 'parameters' | 'optionalParameters' | 'catchAllParameters'> {
    const parameters: string[] = [];
    const optionalParameters: string[] = [];
    const catchAllParameters: string[] = [];
    const path = template.replace(/\{(\w+)([?*]{0,2})\}/g, (_, name: string, markers: string) => {
        (markers.includes('?') ? optionalParameters : parameters).push(name);
        if (markers.includes('*')) {
            catchAllParameters.push(name);
        }

        return `{${name}}`;
    });

    return { path, parameters, optionalParameters, catchAllParameters };
}

function duplicates(values: string[]): string[] {
    return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/** Cross-references the schema cannot express: unique ids, and every reference pointing to something declared. */
export function catalogErrors(input: CatalogInput): string[] {
    const errors: string[] = [];
    const moduleIds = new Set(input.modules.map((module) => module.id));
    const routeNames = new Set(input.routes.map((route) => route.name));
    duplicates(input.modules.map((module) => module.id)).forEach((id) => errors.push(`modules: duplicate id "${id}".`));
    for (const module of input.modules) {
        duplicates(module.features.map((feature) => feature.id)).forEach((id) =>
            errors.push(`module ${module.id}: duplicate feature id "${id}".`)
        );
        duplicates(module.features.flatMap((feature) => feature.cases.map((item) => item.id))).forEach((id) =>
            errors.push(`module ${module.id}: duplicate case id "${id}" (case ids are unique within a module).`)
        );
    }
    duplicates(input.routes.map((route) => route.name)).forEach((name) =>
        errors.push(`routes: duplicate name "${name}".`)
    );
    for (const route of input.routes) {
        for (const module of [route.module ?? []].flat()) {
            if (!moduleIds.has(module)) {
                errors.push(`route ${route.name}: unknown module "${module}".`);
            }
        }
        const { parameters, optionalParameters } = parseRoutePath(route.path);
        duplicates([...parameters, ...optionalParameters]).forEach((name) =>
            errors.push(`route ${route.name}: parameter "${name}" appears twice in ${route.path}.`)
        );
    }
    for (const entry of input.navigation) {
        if (!routeNames.has(entry.route)) {
            errors.push(`navigation "${entry.path}": unknown route "${entry.route}".`);
        }
    }
    if (null !== input.homeRoute) {
        const home = input.routes.find((route) => route.name === input.homeRoute);
        if (!home) {
            errors.push(`homeRoute: unknown route "${input.homeRoute}".`);
        } else if ('page' !== home.kind) {
            errors.push(`homeRoute: "${input.homeRoute}" is not a page (${home.kind}).`);
        }
    }
    duplicates(input.accounts.map((account) => account.id)).forEach((id) =>
        errors.push(`accounts: duplicate id "${id}".`)
    );
    duplicates(input.data.map((record) => record.id)).forEach((id) => errors.push(`data: duplicate id "${id}".`));
    for (const record of input.data) {
        for (const module of record.modules) {
            if (!moduleIds.has(module)) {
                errors.push(`data ${record.id}: unknown module "${module}".`);
            }
        }
    }

    return errors;
}

/** Validates a parsed catalog and normalises it; throws a `CatalogError` listing every problem. */
export function buildCatalog(raw: unknown, file: string, git: GitInfo): Catalog {
    const parsed = CatalogInputSchema.safeParse(raw);
    if (!parsed.success) {
        throw new CatalogError(file, [z.prettifyError(parsed.error)]);
    }
    const input = parsed.data;
    const errors = catalogErrors(input);
    if (errors.length > 0) {
        throw new CatalogError(file, errors);
    }
    const content = {
        product: input.product ?? null,
        homeRoute: input.homeRoute,
        modules: input.modules,
        routes: input.routes.map((route): Route => ({
            name: route.name,
            ...parseRoutePath(route.path),
            kind: route.kind,
            modules: [route.module ?? []].flat(),
            description: route.description,
        })),
        navigation: input.navigation,
        accounts: input.accounts,
        data: input.data.map((record) => ({ ...record, entity: record.entity ?? null })),
    };
    const catalogVersion = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);

    return { catalogVersion, git, ...content };
}

export function loadCatalog(file: string, root: string = dirname(file)): Catalog {
    if (!existsSync(file)) {
        throw new Error(`Catalog ${file} not found: write it first (see "Writing your catalog" in the README).`);
    }
    let raw: unknown;
    try {
        raw = parseYaml(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new CatalogError(file, [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`]);
    }

    return buildCatalog(raw, file, gitInfo(root));
}

export function catalogRoutes(catalog: Catalog): Map<string, Route> {
    return new Map(catalog.routes.map((route) => [route.name, route]));
}

/** Navigation paths of each route, "Section > Label". */
export function navigationPaths(catalog: Catalog): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    for (const entry of catalog.navigation) {
        const known = paths.get(entry.route) ?? [];
        if (!known.includes(entry.path)) {
            paths.set(entry.route, [...known, entry.path]);
        }
    }

    return paths;
}
