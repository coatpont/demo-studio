import type { CursorEvent, Frame, Segment } from '../schema/video.ts';

/** The recording time to show at a given time of the scene. */
export function execTimeAt(segments: Segment[], ms: number): number {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (segments[middle].startMs <= ms) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    const segment = segments[low];
    if (!segment) {
        return 0;
    }

    return segment.frozen
        ? segment.execFromMs
        : segment.execFromMs + Math.min(Math.max(ms - segment.startMs, 0), segment.durationMs);
}

/** The last frame captured at that recording time: Chrome only sends one on each change. */
export function frameAt(frames: Frame[], exec: number): Frame | null {
    let low = 0;
    let high = frames.length - 1;
    if (high < 0) {
        return null;
    }
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (frames[middle].t <= exec) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return frames[low];
}

export interface CursorState {
    x: number;
    y: number;
    // From 0 to 1 during a click's ripple, null otherwise.
    click: number | null;
}

const CLICK_MS = 450;

function ease(progress: number): number {
    return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

export function cursorAt(events: CursorEvent[], ms: number, home: { x: number; y: number }): CursorState {
    let from = home;
    let click: number | null = null;
    for (const event of events) {
        const departure = event.atMs - event.travelMs;
        if (ms < departure) {
            break;
        }
        if (ms < event.atMs) {
            const progress = ease((ms - departure) / event.travelMs);

            return {
                x: from.x + (event.x - from.x) * progress,
                y: from.y + (event.y - from.y) * progress,
                click: null,
            };
        }
        from = event;
        click = event.click && ms < event.atMs + CLICK_MS ? (ms - event.atMs) / CLICK_MS : null;
    }

    return { x: from.x, y: from.y, click };
}
