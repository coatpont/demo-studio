import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pronunciation, VoiceSettings } from '../config/schema.ts';
import type { DemoPlan } from '../schema/plan.ts';
import type { Narration, NarrationSentence } from '../schema/video.ts';
import { toSpoken } from './pronunciations.ts';
import { splitSentences } from './sentences.ts';

export interface VoiceOptions {
    apiKey: string;
    voiceId: string;
    modelId: string;
    language: string;
    cacheDir: string;
    // Settings left out keep the value saved on the voice at ElevenLabs.
    settings: VoiceSettings;
    pronunciations: Pronunciation[];
}

interface Alignment {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
}

interface Synthesis {
    audio: Buffer;
    alignment: Alignment;
}

const API = 'https://api.elevenlabs.io/v1';
const ATTEMPTS = 3;

/** Duration of a constant-bitrate MP3 (the format requested), more reliable than the end of the last character. */
export function mp3DurationMs(audio: Buffer, kbps = 128): number {
    const id3 =
        'ID3' === audio.subarray(0, 3).toString('latin1')
            ? 10 + ((audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9])
            : 0;

    return Math.round(((audio.length - id3) * 8) / kbps);
}

async function request(options: VoiceOptions, body: Record<string, unknown>): Promise<Synthesis> {
    const url = `${API}/text-to-speech/${encodeURIComponent(options.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    for (let attempt = 1; ; attempt++) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'xi-api-key': options.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (response.ok) {
            const data = (await response.json()) as { audio_base64: string; alignment: Alignment };

            return { audio: Buffer.from(data.audio_base64, 'base64'), alignment: data.alignment };
        }
        const retryable = 429 === response.status || response.status >= 500;
        if (!retryable || attempt >= ATTEMPTS) {
            const detail = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
            throw new Error(
                `ElevenLabs refused the synthesis (HTTP ${response.status}): ${detail?.detail?.message ?? response.statusText}`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
}

/**
 * Synthesises a sentence, or takes it from the cache: the key covers everything that changes the sound,
 * neighbouring sentences included since they steer the intonation. The API key is not part of it.
 */
async function synthesize(
    options: VoiceOptions,
    text: string,
    previous: string | null,
    next: string | null
): Promise<{ audioPath: string; alignment: Alignment; cached: boolean }> {
    const body = {
        text,
        model_id: options.modelId,
        language_code: options.language,
        ...(Object.keys(options.settings).length > 0 ? { voice_settings: options.settings } : {}),
        ...(previous ? { previous_text: previous } : {}),
        ...(next ? { next_text: next } : {}),
    };
    const key = createHash('sha256')
        .update(JSON.stringify({ voiceId: options.voiceId, ...body }))
        .digest('hex');
    const audioPath = join(options.cacheDir, `${key}.mp3`);
    const alignmentPath = join(options.cacheDir, `${key}.json`);
    if (existsSync(audioPath) && existsSync(alignmentPath)) {
        return { audioPath, alignment: JSON.parse(readFileSync(alignmentPath, 'utf8')) as Alignment, cached: true };
    }
    const { audio, alignment } = await request(options, body);
    mkdirSync(options.cacheDir, { recursive: true });
    writeFileSync(audioPath, audio);
    writeFileSync(alignmentPath, JSON.stringify(alignment));

    return { audioPath, alignment, cached: false };
}

export interface NarrationResult {
    narration: Narration;
    synthesized: number;
    cached: number;
    characters: number;
}

/** One track per sentence of each scene, copied into the run's `narration/`. */
export async function narrate(plan: DemoPlan, runDir: string, options: VoiceOptions): Promise<NarrationResult> {
    const result: NarrationResult = {
        narration: {
            provider: 'elevenlabs',
            voiceId: options.voiceId,
            modelId: options.modelId,
            language: options.language,
            introduction: [],
            scenes: [],
        },
        synthesized: 0,
        cached: 0,
        characters: 0,
    };
    mkdirSync(join(runDir, 'narration'), { recursive: true });
    const voice = async (narrative: string, prefix: string): Promise<NarrationSentence[]> => {
        const texts = splitSentences(narrative);
        const sentences: NarrationSentence[] = [];
        for (const [index, text] of texts.entries()) {
            const { spoken, map } = toSpoken(text, options.pronunciations);
            const neighbour = (other: string | undefined): string | null =>
                other ? toSpoken(other, options.pronunciations).spoken : null;
            const { audioPath, alignment, cached } = await synthesize(
                options,
                spoken,
                neighbour(texts[index - 1]),
                neighbour(texts[index + 1])
            );
            // The alignment is on the dictated text: each written character takes the time of its own.
            const at = (times: number[], position: number): number =>
                Math.round(
                    (times[
                        Math.min(Math.round((position * times.length) / Math.max(spoken.length, 1)), times.length - 1)
                    ] ?? 0) * 1000
                );
            const file = `narration/${prefix}-${String(index + 1).padStart(2, '0')}.mp3`;
            copyFileSync(audioPath, join(runDir, file));
            const lastEnd = alignment.character_end_times_seconds.at(-1) ?? 0;
            sentences.push({
                text,
                file,
                durationMs: Math.max(mp3DurationMs(readFileSync(audioPath)), Math.round(lastEnd * 1000)),
                startsMs: map.map((position) => at(alignment.character_start_times_seconds, position)),
                endsMs: map.map((position) => at(alignment.character_end_times_seconds, position)),
            });
            if (cached) {
                result.cached++;
            } else {
                result.synthesized++;
                result.characters += spoken.length;
            }
        }

        return sentences;
    };
    result.narration.introduction = await voice(plan.introduction, 'intro');
    for (const scene of plan.scenes) {
        result.narration.scenes.push({ id: scene.id, sentences: await voice(scene.narrative, scene.id) });
    }

    return result;
}
