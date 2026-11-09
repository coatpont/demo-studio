import { z } from 'zod';
import { ExecutionSchema } from './scenario.ts';

export const NarrationSentenceSchema = z.object({
    text: z.string(),
    // MP3 track of the sentence; empty for a text-only narration, read as subtitles only.
    file: z.string(),
    durationMs: z.number().nonnegative(),
    // Start and end of each character of `text`, to time a gesture on a word.
    startsMs: z.array(z.number()),
    endsMs: z.array(z.number()),
});
export type NarrationSentence = z.infer<typeof NarrationSentenceSchema>;

export const NarrationSchema = z.object({
    // `text`: no synthesis, each sentence lasts the time it takes to read it on screen.
    provider: z.enum(['elevenlabs', 'text']),
    voiceId: z.string().nullable(),
    modelId: z.string().nullable(),
    language: z.string(),
    introduction: z.array(NarrationSentenceSchema),
    scenes: z.array(z.object({ id: z.string(), sentences: z.array(NarrationSentenceSchema) })),
});
export type Narration = z.infer<typeof NarrationSchema>;

export const FrameSchema = z.object({ t: z.number(), file: z.string() });
export type Frame = z.infer<typeof FrameSchema>;

/** The recording: the gesture log, on the same clock as the captured frames. */
export const RecordingSchema = ExecutionSchema.extend({
    mode: z.literal('record'),
    frames: z.record(z.string(), z.array(FrameSchema)),
});
export type Recording = z.infer<typeof RecordingSchema>;

/**
 * A piece of the presentation timeline: the recording played at real speed from `execFromMs`,
 * or frozen on that frame (`frozen`) while the narration or the cursor catches up.
 */
export const SegmentSchema = z.object({
    startMs: z.number(),
    durationMs: z.number().positive(),
    execFromMs: z.number(),
    frozen: z.boolean(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const CursorEventSchema = z.object({
    atMs: z.number(),
    travelMs: z.number(),
    x: z.number(),
    y: z.number(),
    click: z.boolean(),
});
export type CursorEvent = z.infer<typeof CursorEventSchema>;

export const AudioClipSchema = z.object({
    file: z.string(),
    startMs: z.number(),
    durationMs: z.number(),
    // End of the voice according to the alignment: the file can stop there, sometimes mid-syllable.
    soundMs: z.number().optional(),
});
export type AudioClip = z.infer<typeof AudioClipSchema>;

export const CaptionSchema = z.object({ startMs: z.number(), endMs: z.number(), text: z.string() });
export type Caption = z.infer<typeof CaptionSchema>;

export const TimelineSceneSchema = z.object({
    id: z.string(),
    title: z.string(),
    // Presentation time from the start of the video; everything else in the scene is relative to it.
    startMs: z.number(),
    durationMs: z.number(),
    segments: z.array(SegmentSchema),
    frames: z.array(FrameSchema),
    cursor: z.array(CursorEventSchema),
    audio: z.array(AudioClipSchema),
});
export type TimelineScene = z.infer<typeof TimelineSceneSchema>;

export const TimelineSchema = z.object({
    fps: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    title: z.string(),
    durationMs: z.number(),
    introMs: z.number(),
    introAudio: z.array(AudioClipSchema),
    outroMs: z.number(),
    logo: z.string().nullable(),
    scenes: z.array(TimelineSceneSchema),
    captions: z.array(CaptionSchema),
    warnings: z.array(z.string()),
});
export type Timeline = z.infer<typeof TimelineSchema>;

/** What the rendered video carries: the voice, burned-in subtitles, or both. */
export const TRACKS = ['voice', 'subtitles'] as const;
export const TracksSchema = z.array(z.enum(TRACKS)).min(1);
export type Tracks = z.infer<typeof TracksSchema>;

export interface Branding {
    productName: string | null;
    primaryColor: string;
    inkColor: string;
    backgroundColor: string;
    fontFamily: string;
    // A stylesheet declaring the font (Google Fonts…); the video renders without it if it does not answer.
    fontUrl: string | null;
}
