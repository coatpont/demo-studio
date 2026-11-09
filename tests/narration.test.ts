import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { narrate, type VoiceOptions } from '../src/narration/elevenlabs.ts';
import type { DemoPlan } from '../src/schema/plan.ts';

function plan(narrative: string): DemoPlan {
    return { introduction: '', scenes: [{ id: 's1', narrative }] } as unknown as DemoPlan;
}

function synthesis(text: string): Response {
    const characters = [...text];

    return new Response(
        JSON.stringify({
            audio_base64: Buffer.alloc(1600).toString('base64'),
            alignment: {
                characters,
                character_start_times_seconds: characters.map((_, index) => index * 0.05),
                character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.05),
            },
        }),
        { status: 200 }
    );
}

describe('ElevenLabs narration', () => {
    let directory: string;
    let options: VoiceOptions;
    const fetchMock = vi.fn();

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'narration-'));
        options = {
            apiKey: 'key',
            voiceId: 'voice',
            modelId: 'model',
            language: 'en',
            cacheDir: join(directory, 'cache'),
            settings: {},
            pronunciations: [],
        };
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
            synthesis((JSON.parse(String(init.body)) as { text: string }).text)
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        rmSync(directory, { recursive: true, force: true });
    });

    it('bills nothing that has not changed', async () => {
        const narrative = 'One sentence. Another. A third. A last one.';
        const first = await narrate(plan(narrative), join(directory, 'run'), options);
        expect(first).toMatchObject({ synthesized: 4, cached: 0 });
        const again = await narrate(plan(narrative), join(directory, 'run'), options);
        expect(again).toMatchObject({ synthesized: 0, cached: 4, characters: 0 });
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(readdirSync(join(directory, 'run', 'narration'))).toContain('s1-01.mp3');
    });

    it('synthesises again a changed sentence and its two neighbours, not the others', async () => {
        await narrate(plan('One sentence. Another. A third. A last one.'), join(directory, 'run'), options);
        const changed = await narrate(
            plan('One sentence. Another. A third, retouched. A last one.'),
            join(directory, 'run'),
            options
        );
        expect(changed).toMatchObject({ synthesized: 3, cached: 1 });
    });

    it('redoes everything when the voice changes, the API key staying out of the cache key', async () => {
        await narrate(plan('One sentence. Another.'), join(directory, 'run'), options);
        expect(
            await narrate(plan('One sentence. Another.'), join(directory, 'run'), { ...options, apiKey: 'other' })
        ).toMatchObject({ cached: 2 });
        expect(
            await narrate(plan('One sentence. Another.'), join(directory, 'run'), { ...options, voiceId: 'other' })
        ).toMatchObject({ synthesized: 2 });
    });

    it('dictates the pronunciation rules but keeps the written text for subtitles', async () => {
        const result = await narrate(plan('Run kubectl now.'), join(directory, 'run'), {
            ...options,
            pronunciations: [{ written: 'kubectl', flags: 'gi', spoken: 'cube control' }],
        });
        const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { text: string };
        expect(body.text).toBe('Run cube control now.');
        const [sentence] = result.narration.scenes[0].sentences;
        expect(sentence.text).toBe('Run kubectl now.');
        expect(sentence.startsMs).toHaveLength(sentence.text.length);
    });

    it('retries after a temporary refusal, and gives up on a request error', async () => {
        vi.useFakeTimers();
        try {
            fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
            const pending = narrate(plan('One sentence.'), join(directory, 'run'), options);
            await vi.runAllTimersAsync();
            expect(await pending).toMatchObject({ synthesized: 1 });

            fetchMock.mockResolvedValueOnce(
                new Response(JSON.stringify({ detail: { message: 'unknown voice' } }), { status: 400 })
            );
            await expect(narrate(plan('Another.'), join(directory, 'run'), options)).rejects.toThrow(
                /HTTP 400.*unknown voice/
            );
            expect(existsSync(join(directory, 'cache'))).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
