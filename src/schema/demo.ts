import { z } from 'zod';
import { DemoModeSchema } from './plan.ts';
import { TRACKS } from './video.ts';

export const DEMO_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A demo's manifest (`demo.yaml`): what it is, for whom, on which scope. */
export const DemoManifestSchema = z
    .object({
        id: z.string().regex(DEMO_ID, 'lowercase letters, digits and dashes: "team-onboarding"'),
        title: z.string().min(1),
        description: z.string().min(1),
        // `draft`: being written; `reference`: kept in step with the code and enforced by `check`.
        status: z.enum(['draft', 'reference']),
        audience: z.string(),
        language: z.string(),
        mode: DemoModeSchema,
        modules: z.array(z.string()),
        prompt: z.string().nullable(),
        targetDurationSeconds: z.number().int().positive().nullable(),
    })
    .strict();
export type DemoManifest = z.infer<typeof DemoManifestSchema>;

/**
 * What the tools observed on their last pass (`demo.lock.json`), written by them only: the catalog version the
 * demo was validated and played against, and the video produced from it. Versioned: it holds only what changes
 * the result, not the time or commit of a mere check.
 */
export const DemoLockSchema = z.object({
    validation: z.object({ catalogVersion: z.string() }).nullable().default(null),
    dryRun: z
        .object({
            status: z.enum(['passed', 'failed']),
            steps: z.string(),
            catalogVersion: z.string().nullable().default(null),
        })
        .nullable()
        .default(null),
    narration: z
        .object({
            voiceId: z.string(),
            modelId: z.string(),
            settings: z.record(z.string(), z.number()),
            sentences: z.number(),
            durationMs: z.number(),
            at: z.string(),
        })
        .nullable()
        .default(null),
    video: z
        .object({
            durationMs: z.number(),
            sha256: z.string(),
            gitCommit: z.string().nullable(),
            gitDirty: z.boolean().nullable().default(null),
            tracks: z.array(z.enum(TRACKS)).default(['voice']),
            at: z.string(),
            // Where the video is published, filled in by hand.
            url: z.string().nullable(),
        })
        .nullable()
        .default(null),
});
export type DemoLock = z.infer<typeof DemoLockSchema>;
