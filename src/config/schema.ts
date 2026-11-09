import type { Page } from 'playwright-core';
import { z } from 'zod';
import { TargetSchema } from '../schema/scenario.ts';

/** A literal, an environment variable (read from the environment, `.env.local` or `.env`), or a value of the account. */
export const ValueSourceSchema = z.union([
    z.string(),
    z.object({ env: z.string().min(1) }).strict(),
    z.object({ account: z.string().min(1) }).strict(),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

export const AccountValueSchema = z.union([z.string(), z.object({ env: z.string().min(1) }).strict()]);
export type AccountValue = z.infer<typeof AccountValueSchema>;

/** A preparation after logging in (terms to accept, language to set); `optional` skips it when its element is absent. */
export const LoginStepSchema = z.union([
    // `{language}` is replaced by the demo's language.
    z.object({ goto: z.string().startsWith('/') }).strict(),
    z.object({ click: TargetSchema, optional: z.boolean().default(false) }).strict(),
    z.object({ check: TargetSchema, optional: z.boolean().default(false) }).strict(),
    z.object({ fill: TargetSchema, value: ValueSourceSchema, optional: z.boolean().default(false) }).strict(),
]);
export type LoginStep = z.infer<typeof LoginStepSchema>;

export const DeclarativeLoginSchema = z
    .object({
        url: z.string().startsWith('/'),
        fields: z.array(z.object({ target: TargetSchema, value: ValueSourceSchema }).strict()).min(1),
        submit: TargetSchema,
        // Without `url` nor `visible`, success means having left the login page.
        success: z
            .object({ url: z.string().startsWith('/').optional(), visible: TargetSchema.optional() })
            .strict()
            .default({}),
        after: z.array(LoginStepSchema).default([]),
    })
    .strict();
export type DeclarativeLogin = z.infer<typeof DeclarativeLoginSchema>;

export interface LoginContext {
    baseUrl: string;
    language: string;
    timeoutMs: number;
    /** A value of the account (`values`), environment variables resolved; throws if it is missing. */
    value: (key: string) => string;
    /** An environment variable, from the environment, `.env.local` or `.env`; throws if it is missing. */
    env: (name: string) => string;
}

export interface LoginAccount {
    id: string;
    description?: string;
}

export type LoginFunction = (page: Page, account: LoginAccount, context: LoginContext) => Promise<void>;

export const LoginSchema = z.union([
    // A visitor who does not log in: public pages.
    z.literal('none'),
    DeclarativeLoginSchema,
    z.custom<LoginFunction>((value) => 'function' === typeof value, 'a login(page, account, context) function'),
]);
export type Login = z.infer<typeof LoginSchema>;

export const AccountConfigSchema = z
    .object({
        id: z.string().min(1),
        description: z.string().optional(),
        values: z.record(z.string(), AccountValueSchema).default({}),
        // Overrides the default `login` of the config.
        login: LoginSchema.optional(),
    })
    .strict();
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

const LookupValueSchema = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.null()]);

export const ResolveSchema = z.union([
    // Receives the lookups as JSON on stdin, prints `{ "<key>": <id> | [<ids>] }` on stdout.
    z.object({ command: z.string().min(1), timeoutMs: z.number().int().positive().default(60000) }).strict(),
    // No backend: each lookup's id written here.
    z.object({ values: z.record(z.string(), LookupValueSchema) }).strict(),
]);
export type ResolveConfig = z.infer<typeof ResolveSchema>;

const VoiceSettingsSchema = z
    .object({
        stability: z.number().min(0).max(1).optional(),
        similarity_boost: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
        speed: z.number().min(0.7).max(1.2).optional(),
    })
    .strict();
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export const PronunciationSchema = z
    .object({
        // Regular expression source, matched on the written text.
        written: z.string().min(1),
        flags: z.string().default('gi'),
        spoken: z.string().min(1),
    })
    .strict();
export type Pronunciation = z.infer<typeof PronunciationSchema>;

export const ConfigSchema = z
    .object({
        baseUrl: z.url(),
        // A demo never runs against production: only these hosts are accepted (`*.` matches any subdomain).
        allowedHosts: z.array(z.string()).default(['localhost', '127.0.0.1', '*.localhost', '*.test']),
        // Every other external request is blocked: no chat widget nor analytics in a demo.
        allowedExternalHosts: z.array(z.string()).default(['fonts.googleapis.com', 'fonts.gstatic.com']),
        demosDir: z.string().default('demos'),
        workDir: z.string().default('.demo-studio'),
        catalog: z.string().default('catalog.yaml'),
        defaultLanguage: z.string().default('en'),
        defaultAudience: z.string().default('people discovering the product'),
        browser: z
            .object({
                viewport: z
                    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
                    .default({ width: 1920, height: 1080 }),
                timezone: z.string().default('UTC'),
                testIdAttribute: z.string().default('data-testid'),
                timeoutMs: z.number().int().positive().default(10000),
                chromePath: z.string().nullable().default(null),
                // Hidden on every page: debug toolbars, cookie banners, environment ribbons.
                hideSelectors: z.array(z.string()).default([]),
            })
            .strict()
            .prefault({}),
        login: LoginSchema.optional(),
        accounts: z.array(AccountConfigSchema).default([]),
        resolve: ResolveSchema.optional(),
        // Restores the demo data; erases what is in the app, so it runs only with DEMO_RESET_CONFIRM=1.
        reset: z
            .object({ command: z.string().min(1) })
            .strict()
            .optional(),
        branding: z
            .object({
                productName: z.string().nullable().default(null),
                logo: z.string().nullable().default(null),
                primaryColor: z.string().default('#2563eb'),
                inkColor: z.string().default('#111827'),
                backgroundColor: z.string().default('#ffffff'),
                fontFamily: z.string().default('Inter, "Helvetica Neue", Arial, sans-serif'),
                fontUrl: z.string().nullable().default(null),
            })
            .strict()
            .prefault({}),
        narration: z
            .object({
                provider: z.enum(['elevenlabs', 'text']).default('elevenlabs'),
                modelId: z.string().default('eleven_v4'),
                apiKeyEnv: z.string().default('ELEVENLABS_API_KEY'),
                // `<voiceIdEnv>_<LANGUAGE>` (ELEVENLABS_VOICE_ID_FR) wins over the common voice.
                voiceIdEnv: z.string().default('ELEVENLABS_VOICE_ID'),
                voiceSettings: VoiceSettingsSchema.default({}),
                // Per narration language: words the voice reads by the general rule of the language although usage differs.
                pronunciations: z.record(z.string(), z.array(PronunciationSchema)).default({}),
            })
            .strict()
            .prefault({}),
    })
    .strict();

export type DemoStudioConfigInput = z.input<typeof ConfigSchema>;
export type DemoStudioConfig = z.output<typeof ConfigSchema>;
