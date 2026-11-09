import { z } from 'zod';

/**
 * An element of the page, from the most robust designation to the most brittle: role and accessible
 * name, field label, text, placeholder, test attribute, then CSS as a last resort.
 */
export interface Target {
    role?: string;
    name?: string;
    label?: string;
    text?: string;
    placeholder?: string;
    testId?: string;
    css?: string;
    exact?: boolean;
    nth?: number;
    within?: Target;
}

const LOCATOR_KEYS = ['role', 'label', 'text', 'placeholder', 'testId', 'css'] as const;

export const TargetSchema: z.ZodType<Target> = z.lazy(() =>
    z
        .object({
            role: z.string().optional(),
            name: z.string().optional(),
            label: z.string().optional(),
            text: z.string().optional(),
            placeholder: z.string().optional(),
            testId: z.string().optional(),
            css: z.string().optional(),
            exact: z.boolean().optional(),
            nth: z.number().int().min(0).optional(),
            within: TargetSchema.optional(),
        })
        .strict()
        .refine((target) => 1 === LOCATOR_KEYS.filter((key) => undefined !== target[key]).length, {
            message: `a target designates the element by exactly one of these keys: ${LOCATOR_KEYS.join(', ')}`,
        })
);

export const LookupRefSchema = z.object({ lookup: z.string() }).strict();
export type LookupRef = z.infer<typeof LookupRefSchema>;

/** A date counted from the day of the run: a reference demo does not depend on the day it is replayed. */
export const RelativeDateSchema = z
    .object({
        daysFromToday: z.number().int(),
        // Tokens dd, MM and yyyy: the field's format in the demo's language.
        format: z.string().default('yyyy-MM-dd'),
    })
    .strict();
export type RelativeDate = z.infer<typeof RelativeDateSchema>;

const StepBase = {
    id: z.string(),
    // Passage of the narration the gesture must coincide with on screen.
    anchor: z.string().optional(),
    note: z.string().optional(),
};

export const ActionSchema = z.discriminatedUnion('action', [
    z
        .object({
            ...StepBase,
            action: z.literal('goto'),
            route: z.string(),
            params: z.record(z.string(), z.union([z.string(), z.number(), LookupRefSchema])).optional(),
            query: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    z.object({ ...StepBase, action: z.literal('click'), target: TargetSchema }).strict(),
    z
        .object({
            ...StepBase,
            action: z.literal('fill'),
            target: TargetSchema,
            value: z.union([z.string(), RelativeDateSchema]),
        })
        .strict(),
    z.object({ ...StepBase, action: z.literal('select'), target: TargetSchema, option: z.string() }).strict(),
    z
        .object({
            ...StepBase,
            action: z.literal('select2'),
            target: TargetSchema,
            search: z.string(),
            option: z.string(),
        })
        .strict(),
    z.object({ ...StepBase, action: z.literal('check'), target: TargetSchema }).strict(),
    z.object({ ...StepBase, action: z.literal('press'), key: z.string(), target: TargetSchema.optional() }).strict(),
    z
        .object({
            ...StepBase,
            action: z.literal('waitFor'),
            target: TargetSchema,
            state: z.enum(['visible', 'hidden']).optional(),
        })
        .strict(),
    z.object({ ...StepBase, action: z.literal('expectVisible'), target: TargetSchema }).strict(),
    z.object({ ...StepBase, action: z.literal('expectText'), target: TargetSchema, text: z.string() }).strict(),
    z.object({ ...StepBase, action: z.literal('scrollTo'), target: TargetSchema }).strict(),
    // Reading time left to the viewer, never to wait for the application.
    z.object({ ...StepBase, action: z.literal('hold'), ms: z.number().int().positive().max(5000) }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['action'];

export const ScenarioSceneSchema = z
    .object({
        id: z.string(),
        account: z.string(),
        steps: z.array(ActionSchema).min(1),
    })
    .strict();
export type ScenarioScene = z.infer<typeof ScenarioSceneSchema>;

/** Data designated by criteria, never by a hard-coded id: the `resolve` command finds its id in the running app. */
export const LookupSchema = z
    .object({
        entity: z.string(),
        where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        dataRecord: z.string().optional(),
        description: z.string().optional(),
    })
    .strict();
export type Lookup = z.infer<typeof LookupSchema>;

export const ScenarioSchema = z
    .object({
        scenarioVersion: z.literal(1),
        lookups: z.record(z.string(), LookupSchema),
        // Empty when every scene of the plan is an excerpt of another demo.
        scenes: z.array(ScenarioSceneSchema),
    })
    .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Ids found for each lookup: exactly one is required to play; zero or several are reported. */
export type Resolved = Record<string, (string | number)[]>;

export const StepLogSchema = z.object({
    scene: z.string(),
    step: z.string(),
    action: z.string(),
    status: z.enum(['passed', 'failed']),
    startMs: z.number(),
    endMs: z.number(),
    url: z.string(),
    box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
    // When the gesture lands, element measured and brought on screen: the frame the edit freezes on.
    actionMs: z.number().nullable().default(null),
    anchor: z.string().nullable(),
    error: z.string().nullable(),
});
export type StepLog = z.infer<typeof StepLogSchema>;

export const ExecutionSchema = z.object({
    mode: z.enum(['dry-run', 'record']),
    status: z.enum(['passed', 'failed']),
    startedAt: z.string(),
    finishedAt: z.string(),
    baseUrl: z.string(),
    browser: z.string(),
    steps: z.array(StepLogSchema),
    // External origins the run refused: a screen depending on them may look incomplete.
    blockedOrigins: z.array(z.string()),
    failure: z
        .object({
            scene: z.string(),
            step: z.string(),
            error: z.string(),
            screenshot: z.string(),
            dom: z.string(),
            trace: z.string(),
            console: z.array(z.string()),
        })
        .nullable(),
});
export type Execution = z.infer<typeof ExecutionSchema>;
