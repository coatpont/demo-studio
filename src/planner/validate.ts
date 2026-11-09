import type { Catalog } from '../catalog/schema.ts';
import type { PlannerOutput, PlanRequest } from '../schema/plan.ts';
import type { Scope } from './scope.ts';

// About twenty seconds of voice.
const INTRODUCTION_MAX_WORDS = 50;

export interface PlanValidation {
    errors: string[];
    warnings: string[];
}

/** Every id the plan cites must exist in the catalog and in the requested scope. */
export function validatePlan(
    plan: PlannerOutput,
    catalog: Catalog,
    request: PlanRequest,
    scope: Scope
): PlanValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const features = new Map(scope.features.map((feature) => [feature.id, feature]));
    const routes = new Map(catalog.routes.map((route) => [route.name, route]));
    const records = new Set(catalog.data.map((record) => record.id));
    const accounts = new Set(scope.accounts.map((account) => account.id));

    if (0 === plan.scenes.length) {
        errors.push('The plan has no scene.');
    }
    const introductionWords = plan.introduction.trim().split(/\s+/).length;
    if ('' === plan.introduction.trim()) {
        errors.push('The introduction is empty: it is read on the title card.');
    } else if (introductionWords > INTRODUCTION_MAX_WORDS) {
        warnings.push(
            `Introduction of ${introductionWords} words: beyond ${INTRODUCTION_MAX_WORDS}, the title card drags on.`
        );
    }
    if (plan.language !== request.language) {
        errors.push(`Language "${plan.language}" instead of "${request.language}".`);
    }
    const sceneIds = new Set<string>();
    for (const scene of plan.scenes) {
        const where = `Scene ${scene.id}`;
        if (sceneIds.has(scene.id)) {
            errors.push(`${where}: duplicate scene id.`);
        }
        sceneIds.add(scene.id);
        if (0 === scene.featureIds.length) {
            errors.push(`${where}: no feature cited.`);
        }
        const sceneFeatures = scene.featureIds.map((id) => {
            const feature = features.get(id);
            if (!feature) {
                errors.push(`${where}: feature "${id}" is not in the catalog or outside the requested scope.`);
            }

            return feature;
        });
        const caseIds = new Set(
            sceneFeatures.flatMap((feature) => feature?.cases.map((item) => `${feature.moduleId}:${item.id}`) ?? [])
        );
        for (const caseId of scene.caseIds) {
            if (!caseIds.has(caseId)) {
                errors.push(`${where}: case "${caseId}" is unknown or belongs to none of the scene's features.`);
            }
        }
        if (null !== scene.entryRouteName) {
            const route = routes.get(scene.entryRouteName);
            if (!route) {
                errors.push(`${where}: route "${scene.entryRouteName}" is not in the catalog.`);
            } else if ('page' !== route.kind) {
                errors.push(`${where}: route "${scene.entryRouteName}" is not a page (${route.kind}).`);
            } else if (!sceneFeatures.some((feature) => feature?.routeNames.includes(route.name))) {
                errors.push(`${where}: route "${scene.entryRouteName}" belongs to none of the scene's modules.`);
            }
        }
        if (!accounts.has(scene.account)) {
            errors.push(`${where}: account "${scene.account}" is not in the catalog.`);
        }
        for (const record of scene.dataRecords) {
            if (!records.has(record)) {
                errors.push(`${where}: unknown data record "${record}".`);
            }
        }
        if (scene.estimatedDurationSeconds <= 0) {
            errors.push(`${where}: estimated duration is zero or negative.`);
        }
        if (sceneFeatures.some((feature) => 'inferred' === feature?.confidence)) {
            warnings.push(`${where}: shows a feature only inferred from the code, without a documented case.`);
        }
    }
    const included = new Set(plan.scenes.flatMap((scene) => scene.featureIds));
    for (const excluded of plan.excludedFeatures) {
        if (!features.has(excluded.featureId)) {
            errors.push(`Exclusion: feature "${excluded.featureId}" is outside the scope.`);
        } else if (included.has(excluded.featureId)) {
            warnings.push(`"${excluded.featureId}" is both shown and excluded: it counts as shown.`);
        }
    }
    const total = plan.scenes.reduce((sum, scene) => sum + scene.estimatedDurationSeconds, 0);
    if (
        request.targetDurationSeconds &&
        Math.abs(total - request.targetDurationSeconds) > request.targetDurationSeconds * 0.25
    ) {
        warnings.push(`Estimated duration ${Math.round(total)} s for a target of ${request.targetDurationSeconds} s.`);
    }

    return { errors, warnings };
}
