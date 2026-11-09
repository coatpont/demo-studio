import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConfigSchema, type DemoStudioConfig } from './schema.ts';

export const CONFIG_FILES = [
    'demo-studio.config.ts',
    'demo-studio.config.mts',
    'demo-studio.config.mjs',
    'demo-studio.config.js',
    'demo-studio.config.json',
];

export interface ProjectPaths {
    root: string;
    configFile: string;
    demos: string;
    work: string;
    catalog: string;
    cache: string;
}

export interface Project {
    config: DemoStudioConfig;
    paths: ProjectPaths;
}

/** The first config file found from `cwd` upwards: its directory is the project root. */
export function findConfigFile(cwd: string = process.cwd()): string {
    let directory = resolve(cwd);
    for (;;) {
        const found = CONFIG_FILES.map((name) => join(directory, name)).find((path) => existsSync(path));
        if (found) {
            return found;
        }
        const parent = resolve(directory, '..');
        if (parent === directory) {
            throw new Error(
                `No ${CONFIG_FILES.join(', ')} found from ${cwd}: create one at the project root, or pass --config <path>.`
            );
        }
        directory = parent;
    }
}

export function parseConfig(raw: unknown, file: string): DemoStudioConfig {
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`Invalid config ${file}:\n${z.prettifyError(parsed.error)}`);
    }

    return parsed.data;
}

export function projectPaths(config: DemoStudioConfig, configFile: string): ProjectPaths {
    const root = dirname(configFile);
    const at = (path: string): string => (isAbsolute(path) ? path : join(root, path));
    const work = at(config.workDir);

    return {
        root,
        configFile,
        demos: at(config.demosDir),
        work,
        catalog: at(config.catalog),
        cache: join(work, 'cache'),
    };
}

export async function loadProject(configPath?: string, cwd: string = process.cwd()): Promise<Project> {
    const file = configPath ? resolve(cwd, configPath) : findConfigFile(cwd);
    if (!existsSync(file)) {
        throw new Error(`Config ${file} not found.`);
    }
    let raw: unknown;
    if (file.endsWith('.json')) {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } else {
        const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
        raw = module.default;
    }
    const config = parseConfig(raw, file);
    const baseUrl = process.env.DEMO_STUDIO_BASE_URL;

    return {
        config: baseUrl ? { ...config, baseUrl } : config,
        paths: projectPaths(config, file),
    };
}
