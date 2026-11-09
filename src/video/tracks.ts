import { TRACKS, TracksSchema, type Tracks } from '../schema/video.ts';

/** A variant's file: `video.mp4` for the voice alone, the others next to it. */
export function videoFileName(tracks: Tracks): string {
    const parts = TRACKS.filter((track) => tracks.includes(track));

    return 'voice' === parts.join(',') ? 'video.mp4' : `video-${parts.join('-')}.mp4`;
}

export function parseTracks(value: string | undefined): Tracks {
    const parsed = TracksSchema.safeParse(
        (value ?? 'voice')
            .split(/[,+\s]+/)
            .map((track) => track.trim())
            .filter(Boolean)
    );
    if (!parsed.success) {
        throw new Error(`--tracks: "${value}"; choose voice, subtitles, or voice,subtitles.`);
    }

    return parsed.data;
}
