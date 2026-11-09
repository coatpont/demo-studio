import type { DemoStudioConfigInput } from './config/schema.ts';

/** Typing helper for `demo-studio.config.ts`; the object is returned unchanged. */
export function defineConfig(config: DemoStudioConfigInput): DemoStudioConfigInput {
    return config;
}

export type {
    AccountConfig,
    DeclarativeLogin,
    DemoStudioConfig,
    DemoStudioConfigInput,
    LoginAccount,
    LoginContext,
    LoginFunction,
    LoginStep,
    ValueSource,
} from './config/schema.ts';
export type { Catalog, CatalogInput } from './catalog/schema.ts';
export type { Scenario, Target } from './schema/scenario.ts';
export type { PlannerOutput } from './schema/plan.ts';
