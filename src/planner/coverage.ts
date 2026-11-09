import type { CoverageEntry, CoverageReport, PlannerOutput } from '../schema/plan.ts';
import type { Scope } from './scope.ts';

export function buildCoverage(plan: PlannerOutput, scope: Scope, warnings: string[]): CoverageReport {
    const reasons = new Map(plan.excludedFeatures.map((excluded) => [excluded.featureId, excluded.reason]));
    const features: CoverageEntry[] = scope.features.map((feature) => {
        const scenes = plan.scenes.filter((scene) => scene.featureIds.includes(feature.id));
        const prefix = `${feature.moduleId}:`;
        const caseIds = [
            ...new Set(
                scenes.flatMap((scene) =>
                    scene.caseIds.filter((id) => feature.cases.some((item) => `${prefix}${item.id}` === id))
                )
            ),
        ];

        return {
            featureId: feature.id,
            title: feature.title,
            confidence: feature.confidence,
            status: scenes.length > 0 ? 'included' : 'excluded',
            scenes: scenes.map((scene) => scene.id),
            caseIds,
            reason: scenes.length > 0 ? null : (reasons.get(feature.id) ?? 'not selected, no reason given'),
        };
    });
    const included = features.filter((entry) => 'included' === entry.status);
    const allWarnings = [...warnings];
    for (const entry of included.filter((item) => 'verified' !== item.confidence)) {
        allWarnings.push(`"${entry.featureId}" is shown without a recorded test pass (${entry.confidence}).`);
    }

    return {
        scope: [...new Set(scope.features.map((feature) => feature.moduleId))],
        features,
        unsupported: plan.unsupportedRequests,
        dataGaps: plan.scenes.flatMap((scene) => scene.dataGaps.map((gap) => ({ scene: scene.id, gap }))),
        warnings: allWarnings,
        summary: {
            featuresInScope: features.length,
            featuresIncluded: included.length,
            casesInScope: scope.features.reduce((sum, feature) => sum + feature.cases.length, 0),
            casesIncluded: included.reduce((sum, entry) => sum + entry.caseIds.length, 0),
        },
    };
}

export function coverageMarkdown(title: string, coverage: CoverageReport): string {
    const { summary } = coverage;
    const cell = (text: string): string => text.replace(/\|/g, '\\|');
    const lines = [
        `# Feature coverage — ${title}`,
        '',
        `Features shown: ${summary.featuresIncluded} of ${summary.featuresInScope}. ` +
            `Cases covered: ${summary.casesIncluded} of ${summary.casesInScope}.`,
        '',
        '| Feature | Confidence | Status | Scenes | Cases | Reason |',
        '|---|---|---|---|---|---|',
        ...coverage.features.map(
            (entry) =>
                `| \`${entry.featureId}\` ${cell(entry.title)} | ${entry.confidence} | ${entry.status} | ` +
                `${entry.scenes.join(', ')} | ${entry.caseIds.join(', ')} | ${cell(entry.reason ?? '')} |`
        ),
    ];
    if (coverage.unsupported.length > 0) {
        lines.push(
            '',
            '## Unsupported requests',
            '',
            ...coverage.unsupported.map((item) => `- ${item.request}: ${item.reason}`)
        );
    }
    if (coverage.dataGaps.length > 0) {
        lines.push('', '## Missing demo data', '', ...coverage.dataGaps.map((item) => `- ${item.scene}: ${item.gap}`));
    }
    if (coverage.warnings.length > 0) {
        lines.push('', '## Warnings', '', ...coverage.warnings.map((warning) => `- ${warning}`));
    }

    return lines.join('\n');
}
