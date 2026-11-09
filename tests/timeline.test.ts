import { describe, expect, it } from 'vitest';
import { mp3DurationMs } from '../src/narration/elevenlabs.ts';
import { toSpoken } from '../src/narration/pronunciations.ts';
import { findAnchor, splitSentences } from '../src/narration/sentences.ts';
import { READING, textNarration } from '../src/narration/text.ts';
import type { DemoPlan } from '../src/schema/plan.ts';
import type { StepLog } from '../src/schema/scenario.ts';
import type { NarrationSentence, Recording } from '../src/schema/video.ts';
import { buildTimeline, layoutExcerpt, layoutScene, sentenceCaptions, TIMING, toSrt } from '../src/timeline/build.ts';
import { cursorAt, execTimeAt, frameAt } from '../src/timeline/sample.ts';
import { parseTracks, videoFileName } from '../src/video/tracks.ts';

/** A sentence whose every character lasts `msPerChar`. */
function sentence(text: string, msPerChar = 50): NarrationSentence {
    return {
        text,
        file: `narration/${text.length}.mp3`,
        durationMs: text.length * msPerChar,
        startsMs: [...text].map((_, index) => index * msPerChar),
        endsMs: [...text].map((_, index) => (index + 1) * msPerChar),
    };
}

function step(id: string, startMs: number, endMs: number, extra: Partial<StepLog> = {}): StepLog {
    return {
        scene: 's1',
        step: id,
        action: 'expectVisible text "x"',
        status: 'passed',
        startMs,
        endMs,
        url: '/',
        box: null,
        actionMs: null,
        anchor: null,
        error: null,
        ...extra,
    };
}

describe('sentences and anchors', () => {
    it('splits the narration into sentences, punctuation included', () => {
        expect(splitSentences('Open the task.  One click, and done!\nAnd then… the rest')).toEqual([
            'Open the task.',
            'One click, and done!',
            'And then…',
            'the rest',
        ]);
        expect(
            splitSentences('Mr. Smith owns the task, like Dr. Jones. There are 1.5 times more tasks, etc. and so on.')
        ).toEqual(['Mr. Smith owns the task, like Dr. Jones.', 'There are 1.5 times more tasks, etc. and so on.']);
        expect(splitSentences('Release 2026. Then the rest.')).toEqual(['Release 2026.', 'Then the rest.']);
    });

    it('locates an anchor, ignoring case and typographic apostrophes', () => {
        const sentences = ['Open the task.', "From the assignee’s menu, we pick Ada's name."];
        expect(findAnchor(sentences, "from the assignee's menu")).toEqual({ sentence: 1, offset: 0 });
        expect(findAnchor(sentences, 'we pick')).toEqual({ sentence: 1, offset: 26 });
        expect(findAnchor(sentences, 'absent')).toBeNull();
    });
});

describe('timeline of a scene', () => {
    const frames = [0, 1000, 1100, 2000, 2600, 3000].map((t, index) => ({ t, file: `f${index}.jpg` }));

    it('freezes the picture until the anchor word when the voice lags behind the gesture', () => {
        const voice = [sentence('Open the board now.'), sentence('One click on Confirm.')];
        const layout = layoutScene({
            id: 's1',
            title: 'Scene',
            frames,
            sentences: voice,
            steps: [
                step('open', 0, 1000, { action: 'goto task_list' }),
                step('confirm', 1100, 1200, {
                    action: 'click button "Confirm"',
                    box: { x: 100, y: 200, width: 40, height: 20 },
                    anchor: 'Confirm',
                }),
            ],
        });
        const firstEnd = TIMING.leadInMs + voice[0].durationMs + TIMING.sentenceGapMs;
        const anchorAt = firstEnd + 'One click on '.length * 50;
        expect(layout.sentenceStarts).toEqual([TIMING.leadInMs, firstEnd]);
        expect(layout.scene.cursor).toEqual([{ atMs: anchorAt, travelMs: 451, x: 120, y: 210, click: true }]);
        expect(layout.scene.segments.slice(0, 2)).toEqual([
            { startMs: 0, durationMs: 100, execFromMs: 1000, frozen: false },
            { startMs: 100, durationMs: anchorAt - 100, execFromMs: 1100, frozen: true },
        ]);
        expect(layout.warnings).toEqual([]);
    });

    it('delays the sentence when the picture lags, never overlapping the previous one', () => {
        const voice = [sentence('Short.'), sentence('The list appears.')];
        const layout = layoutScene({
            id: 's1',
            title: 'Scene',
            frames,
            sentences: voice,
            steps: [step('open', 0, 1000), step('list', 3000, 3100, { anchor: 'The list appears' })],
        });
        expect(layout.sentenceStarts).toEqual([TIMING.leadInMs, 2000]);
        expect(layout.scene.segments.every((segment) => !segment.frozen || segment.startMs >= 2100)).toBe(true);
        expect(layout.scene.durationMs).toBe(2000 + voice[1].durationMs + TIMING.tailMs);
    });

    it('freezes when the gesture lands, after the scroll that brings the element on screen', () => {
        const layout = layoutScene({
            id: 's1',
            title: 'Scene',
            frames,
            sentences: [],
            steps: [
                step('open', 0, 1000),
                step('footer', 1100, 1700, {
                    action: 'click text "x"',
                    box: { x: 0, y: 0, width: 10, height: 10 },
                    actionMs: 1500,
                }),
            ],
        });
        expect(layout.scene.segments[0]).toEqual({ startMs: 0, durationMs: 500, execFromMs: 1000, frozen: false });
        expect(layout.scene.segments[1]).toMatchObject({ startMs: 500, execFromMs: 1500, frozen: true });
    });

    it('shortens the cursor travel to a nearby element and warns when the voice is ahead of the gesture', () => {
        const near = { x: 900, y: 500, width: 20, height: 20 };
        const layout = layoutScene({
            id: 's1',
            title: 'Scene',
            frames,
            sentences: [sentence('A title, and that’s it.', 50)],
            steps: [
                step('open', 0, 1000),
                step('title', 1100, 1200, { action: 'fill css "#t"', box: near, anchor: 'A title' }),
                step('save', 4000, 4100, { action: 'click css "#v"', box: near, anchor: 'and that’s it' }),
            ],
        });
        expect(layout.scene.cursor.map((event) => event.travelMs)).toEqual([300, 300]);
        // The voice says the anchor at 600 + 9 × 50 ms; the click lands at 3500 + 300 ms.
        expect(layout.warnings).toEqual([
            expect.stringContaining('step save: 2.8 s after "and that’s it" in the voice'),
        ]);
    });

    it('reports a missing anchor and keeps the frames around the window', () => {
        const layout = layoutScene({
            id: 's1',
            title: 'Scene',
            frames,
            sentences: [sentence('Hello.')],
            steps: [step('open', 0, 1050), step('x', 2000, 2100, { anchor: 'unknown' })],
        });
        expect(layout.warnings[0]).toContain('"unknown" not in the narration');
        expect(layout.scene.frames.map((frame) => frame.file)).toEqual(['f1.jpg', 'f2.jpg', 'f3.jpg']);
    });

    it('starts the cursor from the given home position', () => {
        const layout = layoutScene({
            id: 's1',
            title: 'Scene',
            frames,
            sentences: [],
            home: { x: 640, y: 360 },
            steps: [
                step('open', 0, 1000),
                step('x', 1100, 1200, { action: 'click text "x"', box: { x: 630, y: 350, width: 20, height: 20 } }),
            ],
        });
        expect(layout.scene.cursor[0].travelMs).toBe(TIMING.cursorMinTravelMs);
    });
});

describe('welcome', () => {
    const plan = { title: 'Demo', scenes: [{ id: 's1', title: 'Scene' }] } as unknown as DemoPlan;
    const recording = {
        status: 'passed',
        steps: [step('open', 0, 1000)],
        frames: { s1: [{ t: 900, file: 'f.jpg' }] },
    } as unknown as Recording;
    const narration = (introduction: NarrationSentence[]) => ({
        provider: 'elevenlabs' as const,
        voiceId: 'v',
        modelId: 'm',
        language: 'en',
        introduction,
        scenes: [{ id: 's1', sentences: [] }],
    });

    it('lengthens the title card for the welcome, and subtitles it', () => {
        const welcome = [sentence('Welcome to this demonstration of task tracking.', 100)];
        const timeline = buildTimeline(plan, recording, narration(welcome), null);
        const voiceEnd = TIMING.leadInMs + welcome[0].durationMs;
        expect(timeline.introAudio).toEqual([
            {
                file: welcome[0].file,
                startMs: TIMING.leadInMs,
                durationMs: welcome[0].durationMs,
                soundMs: welcome[0].endsMs.at(-1),
            },
        ]);
        expect(timeline.introMs).toBe(voiceEnd + TIMING.tailMs);
        expect(timeline.scenes[0].startMs).toBe(timeline.introMs);
        expect(timeline.captions[0]).toMatchObject({ startMs: TIMING.leadInMs, text: welcome[0].text });
    });

    it('keeps the title card short without a welcome', () => {
        expect(buildTimeline(plan, recording, narration([]), null).introMs).toBe(TIMING.introMs);
    });

    it('takes the video size from the viewport', () => {
        const timeline = buildTimeline(plan, recording, narration([]), null, new Map(), { width: 1280, height: 720 });
        expect([timeline.width, timeline.height]).toEqual([1280, 720]);
    });

    it('refuses a failed recording', () => {
        expect(() => buildTimeline(plan, { ...recording, status: 'failed' }, narration([]), null)).toThrow(/failed/);
    });

    it('without a voice, keeps subtitles at reading pace and adds no audio track', () => {
        const silent = textNarration({
            language: 'en',
            introduction: 'Welcome to this demonstration of task tracking.',
            scenes: [{ id: 's1', narrative: 'Open the task. One click is enough.' }],
        } as unknown as DemoPlan);
        expect(silent.provider).toBe('text');
        expect(silent.introduction[0].durationMs).toBe(
            Math.round((silent.introduction[0].text.length * 1000) / READING.charactersPerSecond)
        );
        expect(silent.scenes[0].sentences.map((one) => one.durationMs)).toEqual([READING.minimumMs, READING.minimumMs]);
        const timeline = buildTimeline(plan, recording, silent, null);
        expect(timeline.introAudio).toEqual([]);
        expect(timeline.scenes[0].audio).toEqual([]);
        expect(timeline.captions.map((caption) => caption.text)).toEqual([
            'Welcome to this demonstration of task tracking.',
            'Open the task.',
            'One click is enough.',
        ]);
    });
});

describe('video tracks', () => {
    it('reads the choice of tracks and names each variant', () => {
        expect(parseTracks(undefined)).toEqual(['voice']);
        expect(videoFileName(parseTracks('voice'))).toBe('video.mp4');
        expect(videoFileName(parseTracks('subtitles'))).toBe('video-subtitles.mp4');
        expect(videoFileName(parseTracks('subtitles,voice'))).toBe('video-voice-subtitles.mp4');
        expect(videoFileName(parseTracks('voice+subtitles'))).toBe('video-voice-subtitles.mp4');
        expect(() => parseTracks('music')).toThrow(/--tracks/);
    });
});

describe('sampling during the edit', () => {
    const segments = [
        { startMs: 0, durationMs: 500, execFromMs: 1000, frozen: false },
        { startMs: 500, durationMs: 1000, execFromMs: 1500, frozen: true },
        { startMs: 1500, durationMs: 500, execFromMs: 1500, frozen: false },
    ];

    it('maps presentation time to recording time', () => {
        expect(execTimeAt(segments, 250)).toBe(1250);
        expect(execTimeAt(segments, 900)).toBe(1500);
        expect(execTimeAt(segments, 1700)).toBe(1700);
        expect(execTimeAt(segments, 5000)).toBe(2000);
    });

    it('shows the last captured frame', () => {
        const frames = [
            { t: 1000, file: 'a' },
            { t: 1400, file: 'b' },
        ];
        expect(frameAt(frames, 900)?.file).toBe('a');
        expect(frameAt(frames, 1399)?.file).toBe('a');
        expect(frameAt(frames, 1600)?.file).toBe('b');
        expect(frameAt([], 1)).toBeNull();
    });

    it('slides the cursor to the element, then ripples the click', () => {
        const events = [{ atMs: 1000, travelMs: 700, x: 500, y: 300, click: true }];
        const home = { x: 100, y: 100 };
        expect(cursorAt(events, 200, home)).toEqual({ x: 100, y: 100, click: null });
        const halfway = cursorAt(events, 650, home);
        expect(halfway.x).toBeCloseTo(300);
        expect(cursorAt(events, 1225, home)).toEqual({ x: 500, y: 300, click: 0.5 });
        expect(cursorAt(events, 3000, home)).toEqual({ x: 500, y: 300, click: null });
    });
});

describe('subtitles', () => {
    it('cuts a long sentence at words, timed by the alignment', () => {
        const text = 'The task joins the list at once, so that the whole team knows what is planned, and for whom.';
        const captions = sentenceCaptions(sentence(text, 10), 5000, 50);
        expect(captions.map((caption) => caption.text)).toEqual([
            'The task joins the list at once, so that the whole',
            'team knows what is planned, and for whom.',
        ]);
        expect(captions[0].startMs).toBe(5000);
        expect(captions[1].startMs).toBe(5000 + text.indexOf('team') * 10);
        expect(captions[1].endMs).toBe(5000 + text.length * 10);
    });

    it('writes an SRT', () => {
        expect(toSrt([{ startMs: 3723004, endMs: 3725500, text: 'Hello' }])).toBe(
            '1\n01:02:03,004 --> 01:02:05,500\nHello\n'
        );
    });
});

describe('pronunciations', () => {
    const rules = [{ written: 'kubectl', flags: 'gi', spoken: 'cube control' }];

    it('dictates a word differently while keeping the position mapping', () => {
        const text = 'Run Kubectl, then kubectl again, not kubernetes.';
        const { spoken, map } = toSpoken(text, rules);
        expect(spoken).toBe('Run Cube control, then cube control again, not kubernetes.');
        expect(map).toHaveLength(text.length);
        expect(spoken[map[text.indexOf(', then')]]).toBe(',');
        expect(spoken[map[text.indexOf('kubernetes')]]).toBe('k');
        expect(map.at(-1)).toBe(spoken.length - 1);
    });

    it('leaves the text unchanged without rules', () => {
        const text = 'Run kubectl';
        expect(toSpoken(text, [])).toEqual({ spoken: text, map: [...text].map((_, index) => index) });
    });

    it('measures a 128 kb/s MP3, ID3 tag excluded', () => {
        const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10]);
        expect(mp3DurationMs(Buffer.concat([id3, Buffer.alloc(10), Buffer.alloc(16000)]))).toBe(1000);
    });
});

describe('scene excerpted from another demo', () => {
    const source = {
        id: 'source',
        title: 'Source scene',
        durationMs: 4000,
        segments: [
            { startMs: 0, durationMs: 1000, execFromMs: 500, frozen: false },
            { startMs: 1000, durationMs: 3000, execFromMs: 1500, frozen: true },
        ],
        frames: [{ t: 600, file: 'excerpts/other/frames/s1/00001.jpg' }],
        cursor: [{ atMs: 900, travelMs: 300, x: 10, y: 20, click: true }],
        audio: [{ file: 'narration/other.mp3', startMs: 600, durationMs: 2000 }],
    };

    it('keeps the source edit under its own voice, and holds the last frame if the voice is longer', () => {
        const sentences = [sentence('A first rather long sentence.', 100), sentence('And a second one.', 100)];
        const layout = layoutExcerpt('s1', 'Excerpt', source, sentences);
        const first = sentences[0].durationMs;
        const voiceEnd = TIMING.leadInMs + first + TIMING.sentenceGapMs + sentences[1].durationMs;
        expect(layout.sentenceStarts).toEqual([TIMING.leadInMs, TIMING.leadInMs + first + TIMING.sentenceGapMs]);
        expect(layout.scene.durationMs).toBe(voiceEnd + TIMING.tailMs);
        expect(layout.scene.segments.at(-1)).toEqual({
            startMs: 4000,
            durationMs: voiceEnd + TIMING.tailMs - 4000,
            execFromMs: 1500,
            frozen: true,
        });
        expect(layout.scene.frames).toBe(source.frames);
        expect(layout.scene.cursor).toEqual(source.cursor);
        expect(layout.scene.audio.map((clip) => clip.file)).toEqual(sentences.map((one) => one.file));
    });

    it('shortens the source freezes when the voice is shorter, cursor included', () => {
        const layout = layoutExcerpt('s1', 'Excerpt', source, [sentence('Short.', 50)]);
        const target = TIMING.leadInMs + 300 + TIMING.tailMs;
        expect(layout.scene.durationMs).toBe(target);
        expect(layout.scene.segments).toEqual([
            source.segments[0],
            { startMs: 1000, durationMs: target - 1000, execFromMs: 1500, frozen: true },
        ]);
        expect(layout.scene.cursor[0]).toMatchObject({ atMs: 900, travelMs: 300 });
    });

    it('keeps a minimal time for each freeze, and moving footage at real speed', () => {
        const layout = layoutExcerpt('s1', 'Excerpt', source, []);
        expect(layout.scene.segments.map((segment) => segment.durationMs)).toEqual([1000, TIMING.excerptMinFreezeMs]);
    });
});
