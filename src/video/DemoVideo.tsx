import { useEffect, useState, type CSSProperties } from 'react';
import {
    AbsoluteFill,
    Audio,
    Img,
    Sequence,
    continueRender,
    delayRender,
    interpolate,
    staticFile,
    useCurrentFrame,
    useVideoConfig,
} from 'remotion';
import type { AudioClip, Branding, Caption, Timeline, TimelineScene, Tracks } from '../schema/video.ts';
import { cursorAt, execTimeAt, frameAt } from '../timeline/sample.ts';

export interface DemoVideoProps extends Record<string, unknown> {
    timeline: Timeline | null;
    tracks: Tracks;
    branding: Branding;
}

export const DEFAULT_BRANDING: Branding = {
    productName: null,
    primaryColor: '#2563eb',
    inkColor: '#111827',
    backgroundColor: '#ffffff',
    fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
    fontUrl: null,
};

const FADE_MS = 400;
// The synthesis sometimes cuts the last syllable sharply: a brief fade avoids the end click.
const VOICE_FADE_MS = 50;

function toFrames(ms: number, fps: number): number {
    return Math.max(1, Math.round((ms * fps) / 1000));
}

function NarrationClip({ clip, fps }: { clip: AudioClip; fps: number }) {
    const soundMs = clip.soundMs ?? clip.durationMs;
    const volume = (frame: number): number =>
        interpolate((frame * 1000) / fps, [soundMs - VOICE_FADE_MS, soundMs], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        });

    return (
        <Sequence
            from={Math.round((clip.startMs * fps) / 1000)}
            durationInFrames={toFrames(clip.durationMs, fps)}
            layout="none"
        >
            <Audio src={staticFile(clip.file)} volume={volume} />
        </Sequence>
    );
}

/** The brand font, if a stylesheet declares it; the video renders without it if the stylesheet does not answer. */
function useBrandFont(fontUrl: string | null): void {
    const [handle] = useState(() =>
        fontUrl ? delayRender('Loading the brand font', { timeoutInMilliseconds: 15000 }) : null
    );
    useEffect(() => {
        if (null === handle || !fontUrl) {
            return;
        }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = fontUrl;
        document.head.appendChild(link);
        const done = (): void => continueRender(handle);
        link.onload = () => {
            document.fonts.ready.then(done).catch(done);
        };
        link.onerror = done;
    }, [handle, fontUrl]);
}

function fade(frame: number, total: number, fps: number): number {
    const edge = toFrames(FADE_MS, fps);

    return interpolate(frame, [0, edge, Math.max(edge + 1, total - edge), total], [0, 1, 1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
}

interface TitleCardProps {
    title: string | null;
    logo: string | null;
    durationMs: number;
    branding: Branding;
}

function TitleCard({ title, logo, durationMs, branding }: TitleCardProps) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const opacity = fade(frame, toFrames(durationMs, fps), fps);
    const rise = interpolate(frame, [0, toFrames(800, fps)], [24, 0], { extrapolateRight: 'clamp' });
    // Without a logo, the closing card shows the product name.
    const heading = title ?? (logo ? null : branding.productName);

    return (
        <AbsoluteFill
            style={{
                backgroundColor: branding.backgroundColor,
                alignItems: 'center',
                justifyContent: 'center',
                opacity,
            }}
        >
            {logo ? <Img src={staticFile(logo)} style={{ width: 560, marginBottom: heading ? 64 : 0 }} /> : null}
            {heading ? (
                <div
                    style={{
                        fontFamily: branding.fontFamily,
                        fontWeight: 600,
                        fontSize: 60,
                        color: branding.inkColor,
                        maxWidth: 1400,
                        textAlign: 'center',
                        lineHeight: 1.25,
                        transform: `translateY(${rise}px)`,
                    }}
                >
                    {heading}
                </div>
            ) : null}
            <div
                style={{
                    position: 'absolute',
                    bottom: 0,
                    height: 12,
                    width: '100%',
                    backgroundColor: branding.primaryColor,
                }}
            />
        </AbsoluteFill>
    );
}

function Cursor({ x, y, click, color }: { x: number; y: number; click: number | null; color: string }) {
    const ripple: CSSProperties | null =
        null === click
            ? null
            : {
                  position: 'absolute',
                  left: x - 28 * (0.4 + click),
                  top: y - 28 * (0.4 + click),
                  width: 56 * (0.4 + click),
                  height: 56 * (0.4 + click),
                  borderRadius: '50%',
                  border: `4px solid ${color}`,
                  opacity: 1 - click,
              };

    return (
        <>
            {ripple ? <div style={ripple} /> : null}
            <svg
                width={34}
                height={34}
                viewBox="0 0 24 24"
                style={{
                    position: 'absolute',
                    left: x - 4,
                    top: y - 2,
                    filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.35))',
                    transform: null === click ? undefined : `scale(${0.9 + 0.1 * click})`,
                }}
            >
                <path
                    d="M4 2 L4 19 L8.5 14.8 L11.6 21.5 L14.4 20.3 L11.3 13.7 L17.5 13.4 Z"
                    fill="#ffffff"
                    stroke="#111111"
                    strokeWidth={1.4}
                    strokeLinejoin="round"
                />
            </svg>
        </>
    );
}

function SceneTitle({ title, bottom, branding }: { title: string; bottom: number; branding: Branding }) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const opacity = fade(frame, toFrames(3500, fps), fps);

    return (
        <div
            style={{
                position: 'absolute',
                left: 48,
                bottom,
                padding: '18px 32px',
                backgroundColor: 'rgba(255,255,255,0.96)',
                borderLeft: `8px solid ${branding.primaryColor}`,
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                fontFamily: branding.fontFamily,
                fontWeight: 600,
                fontSize: 36,
                color: branding.inkColor,
                opacity,
            }}
        >
            {title}
        </div>
    );
}

interface SceneProps {
    scene: TimelineScene;
    width: number;
    height: number;
    voice: boolean;
    subtitles: boolean;
    branding: Branding;
}

function Scene({ scene, width, height, voice, subtitles, branding }: SceneProps) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const ms = (frame * 1000) / fps;
    const shot = frameAt(scene.frames, execTimeAt(scene.segments, ms));
    const pointer = cursorAt(scene.cursor, ms, { x: width / 2, y: height / 2 });
    const opacity = fade(frame, toFrames(scene.durationMs, fps), fps);

    return (
        <AbsoluteFill style={{ backgroundColor: '#000000' }}>
            <AbsoluteFill style={{ opacity }}>
                {shot ? <Img src={staticFile(shot.file)} style={{ width, height }} /> : null}
                {scene.cursor.length > 0 ? <Cursor {...pointer} color={branding.primaryColor} /> : null}
                <Sequence durationInFrames={toFrames(3500, fps)} layout="none">
                    <SceneTitle title={scene.title} bottom={subtitles ? 260 : 140} branding={branding} />
                </Sequence>
            </AbsoluteFill>
            {voice ? scene.audio.map((clip) => <NarrationClip key={clip.file} clip={clip} fps={fps} />) : null}
        </AbsoluteFill>
    );
}

/** The current subtitle, burned in at the bottom of the picture: readable without sound. */
function Subtitles({ captions, branding }: { captions: Caption[]; branding: Branding }) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const ms = (frame * 1000) / fps;
    const caption = captions.find((candidate) => candidate.startMs <= ms && ms < candidate.endMs);
    if (!caption) {
        return null;
    }

    return (
        <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 56 }}>
            <div
                style={{
                    maxWidth: 1500,
                    padding: '14px 28px',
                    borderRadius: 10,
                    backgroundColor: 'rgba(17, 24, 32, 0.82)',
                    color: '#ffffff',
                    fontFamily: branding.fontFamily,
                    fontWeight: 400,
                    fontSize: 40,
                    lineHeight: 1.35,
                    textAlign: 'center',
                }}
            >
                {caption.text}
            </div>
        </AbsoluteFill>
    );
}

export function DemoVideo({ timeline, tracks, branding }: DemoVideoProps) {
    useBrandFont(branding.fontUrl);
    const { fps } = useVideoConfig();
    if (!timeline) {
        return null;
    }
    const outroStart = timeline.durationMs - timeline.outroMs;
    const voice = tracks.includes('voice');
    const subtitles = tracks.includes('subtitles');

    return (
        <AbsoluteFill style={{ backgroundColor: branding.backgroundColor }}>
            <Sequence durationInFrames={toFrames(timeline.introMs, fps)}>
                <TitleCard
                    title={timeline.title}
                    logo={timeline.logo}
                    durationMs={timeline.introMs}
                    branding={branding}
                />
                {voice
                    ? timeline.introAudio.map((clip) => <NarrationClip key={clip.file} clip={clip} fps={fps} />)
                    : null}
            </Sequence>
            {timeline.scenes.map((scene) => (
                <Sequence
                    key={scene.id}
                    from={Math.round((scene.startMs * fps) / 1000)}
                    durationInFrames={toFrames(scene.durationMs, fps)}
                >
                    <Scene
                        scene={scene}
                        width={timeline.width}
                        height={timeline.height}
                        voice={voice}
                        subtitles={subtitles}
                        branding={branding}
                    />
                </Sequence>
            ))}
            <Sequence from={Math.round((outroStart * fps) / 1000)} durationInFrames={toFrames(timeline.outroMs, fps)}>
                <TitleCard title={null} logo={timeline.logo} durationMs={timeline.outroMs} branding={branding} />
            </Sequence>
            {subtitles ? <Subtitles captions={timeline.captions} branding={branding} /> : null}
        </AbsoluteFill>
    );
}
