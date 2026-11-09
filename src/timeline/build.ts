import { findAnchor } from '../narration/sentences.ts';
import type { DemoPlan } from '../schema/plan.ts';
import type { StepLog } from '../schema/scenario.ts';
import type {
    AudioClip,
    Caption,
    CursorEvent,
    Frame,
    Narration,
    NarrationSentence,
    Recording,
    Segment,
    Timeline,
    TimelineScene,
} from '../schema/video.ts';

export const TIMING = {
    fps: 30,
    introMs: 3500,
    outroMs: 3500,
    // Silence before the first sentence of a scene, and between two sentences.
    leadInMs: 600,
    sentenceGapMs: 350,
    // Cursor travel to the element before a click or an entry: short to a neighbour, longer across the screen.
    cursorTravelMs: 700,
    cursorMinTravelMs: 300,
    cursorMsPerPixel: 0.5,
    // Delay of a gesture after its anchor's words beyond which we warn: the voice already said what is not yet seen.
    anchorLateMs: 600,
    // Picture left on screen after the last sentence or gesture.
    tailMs: 1200,
    // What is kept of the recording after the last gesture, for its reaction to show.
    afterLastStepMs: 400,
    captionMaxChars: 84,
    // Shortest freeze kept when shortening an excerpt: the time to see the screen change.
    excerptMinFreezeMs: 400,
};

const POINTER_ACTIONS = /^(click|check|select|select2|fill|press) /;
const CLICK_ACTIONS = /^(click|check|select|select2) /;

/** Time, within the sentence, at which character `offset` starts; without alignment, in proportion. */
function offsetMs(sentence: NarrationSentence, offset: number): number {
    if (sentence.startsMs.length === sentence.text.length) {
        return sentence.startsMs[offset] ?? 0;
    }

    return Math.round((sentence.durationMs * offset) / Math.max(sentence.text.length, 1));
}

function audioClip(sentence: NarrationSentence, startMs: number): AudioClip {
    const soundMs = sentence.endsMs.at(-1);

    return {
        file: sentence.file,
        startMs,
        durationMs: sentence.durationMs,
        ...(soundMs ? { soundMs: Math.min(soundMs, sentence.durationMs) } : {}),
    };
}

/** The subtitles of a sentence, cut at words, timed by the character alignment. */
export function sentenceCaptions(sentence: NarrationSentence, startMs: number, maxChars: number): Caption[] {
    const captions: Caption[] = [];
    const words = [...sentence.text.matchAll(/\S+/g)];
    let first = 0;
    while (first < words.length) {
        let last = first;
        while (
            last + 1 < words.length &&
            words[last + 1].index + words[last + 1][0].length - words[first].index <= maxChars
        ) {
            last++;
        }
        const from = words[first].index;
        const to = words[last].index + words[last][0].length;
        const endOffset = to - 1;
        captions.push({
            startMs: startMs + (first === 0 ? 0 : offsetMs(sentence, from)),
            endMs:
                startMs +
                (last === words.length - 1
                    ? sentence.durationMs
                    : sentence.endsMs.length === sentence.text.length
                      ? (sentence.endsMs[endOffset] ?? sentence.durationMs)
                      : offsetMs(sentence, to)),
            text: sentence.text.slice(from, to),
        });
        first = last + 1;
    }

    return captions;
}

export interface SceneInput {
    id: string;
    title: string;
    steps: StepLog[];
    frames: Frame[];
    sentences: NarrationSentence[];
    // Where the cursor rests before the first gesture: the middle of the screen.
    home?: { x: number; y: number };
}

export interface SceneLayout {
    scene: Omit<TimelineScene, 'startMs'>;
    sentenceStarts: number[];
    warnings: string[];
}

/**
 * Matches a scene's recording and narration. The recording plays at real speed between two gestures;
 * before a gesture, the picture freezes while the cursor arrives and the sentence reaches the word of its
 * anchor. A sentence never starts before the end of the previous one: the picture waits for the voice,
 * never the voice for the picture.
 */
export function layoutScene(input: SceneInput): SceneLayout {
    const warnings: string[] = [];
    const [first, ...rest] = input.steps;
    if (!first) {
        throw new Error(`Scene ${input.id}: no recorded gesture.`);
    }
    const texts = input.sentences.map((sentence) => sentence.text);
    const starts: number[] = [];
    const segments: Segment[] = [];
    const cursor: CursorEvent[] = [];
    let presentation = 0;
    // The scene starts once its page is loaded: the loading itself is of no interest.
    let exec = first.endMs;
    let audioCursor = TIMING.leadInMs;
    let nextSentence = 0;
    let searchFrom = 0;
    let pointerAt = input.home ?? { x: 960, y: 540 };

    const place = (index: number, start: number): void => {
        starts[index] = start;
        audioCursor = start + input.sentences[index].durationMs + TIMING.sentenceGapMs;
        nextSentence = index + 1;
    };
    const placeUpTo = (index: number): void => {
        while (nextSentence < index) {
            place(nextSentence, audioCursor);
        }
    };
    const play = (until: number): void => {
        if (until > exec) {
            segments.push({ startMs: presentation, durationMs: until - exec, execFromMs: exec, frozen: false });
            presentation += until - exec;
            exec = until;
        }
    };
    const freeze = (until: number): void => {
        if (until > presentation) {
            segments.push({ startMs: presentation, durationMs: until - presentation, execFromMs: exec, frozen: true });
            presentation = until;
        }
    };

    for (const [index, step] of [first, ...rest].entries()) {
        if (index > 0) {
            play(step.actionMs ?? step.startMs);
        }
        const pointer = index > 0 && null !== step.box && POINTER_ACTIONS.test(`${step.action} `);
        const target = step.box
            ? { x: Math.round(step.box.x + step.box.width / 2), y: Math.round(step.box.y + step.box.height / 2) }
            : pointerAt;
        const travel = pointer
            ? Math.round(
                  Math.min(
                      TIMING.cursorTravelMs,
                      Math.max(
                          TIMING.cursorMinTravelMs,
                          Math.hypot(target.x - pointerAt.x, target.y - pointerAt.y) * TIMING.cursorMsPerPixel
                      )
                  )
              )
            : 0;
        let at = presentation + travel;
        if (step.anchor) {
            const position = findAnchor(texts, step.anchor, searchFrom);
            if (!position) {
                warnings.push(`Scene ${input.id}, step ${step.step}: anchor "${step.anchor}" not in the narration.`);
            } else {
                searchFrom = position.sentence;
                const sentence = input.sentences[position.sentence];
                const within = offsetMs(sentence, position.offset);
                if (undefined === starts[position.sentence]) {
                    placeUpTo(position.sentence);
                    const start = Math.max(audioCursor, at - within);
                    place(position.sentence, start);
                    at = start + within;
                } else {
                    const spoken = starts[position.sentence] + within;
                    if (at - spoken > TIMING.anchorLateMs) {
                        warnings.push(
                            `Scene ${input.id}, step ${step.step}: ${((at - spoken) / 1000).toFixed(1)} s after "${step.anchor}" in the voice; ` +
                                'cut the sentence before this anchor so that the voice waits for it.'
                        );
                    }
                    at = Math.max(at, spoken);
                }
            }
        }
        freeze(at);
        if (pointer) {
            cursor.push({
                atMs: presentation,
                travelMs: travel,
                ...target,
                click: CLICK_ACTIONS.test(`${step.action} `),
            });
            pointerAt = target;
        }
    }
    play((rest.at(-1) ?? first).endMs + TIMING.afterLastStepMs);
    placeUpTo(input.sentences.length);
    const voiceEnd = input.sentences.length > 0 ? audioCursor - TIMING.sentenceGapMs : 0;
    freeze(Math.max(presentation, voiceEnd) + TIMING.tailMs);

    const windowStart = first.endMs;
    const lastBefore = input.frames.filter((frame) => frame.t <= windowStart).at(-1);
    const frames = input.frames.filter((frame) => frame.t > windowStart && frame.t <= exec);
    if (lastBefore) {
        frames.unshift(lastBefore);
    }
    if (0 === frames.length) {
        warnings.push(`Scene ${input.id}: no frame recorded.`);
    }
    const audio: AudioClip[] = input.sentences
        .map((sentence, index) => audioClip(sentence, starts[index]))
        .filter((clip) => '' !== clip.file);

    return {
        scene: { id: input.id, title: input.title, durationMs: presentation, segments, frames, cursor, audio },
        sentenceStarts: starts,
        warnings,
    };
}

export type ExcerptSource = Omit<TimelineScene, 'startMs'>;

/**
 * A scene reused from another demo: its segments, frames and cursor as they were edited there, under this
 * demo's narration, spoken in one go. The source's freezes waited for its own voice: they are shortened in
 * proportion to follow this one, moving footage keeping real speed. If the voice outlasts the source, the
 * last frame stays.
 */
export function layoutExcerpt(
    id: string,
    title: string,
    source: ExcerptSource,
    sentences: NarrationSentence[]
): SceneLayout {
    const starts: number[] = [];
    let voice = TIMING.leadInMs;
    for (const sentence of sentences) {
        starts.push(voice);
        voice += sentence.durationMs + TIMING.sentenceGapMs;
    }
    const target = (sentences.length > 0 ? voice - TIMING.sentenceGapMs : 0) + TIMING.tailMs;
    const played = source.segments.filter((segment) => !segment.frozen).reduce((sum, one) => sum + one.durationMs, 0);
    const frozen = source.durationMs - played;
    const ratio = frozen > 0 ? Math.min(1, Math.max(0, (target - played) / frozen)) : 1;

    // Each segment keeps its original start (`from`) and gets its new place: enough to re-time the cursor.
    const segments: Segment[] = [];
    const moves: { from: number; to: number; old: number; length: number }[] = [];
    let presentation = 0;
    for (const segment of source.segments) {
        const length = segment.frozen
            ? Math.round(Math.max(Math.min(segment.durationMs, TIMING.excerptMinFreezeMs), segment.durationMs * ratio))
            : segment.durationMs;
        segments.push({ ...segment, startMs: presentation, durationMs: length });
        moves.push({ from: segment.startMs, to: presentation, old: segment.durationMs, length });
        presentation += length;
    }
    const remap = (ms: number): number => {
        const move = moves.find((one) => ms < one.from + one.old) ?? moves.at(-1);

        return move ? move.to + Math.min(move.length, ((ms - move.from) * move.length) / Math.max(move.old, 1)) : ms;
    };
    const last = source.segments.at(-1);
    if (target > presentation) {
        const lastExec = last ? (last.frozen ? last.execFromMs : last.execFromMs + last.durationMs) : 0;
        segments.push({ startMs: presentation, durationMs: target - presentation, execFromMs: lastExec, frozen: true });
        presentation = target;
    }
    const cursor = source.cursor.map((event) => {
        const atMs = Math.round(remap(event.atMs));

        return { ...event, atMs, travelMs: Math.max(0, atMs - Math.round(remap(event.atMs - event.travelMs))) };
    });
    const audio = sentences
        .map((sentence, index) => audioClip(sentence, starts[index]))
        .filter((clip) => '' !== clip.file);

    return {
        scene: { id, title, durationMs: presentation, segments, frames: source.frames, cursor, audio },
        sentenceStarts: starts,
        warnings: [],
    };
}

export function buildTimeline(
    plan: DemoPlan,
    recording: Recording,
    narration: Narration,
    logo: string | null,
    excerpts: Map<string, ExcerptSource> = new Map(),
    size = { width: 1920, height: 1080 }
): Timeline {
    if ('passed' !== recording.status) {
        throw new Error('The recording failed: nothing to edit.');
    }
    const scenes: TimelineScene[] = [];
    const captions: Caption[] = [];
    const warnings: string[] = [];
    // The welcome, sentence after sentence on the title card, which lasts as long as needed.
    const introAudio: AudioClip[] = [];
    let voiceCursor = TIMING.leadInMs;
    for (const sentence of narration.introduction) {
        if ('' !== sentence.file) {
            introAudio.push(audioClip(sentence, voiceCursor));
        }
        captions.push(...sentenceCaptions(sentence, voiceCursor, TIMING.captionMaxChars));
        voiceCursor += sentence.durationMs + TIMING.sentenceGapMs;
    }
    const introMs =
        introAudio.length > 0
            ? Math.max(TIMING.introMs, voiceCursor - TIMING.sentenceGapMs + TIMING.tailMs)
            : TIMING.introMs;
    let cursor = introMs;
    for (const planScene of plan.scenes) {
        const voice = narration.scenes.find((scene) => scene.id === planScene.id);
        if (!voice) {
            throw new Error(`Scene ${planScene.id} has no narration: run narrate again.`);
        }
        const steps = recording.steps.filter((step) => step.scene === planScene.id);
        const excerpt = excerpts.get(planScene.id);
        if (planScene.excerpt && !excerpt) {
            throw new Error(`Scene ${planScene.id}: excerpt of ${planScene.excerpt.demo} not found.`);
        }
        const layout = excerpt
            ? layoutExcerpt(planScene.id, planScene.title, excerpt, voice.sentences)
            : layoutScene({
                  id: planScene.id,
                  title: planScene.title,
                  steps,
                  frames: recording.frames[planScene.id] ?? [],
                  sentences: voice.sentences,
                  home: { x: size.width / 2, y: size.height / 2 },
              });
        scenes.push({ ...layout.scene, startMs: cursor });
        voice.sentences.forEach((sentence, index) =>
            captions.push(...sentenceCaptions(sentence, cursor + layout.sentenceStarts[index], TIMING.captionMaxChars))
        );
        warnings.push(...layout.warnings);
        for (const step of steps) {
            const box = step.box;
            if (box && (box.y < 0 || box.x < 0 || box.y + box.height > size.height || box.x + box.width > size.width)) {
                warnings.push(
                    `Scene ${planScene.id}, step ${step.step}: element off screen at the time of the gesture.`
                );
            }
        }
        cursor += layout.scene.durationMs;
    }

    return {
        fps: TIMING.fps,
        width: size.width,
        height: size.height,
        title: plan.title,
        durationMs: cursor + TIMING.outroMs,
        introMs,
        introAudio,
        outroMs: TIMING.outroMs,
        logo,
        scenes,
        captions,
        warnings,
    };
}

function srtTime(ms: number): string {
    const value = Math.max(0, Math.round(ms));
    const pad = (number: number, size = 2): string => String(number).padStart(size, '0');

    return `${pad(Math.floor(value / 3600000))}:${pad(Math.floor(value / 60000) % 60)}:${pad(Math.floor(value / 1000) % 60)},${pad(value % 1000, 3)}`;
}

export function toSrt(captions: Caption[]): string {
    return captions
        .map(
            (caption, index) =>
                `${index + 1}\n${srtTime(caption.startMs)} --> ${srtTime(caption.endMs)}\n${caption.text}\n`
        )
        .join('\n');
}
