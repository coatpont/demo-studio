import { z } from 'zod';
import type { GitInfo } from '../project/git.ts';

/**
 * verified: described and confirmed by a recorded test pass (manual or automated).
 * documented: described by the product's documentation or test plans, without a recorded pass.
 * inferred: deduced from the code alone (a route, a menu entry), without a functional description.
 */
export const ConfidenceSchema = z.enum(['verified', 'documented', 'inferred']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const RouteKindSchema = z.enum(['page', 'api', 'action']);
export type RouteKind = z.infer<typeof RouteKindSchema>;

// No ':' — the plan cites `<module>:<feature>` and `<module>:<case>`.
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const localId = (what: string) =>
    z.string().regex(LOCAL_ID, `${what}: letters, digits, '.', '_' or '-', starting with a letter or digit`);

const CaseInputSchema = z
    .object({
        id: localId('case id'),
        action: z.string().min(1),
        expected: z.string().min(1),
        tags: z.array(z.string()).default([]),
        // Kept so that its id is never reused with another meaning; never offered to the plan.
        obsolete: z.boolean().default(false),
    })
    .strict();

const FeatureInputSchema = z
    .object({
        id: localId('feature id'),
        title: z.string().min(1),
        description: z.string().default(''),
        confidence: ConfidenceSchema,
        cases: z.array(CaseInputSchema).default([]),
    })
    .strict();

const ModuleInputSchema = z
    .object({
        id: localId('module id'),
        title: z.string().min(1),
        description: z.string().default(''),
        // What the writing agent must know before showing the module: rules, pitfalls, vocabulary.
        knowledge: z.string().default(''),
        features: z.array(FeatureInputSchema).default([]),
    })
    .strict();

const RouteInputSchema = z
    .object({
        name: z.string().min(1),
        // `{id}` required, `{id?}` optional, `{path*}` spans several segments.
        path: z.string().startsWith('/'),
        kind: RouteKindSchema.default('page'),
        module: z.union([z.string(), z.array(z.string())]).optional(),
        description: z.string().default(''),
    })
    .strict();

const NavigationInputSchema = z
    .object({
        path: z.string().min(1),
        route: z.string().min(1),
    })
    .strict();

const AccountInputSchema = z
    .object({
        id: z.string().min(1),
        description: z.string().min(1),
        permissions: z.array(z.string()).default([]),
    })
    .strict();

const DataInputSchema = z
    .object({
        id: z.string().min(1),
        description: z.string().min(1),
        entity: z.string().optional(),
        modules: z.array(z.string()).default([]),
    })
    .strict();

export const CatalogInputSchema = z
    .object({
        product: z
            .object({ name: z.string().min(1), description: z.string().default('') })
            .strict()
            .optional(),
        // The page a scene starts from, so that the viewer sees the way to each screen.
        homeRoute: z.string().nullable().default(null),
        modules: z.array(ModuleInputSchema).min(1),
        routes: z.array(RouteInputSchema).default([]),
        navigation: z.array(NavigationInputSchema).default([]),
        accounts: z.array(AccountInputSchema).default([]),
        data: z.array(DataInputSchema).default([]),
    })
    .strict();
export type CatalogInput = z.infer<typeof CatalogInputSchema>;

export type Case = z.infer<typeof CaseInputSchema>;
export type Feature = z.infer<typeof FeatureInputSchema>;
export type Module = z.infer<typeof ModuleInputSchema>;
export type NavigationEntry = z.infer<typeof NavigationInputSchema>;
export type Account = z.infer<typeof AccountInputSchema>;

export interface Route {
    name: string;
    // Template with every parameter written `{name}`, markers removed.
    path: string;
    kind: RouteKind;
    modules: string[];
    parameters: string[];
    optionalParameters: string[];
    catchAllParameters: string[];
    description: string;
}

export interface DataRecord {
    id: string;
    description: string;
    entity: string | null;
    modules: string[];
}

export interface Catalog {
    // Content hash: it changes only when the catalog changes.
    catalogVersion: string;
    git: GitInfo;
    product: { name: string; description: string } | null;
    homeRoute: string | null;
    modules: Module[];
    routes: Route[];
    navigation: NavigationEntry[];
    accounts: Account[];
    data: DataRecord[];
}
