import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Catalog } from '../catalog/schema.ts';
import { PlannerOutputSchema, type DemoPlan, type PlannerOutput, type PlanRequest } from '../schema/plan.ts';
import { buildCoverage } from './coverage.ts';
import { buildScope } from './scope.ts';
import { validatePlan } from './validate.ts';

export interface PlanCheck {
    errors: string[];
    warnings: string[];
    plan: DemoPlan | null;
}

/** JSON schema of the plan draft, for whoever writes it. */
export function plannerOutputJsonSchema(): Record<string, unknown> {
    return z.toJSONSchema(PlannerOutputSchema) as Record<string, unknown>;
}

function parse(text: string): { output: PlannerOutput | null; errors: string[] } {
    let json: unknown;
    try {
        json = parseYaml(text);
    } catch (error) {
        return { output: null, errors: [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const result = PlannerOutputSchema.safeParse(json);

    return result.success
        ? { output: result.data, errors: [] }
        : { output: null, errors: [z.prettifyError(result.error)] };
}

/** Checks a plan (YAML, or JSON which is a subset of it) against the catalog and, if it passes, makes it a `DemoPlan` with its coverage. */
export function checkPlan(text: string, catalog: Catalog, request: PlanRequest): PlanCheck {
    const { output, errors } = parse(text);
    if (!output) {
        return { errors, warnings: [], plan: null };
    }
    const scope = buildScope(catalog, request);
    const validation = validatePlan(output, catalog, request, scope);
    if (validation.errors.length > 0) {
        return { ...validation, plan: null };
    }

    return {
        ...validation,
        plan: {
            ...output,
            planVersion: 1,
            mode: request.mode,
            request,
            catalogVersion: catalog.catalogVersion,
            gitCommit: catalog.git.commit,
            estimatedDurationSeconds: output.scenes.reduce((sum, scene) => sum + scene.estimatedDurationSeconds, 0),
            coverage: buildCoverage(output, scope, validation.warnings),
        },
    };
}
