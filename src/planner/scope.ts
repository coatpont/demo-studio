import type { Account, Case, Catalog, Confidence, Module } from '../catalog/schema.ts';
import { normalize } from '../project/text.ts';
import type { DemoMode, PlanRequest } from '../schema/plan.ts';

export interface ScopeFeature {
    // `<module>:<feature>`, as the plan cites it.
    id: string;
    title: string;
    description: string;
    confidence: Confidence;
    moduleId: string;
    cases: Case[];
    routeNames: string[];
}

export interface Scope {
    modules: Module[];
    features: ScopeFeature[];
    accounts: Account[];
}

export function findModule(catalog: Catalog, query: string): Module {
    const key = normalize(query);
    const module =
        catalog.modules.find((candidate) => candidate.id === query) ??
        catalog.modules.find((candidate) => normalize(candidate.id) === key || normalize(candidate.title) === key);
    if (!module) {
        const close = catalog.modules
            .filter(
                (candidate) =>
                    normalize(candidate.id).includes(key.slice(0, 5)) ||
                    normalize(candidate.title).includes(key.slice(0, 5))
            )
            .map((candidate) => candidate.id);
        throw new Error(
            `Module "${query}" not found in the catalog.${close.length ? ` Close modules: ${close.join(', ')}` : ''}`
        );
    }

    return module;
}

/** Modules named in a plain-language request, by id or title. */
export function modulesMentioned(catalog: Catalog, prompt: string): Module[] {
    const text = normalize(prompt);

    return catalog.modules.filter((module) =>
        [module.id, module.title].map(normalize).some((name) => name.length >= 5 && text.includes(name))
    );
}

export function resolveModulesAndMode(
    catalog: Catalog,
    options: { modules: string[]; prompt: string | null; mode: DemoMode | null }
): { modules: string[]; mode: DemoMode } {
    if (options.modules.length > 0) {
        return {
            modules: options.modules.map((query) => findModule(catalog, query).id),
            mode: options.mode ?? 'deep-dive',
        };
    }
    const mentioned = options.prompt ? modulesMentioned(catalog, options.prompt) : [];
    if (mentioned.length > 0 && 'overview' !== options.mode) {
        return { modules: mentioned.map((module) => module.id), mode: options.mode ?? 'deep-dive' };
    }

    return { modules: [], mode: options.mode ?? 'overview' };
}

/** A feature whose every case is obsolete has nothing left to show. */
export function buildScope(catalog: Catalog, request: PlanRequest): Scope {
    const modules =
        0 === request.modules.length ? catalog.modules : request.modules.map((id) => findModule(catalog, id));
    const features: ScopeFeature[] = modules.flatMap((module) => {
        const routeNames = catalog.routes
            .filter((route) => route.modules.includes(module.id))
            .map((route) => route.name);

        return module.features
            .filter((feature) => 0 === feature.cases.length || feature.cases.some((item) => !item.obsolete))
            .map((feature) => ({
                id: `${module.id}:${feature.id}`,
                title: feature.title,
                description: feature.description,
                confidence: feature.confidence,
                moduleId: module.id,
                cases: feature.cases.filter((item) => !item.obsolete),
                routeNames,
            }));
    });

    return { modules, features, accounts: catalog.accounts };
}
