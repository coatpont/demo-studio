import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DemoStore, LOCK_FILE, PLAN_FILE, requestOf } from '../src/demos/store.ts';
import type { DemoManifest } from '../src/schema/demo.ts';

const manifest: DemoManifest = {
    id: 'task-basics',
    title: 'Task basics',
    description: 'Follow the tasks of a project.',
    status: 'reference',
    audience: 'team leads',
    language: 'en',
    mode: 'deep-dive',
    modules: ['tasks'],
    prompt: null,
    targetDurationSeconds: 300,
};

describe('DemoStore', () => {
    let root: string;
    let demos: string;
    let store: DemoStore;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'demo-store-'));
        demos = join(root, 'demos');
        store = new DemoStore(demos, join(root, '.demo-studio'));
    });

    it('creates a manifest, reads it back and derives the plan request', () => {
        store.createManifest(manifest);
        expect(store.ids()).toEqual(['task-basics']);
        expect(store.manifest('task-basics')).toEqual(manifest);
        expect(requestOf(manifest)).toEqual({
            prompt: null,
            modules: ['tasks'],
            mode: 'deep-dive',
            audience: 'team leads',
            language: 'en',
            targetDurationSeconds: 300,
        });
        expect(store.workDir('task-basics')).toBe(join(root, '.demo-studio', 'demos', 'task-basics'));
    });

    it('refuses a malformed id, an unknown demo and a manifest whose id differs from its directory', () => {
        expect(() => store.manifest('Task Basics')).toThrow(/lowercase/);
        store.createManifest(manifest);
        expect(() => store.manifest('unknown')).toThrow(/not found.*task-basics/);
        mkdirSync(join(demos, 'copy'));
        writeFileSync(join(demos, 'copy', 'demo.yaml'), readFileSync(join(demos, manifest.id, 'demo.yaml')));
        expect(() => store.manifest('copy')).toThrow(/must be equal/);
    });

    it('lists only the directories that have a manifest', () => {
        store.createManifest(manifest);
        mkdirSync(join(demos, 'draft-without-manifest'));
        expect(store.ids()).toEqual(['task-basics']);
    });

    it('reads a missing source as null, and completes the lock without erasing what it holds', () => {
        store.createManifest(manifest);
        expect(store.source(manifest.id, PLAN_FILE)).toBeNull();
        expect(store.lock(manifest.id)).toEqual({ validation: null, dryRun: null, narration: null, video: null });
        const validation = { catalogVersion: 'abc' };
        store.updateLock(manifest.id, { validation });
        store.updateLock(manifest.id, { dryRun: { status: 'passed', steps: '40/40', catalogVersion: 'abc' } });
        expect(store.lock(manifest.id)).toMatchObject({ validation, dryRun: { steps: '40/40' } });
    });

    it('does not rewrite the lock when only the timestamp changes', () => {
        store.createManifest(manifest);
        const narration = {
            voiceId: 'voice',
            modelId: 'model',
            settings: {},
            sentences: 3,
            durationMs: 9000,
            at: '2026-11-06T10:00:00Z',
        };
        store.updateLock(manifest.id, { narration });
        const written = statSync(join(demos, manifest.id, LOCK_FILE)).mtimeMs;
        store.updateLock(manifest.id, { narration: { ...narration, at: '2026-11-07T10:00:00Z' } });
        expect(store.lock(manifest.id).narration?.at).toBe('2026-11-06T10:00:00Z');
        expect(statSync(join(demos, manifest.id, LOCK_FILE)).mtimeMs).toBe(written);
        store.updateLock(manifest.id, { narration: { ...narration, sentences: 4, at: '2026-11-07T10:00:00Z' } });
        expect(store.lock(manifest.id).narration).toMatchObject({ sentences: 4, at: '2026-11-07T10:00:00Z' });
    });

    it('reads an older lock without the tracks of the video as voice only', () => {
        store.createManifest(manifest);
        writeFileSync(
            join(demos, manifest.id, LOCK_FILE),
            JSON.stringify({ video: { durationMs: 1, sha256: 'x', gitCommit: null, at: 'now', url: null } })
        );
        expect(store.lock(manifest.id).video?.tracks).toEqual(['voice']);
    });
});
