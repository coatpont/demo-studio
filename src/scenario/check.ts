import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { catalogRoutes, navigationPaths } from '../catalog/load.ts';
import type { Catalog, Route } from '../catalog/schema.ts';
import { findAnchor, splitSentences } from '../narration/sentences.ts';
import type { DemoPlan } from '../schema/plan.ts';
import { ScenarioSchema, type Resolved, type Scenario, type Target } from '../schema/scenario.ts';

export interface ScenarioCheck {
    errors: string[];
    warnings: string[];
    scenario: Scenario | null;
}

function targets(scenario: Scenario): Target[] {
    return scenario.scenes.flatMap((scene) =>
        scene.steps.flatMap((step) => ('target' in step && step.target ? [step.target] : []))
    );
}

function navigationAdvice(step: string, home: string | null, paths: string[] | undefined): string {
    const start = home ? `start from the home page (${home})` : 'declare `homeRoute` in the catalog, start from it';
    const way = paths
        ? `and use the navigation "${paths.join('" or "')}".`
        : 'and get there by clicking, or justify the URL in the report.';

    return `${step} opens by its URL, without showing how to get there: ${start} ${way}`;
}

/** Static check of a scenario: shape, consistency with the validated plan, routes, accounts and lookups. */
export function checkScenario(text: string, plan: DemoPlan, catalog: Catalog): ScenarioCheck {
    let json: unknown;
    try {
        json = parseYaml(text);
    } catch (error) {
        return {
            errors: [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`],
            warnings: [],
            scenario: null,
        };
    }
    const parsed = ScenarioSchema.safeParse(json);
    if (!parsed.success) {
        return { errors: [z.prettifyError(parsed.error)], warnings: [], scenario: null };
    }
    const scenario = parsed.data;
    const errors: string[] = [];
    const warnings: string[] = [];
    const routes = catalogRoutes(catalog);
    const paths = navigationPaths(catalog);
    const records = new Set(catalog.data.map((record) => record.id));

    // A scene excerpted from another demo has nothing to play: the scenario holds only recorded scenes.
    const planIds = plan.scenes.filter((scene) => null === scene.excerpt).map((scene) => scene.id);
    const scenarioIds = scenario.scenes.map((scene) => scene.id);
    if (planIds.join('|') !== scenarioIds.join('|')) {
        errors.push(
            `Scenes ${scenarioIds.join(', ') || '(none)'} instead of the plan's scenes to record, in order: ${planIds.join(', ') || '(none)'}.`
        );
    }
    for (const [key, lookup] of Object.entries(scenario.lookups)) {
        if (lookup.dataRecord && !records.has(lookup.dataRecord)) {
            errors.push(`Lookup "${key}": unknown data record "${lookup.dataRecord}".`);
        }
    }
    const usedLookups = new Set<string>();
    for (const scene of scenario.scenes) {
        const planScene = plan.scenes.find((candidate) => candidate.id === scene.id);
        if (planScene && planScene.account !== scene.account) {
            errors.push(
                `Scene ${scene.id}: account "${scene.account}" instead of "${planScene.account}" planned by the plan.`
            );
        }
        const stepIds = new Set<string>();
        const sentences = splitSentences(planScene?.narrative ?? '');
        scene.steps.forEach((step, index) => {
            const where = `Scene ${scene.id}, step ${step.id}`;
            if (stepIds.has(step.id)) {
                errors.push(`${where}: duplicate step id.`);
            }
            stepIds.add(step.id);
            // The anchor times the gesture on the voice: it must read as is in the scene's narration.
            if (planScene && step.anchor && !findAnchor(sentences, step.anchor)) {
                errors.push(`${where}: anchor "${step.anchor}" is not in the scene's narration.`);
            }
            if (0 === index && 'goto' !== step.action) {
                errors.push(
                    `Scene ${scene.id}: the first step must open a page (goto), so that the scene replays alone.`
                );
            }
            if ('goto' !== step.action) {
                return;
            }
            const route = routes.get(step.route);
            if (!route) {
                errors.push(`${where}: route "${step.route}" is not in the catalog.`);

                return;
            }
            if ('page' !== route.kind) {
                errors.push(`${where}: route "${step.route}" is not a page (${route.kind}).`);
            }
            if (catalog.homeRoute !== step.route) {
                warnings.push(navigationAdvice(`${where}: "${step.route}"`, catalog.homeRoute, paths.get(step.route)));
            }
            for (const parameter of [...route.parameters, ...route.optionalParameters]) {
                const value = step.params?.[parameter];
                if (undefined === value && route.optionalParameters.includes(parameter)) {
                    continue;
                }
                if (undefined === value) {
                    errors.push(`${where}: parameter "${parameter}" of "${route.path}" is not set.`);
                } else if ('object' === typeof value) {
                    usedLookups.add(value.lookup);
                    if (!scenario.lookups[value.lookup]) {
                        errors.push(`${where}: lookup "${value.lookup}" is not declared.`);
                    }
                } else {
                    warnings.push(`${where}: parameter "${parameter}" is hard-coded (${value}) instead of a lookup.`);
                }
            }
        });
    }
    for (const key of Object.keys(scenario.lookups)) {
        if (!usedLookups.has(key)) {
            warnings.push(`Lookup "${key}" is declared but never used: it only checks that the data exists.`);
        }
    }
    if (targets(scenario).some((target) => undefined !== target.css)) {
        warnings.push('At least one target uses a CSS selector: replace it by a role, a label or a text if possible.');
    }

    return { errors, warnings, scenario: 0 === errors.length ? scenario : null };
}

/** Lookups as the `resolve` command receives them: entity and criteria, without the descriptive fields. */
export function lookupRequests(scenario: Scenario): Record<string, { entity: string; where: Record<string, unknown> }> {
    return Object.fromEntries(
        Object.entries(scenario.lookups).map(([key, lookup]) => [key, { entity: lookup.entity, where: lookup.where }])
    );
}

/** A route's path, its parameters replaced by the written values or the ids found. */
export function routePath(
    route: Route,
    params: Record<string, string | number | { lookup: string }> | undefined,
    resolved: Resolved,
    query?: Record<string, string>
): string {
    let path = route.path;
    for (const parameter of [...route.parameters, ...route.optionalParameters]) {
        const value = params?.[parameter];
        let text: string;
        if (undefined === value) {
            if (route.optionalParameters.includes(parameter)) {
                // Absent, it takes its default value: the segment disappears from the URL.
                path = path.replace(new RegExp(`/?\\{${parameter}\\}`), '');
                continue;
            }
            throw new Error(`Parameter "${parameter}" missing for "${route.name}"`);
        } else if ('object' === typeof value) {
            const ids = resolved[value.lookup] ?? [];
            if (1 !== ids.length) {
                throw new Error(`Lookup "${value.lookup}": ${ids.length} result(s) instead of exactly one`);
            }
            text = String(ids[0]);
        } else {
            text = String(value);
        }
        const encoded = route.catchAllParameters.includes(parameter)
            ? text.split('/').map(encodeURIComponent).join('/')
            : encodeURIComponent(text);
        path = path.replace(new RegExp(`\\{${parameter}\\}`), encoded);
    }
    const search = query ? new URLSearchParams(query).toString() : '';

    return search ? `${path || '/'}?${search}` : path || '/';
}

/** Matches a route's path, each parameter standing for any segment. */
export function routePattern(route: Route): RegExp {
    const escaped = route.path
        .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
        .replace(/\/?\{(\w+)\}/g, (_, name: string) => {
            const segment = route.catchAllParameters.includes(name) ? '/.+' : '/[^/]+';

            return route.optionalParameters.includes(name) ? `(?:${segment})?` : segment;
        })
        .replace(/\/+$/, '');

    return new RegExp(`^${escaped}/?$`);
}
