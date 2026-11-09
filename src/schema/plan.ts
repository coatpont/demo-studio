import { z } from 'zod';
import { ConfidenceSchema } from '../catalog/schema.ts';

export const DemoModeSchema = z.enum(['overview', 'deep-dive']);
export type DemoMode = z.infer<typeof DemoModeSchema>;

export const PlanRequestSchema = z.object({
    prompt: z.string().nullable(),
    modules: z.array(z.string()),
    mode: DemoModeSchema,
    audience: z.string(),
    language: z.string(),
    targetDurationSeconds: z.number().int().positive().nullable(),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

/** The written draft. No optional field: an absence is written `null`, so that an omission differs from a choice. */
export const PlanSceneSchema = z.object({
    id: z.string(),
    title: z.string(),
    featureIds: z.array(z.string()),
    caseIds: z.array(z.string()),
    entryRouteName: z.string().nullable(),
    account: z.string(),
    dataRecords: z.array(z.string()),
    dataRequirements: z.array(z.string()),
    dataGaps: z.array(z.string()),
    narrative: z.string(),
    userActions: z.array(z.string()),
    expectedOutcome: z.string(),
    estimatedDurationSeconds: z.number(),
    // A scene reused from another demo already rendered (its frames, its cursor) under its own narration; nothing to record.
    excerpt: z.object({ demo: z.string(), scene: z.string() }).strict().nullable().default(null),
});
export type PlanScene = z.infer<typeof PlanSceneSchema>;

export const PlannerOutputSchema = z.object({
    title: z.string(),
    objectives: z.array(z.string()),
    audience: z.string(),
    language: z.string(),
    storyline: z.string(),
    // Welcome read on the title card: what the demo is, for whom, and that the data shown is fictional.
    introduction: z.string(),
    scenes: z.array(PlanSceneSchema),
    excludedFeatures: z.array(z.object({ featureId: z.string(), reason: z.string() })),
    unsupportedRequests: z.array(z.object({ request: z.string(), reason: z.string() })),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const CoverageEntrySchema = z.object({
    featureId: z.string(),
    title: z.string(),
    confidence: ConfidenceSchema,
    status: z.enum(['included', 'excluded']),
    scenes: z.array(z.string()),
    caseIds: z.array(z.string()),
    reason: z.string().nullable(),
});
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

export const CoverageReportSchema = z.object({
    scope: z.array(z.string()),
    features: z.array(CoverageEntrySchema),
    unsupported: z.array(z.object({ request: z.string(), reason: z.string() })),
    dataGaps: z.array(z.object({ scene: z.string(), gap: z.string() })),
    warnings: z.array(z.string()),
    summary: z.object({
        featuresInScope: z.number(),
        featuresIncluded: z.number(),
        casesInScope: z.number(),
        casesIncluded: z.number(),
    }),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

export const DemoPlanSchema = PlannerOutputSchema.extend({
    planVersion: z.literal(1),
    mode: DemoModeSchema,
    request: PlanRequestSchema,
    catalogVersion: z.string(),
    gitCommit: z.string().nullable(),
    estimatedDurationSeconds: z.number(),
    coverage: CoverageReportSchema,
});
export type DemoPlan = z.infer<typeof DemoPlanSchema>;
