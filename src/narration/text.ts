import type { DemoPlan } from '../schema/plan.ts';
import type { Narration, NarrationSentence } from '../schema/video.ts';
import { splitSentences } from './sentences.ts';

// Reading speed of a subtitle, and the minimum for a short sentence to be read.
export const READING = { charactersPerSecond: 15, minimumMs: 1800 };

function silentSentence(text: string): NarrationSentence {
    return {
        text,
        file: '',
        durationMs: Math.max(READING.minimumMs, Math.round((text.length * 1000) / READING.charactersPerSecond)),
        // Without alignment, the timeline places an anchor in proportion to the sentence.
        startsMs: [],
        endsMs: [],
    };
}

/** Narration without a voice: each sentence of the plan stays on screen the time it takes to read it. */
export function textNarration(plan: DemoPlan): Narration {
    const sentences = (narrative: string): NarrationSentence[] => splitSentences(narrative).map(silentSentence);

    return {
        provider: 'text',
        voiceId: null,
        modelId: null,
        language: plan.language,
        introduction: sentences(plan.introduction),
        scenes: plan.scenes.map((scene) => ({ id: scene.id, sentences: sentences(scene.narrative) })),
    };
}
