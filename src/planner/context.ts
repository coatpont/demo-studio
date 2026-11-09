import { navigationPaths } from '../catalog/load.ts';
import type { Catalog, DataRecord, Module } from '../catalog/schema.ts';
import { plural, truncate } from '../project/text.ts';
import type { PlanRequest } from '../schema/plan.ts';
import type { Scope } from './scope.ts';

const KNOWLEDGE_LIMIT = 6000;
const OVERVIEW_SUMMARY_LIMIT = 300;
const OVERVIEW_RECORDS_PER_MODULE = 6;

function recordLine(record: DataRecord): string {
    return `- \`${record.id}\`${record.entity ? ` (${record.entity})` : ''}: ${truncate(record.description, 300)}`;
}

function entryPointLines(catalog: Catalog, module: Module, withPages: boolean): string[] {
    const paths = navigationPaths(catalog);
    const routes = catalog.routes.filter((route) => route.modules.includes(module.id));
    const navigation = routes.flatMap((route) =>
        (paths.get(route.name) ?? []).map((path) => `- Navigation "${path}" → route \`${route.name}\``)
    );
    const pages = withPages
        ? routes
              .filter((route) => 'page' === route.kind)
              .map(
                  (route) =>
                      `- Page \`${route.name}\`: ${route.path}${route.description ? ` — ${route.description}` : ''}`
              )
        : [];

    return [...navigation, ...pages];
}

function moduleData(catalog: Catalog, module: Module): DataRecord[] {
    return catalog.data.filter((record) => record.modules.includes(module.id));
}

function moduleDetail(catalog: Catalog, module: Module): string {
    const lines = [`## Module \`${module.id}\` — ${module.title}`, '', module.description];
    if (module.knowledge) {
        lines.push('', '### Good to know', truncate(module.knowledge, KNOWLEDGE_LIMIT));
    }
    lines.push('', '### Entry points', ...entryPointLines(catalog, module, true), '', '### Features and cases');
    for (const feature of module.features) {
        const cases = feature.cases.filter((item) => !item.obsolete);
        if (feature.cases.length > 0 && 0 === cases.length) {
            continue;
        }
        lines.push('', `#### \`${module.id}:${feature.id}\` — ${feature.title} [${feature.confidence}]`);
        if (feature.description) {
            lines.push(feature.description);
        }
        for (const item of cases) {
            lines.push(
                `- \`${module.id}:${item.id}\`${item.tags.length ? ` [${item.tags.join(', ')}]` : ''}: ${item.action} → ${item.expected}`
            );
        }
    }
    lines.push('', '### Demo data of the module', ...moduleData(catalog, module).map(recordLine));

    return lines.join('\n');
}

function moduleOverview(catalog: Catalog, module: Module): string {
    const features = module.features.filter(
        (feature) => 0 === feature.cases.length || feature.cases.some((item) => !item.obsolete)
    );

    return [
        `## Module \`${module.id}\` — ${module.title}`,
        truncate(module.description, OVERVIEW_SUMMARY_LIMIT),
        ...entryPointLines(catalog, module, false),
        ...features.map(
            (feature) =>
                `- \`${module.id}:${feature.id}\` ${feature.title} [${feature.confidence}, ${plural(feature.cases.filter((item) => !item.obsolete).length, 'case')}]`
        ),
        ...moduleData(catalog, module).slice(0, OVERVIEW_RECORDS_PER_MODULE).map(recordLine),
    ].join('\n');
}

/** What the writing agent reads before writing the plan: request, accounts, data, then the modules in scope. */
export function buildPlannerContext(catalog: Catalog, request: PlanRequest, scope: Scope): string {
    const deepDive = 'deep-dive' === request.mode;
    const shared = catalog.data.filter((record) => 0 === record.modules.length);
    const sections = [
        '# Request',
        `- Mode: ${request.mode}`,
        `- Audience: ${request.audience}`,
        `- Narration language: ${request.language}`,
        `- Target duration: ${request.targetDurationSeconds ? `${request.targetDurationSeconds} seconds` : 'free'}`,
        `- Requested modules: ${request.modules.length ? request.modules.join(', ') : 'all (overview)'}`,
        `- Brief: ${request.prompt ?? '(none, infer from the above)'}`,
        '',
    ];
    if (catalog.product) {
        sections.push(`# Product: ${catalog.product.name}`, catalog.product.description, '');
    }
    sections.push(
        `# Home page: ${catalog.homeRoute ? `route \`${catalog.homeRoute}\`` : '(none declared)'}`,
        '',
        '# Demo accounts',
        ...scope.accounts.map(
            (account) =>
                `- \`${account.id}\`: ${account.description}${account.permissions.length ? ` (permissions: ${account.permissions.join(', ')})` : ''}`
        ),
        '',
        '# Demo data shared by all modules',
        ...shared.map(recordLine),
        '',
        '# Catalog',
        ...scope.modules.map((module) => (deepDive ? moduleDetail(catalog, module) : moduleOverview(catalog, module)))
    );

    return sections.join('\n');
}
