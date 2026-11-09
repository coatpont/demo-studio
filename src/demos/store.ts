import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { DEMO_ID, DemoLockSchema, DemoManifestSchema, type DemoLock, type DemoManifest } from '../schema/demo.ts';
import type { PlanRequest } from '../schema/plan.ts';

export const MANIFEST_FILE = 'demo.yaml';
export const PLAN_FILE = 'plan.yaml';
export const SCENARIO_FILE = 'scenario.yaml';
export const LOCK_FILE = 'demo.lock.json';

export function assertDemoId(id: string): void {
    if (!DEMO_ID.test(id)) {
        throw new Error(`Invalid demo id "${id}": lowercase letters, digits and dashes.`);
    }
}

/** Sources are versioned and reviewed (`demosDir/<id>/`); the work directory is regenerated from them. */
export class DemoStore {
    private readonly demosDir: string;
    private readonly workRoot: string;

    constructor(demosDir: string, workRoot: string) {
        this.demosDir = demosDir;
        this.workRoot = workRoot;
    }

    sourceDir(id: string): string {
        return join(this.demosDir, id);
    }

    /** Created on demand; holds the frozen catalog, validated plan, frames, voice and video. */
    workDir(id: string): string {
        const directory = join(this.workRoot, 'demos', id);
        mkdirSync(directory, { recursive: true });

        return directory;
    }

    exists(id: string): boolean {
        return existsSync(join(this.sourceDir(id), MANIFEST_FILE));
    }

    ids(): string[] {
        if (!existsSync(this.demosDir)) {
            return [];
        }

        return readdirSync(this.demosDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(join(this.demosDir, entry.name, MANIFEST_FILE)))
            .map((entry) => entry.name)
            .sort();
    }

    manifest(id: string): DemoManifest {
        assertDemoId(id);
        const path = join(this.sourceDir(id), MANIFEST_FILE);
        if (!existsSync(path)) {
            const known = this.ids();
            throw new Error(
                `Demo "${id}" not found in ${this.demosDir}.${known.length > 0 ? ` Known demos: ${known.join(', ')}.` : ''}`
            );
        }
        const manifest = DemoManifestSchema.parse(parse(readFileSync(path, 'utf8')));
        if (manifest.id !== id) {
            throw new Error(`${id}/${MANIFEST_FILE} declares the id "${manifest.id}": they must be equal.`);
        }

        return manifest;
    }

    createManifest(manifest: DemoManifest): void {
        mkdirSync(this.sourceDir(manifest.id), { recursive: true });
        writeFileSync(join(this.sourceDir(manifest.id), MANIFEST_FILE), stringify(manifest, { lineWidth: 120 }));
    }

    /** A source's text (`plan.yaml`, `scenario.yaml`), or null if it is not written yet. */
    source(id: string, file: string): string | null {
        const path = join(this.sourceDir(id), file);

        return existsSync(path) ? readFileSync(path, 'utf8') : null;
    }

    lock(id: string): DemoLock {
        const path = join(this.sourceDir(id), LOCK_FILE);

        return DemoLockSchema.parse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
    }

    /** A section is replaced only if it changes by more than its timestamp: a mere check does not dirty the repository. */
    updateLock(id: string, changes: Partial<DemoLock>): void {
        const path = join(this.sourceDir(id), LOCK_FILE);
        const current = this.lock(id);
        const withoutTime = (section: unknown): string =>
            JSON.stringify(section, (key, value: unknown) => ('at' === key ? undefined : value));
        const next = { ...current };
        for (const key of Object.keys(changes) as (keyof DemoLock)[]) {
            if (withoutTime(current[key]) !== withoutTime(changes[key])) {
                Object.assign(next, { [key]: changes[key] });
            }
        }
        const text = `${JSON.stringify(next, null, 2)}\n`;
        if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
            writeFileSync(path, text);
        }
    }
}

export function requestOf(manifest: DemoManifest): PlanRequest {
    return {
        prompt: manifest.prompt,
        modules: manifest.modules,
        mode: manifest.mode,
        audience: manifest.audience,
        language: manifest.language,
        targetDurationSeconds: manifest.targetDurationSeconds,
    };
}
