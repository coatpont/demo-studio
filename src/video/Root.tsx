import { Composition } from 'remotion';
import { DEFAULT_BRANDING, DemoVideo, type DemoVideoProps } from './DemoVideo.tsx';

export const COMPOSITION_ID = 'DemoVideo';

export function Root() {
    return (
        <Composition
            id={COMPOSITION_ID}
            component={DemoVideo}
            fps={30}
            width={1920}
            height={1080}
            durationInFrames={1}
            defaultProps={{ timeline: null, tracks: ['voice'], branding: DEFAULT_BRANDING } satisfies DemoVideoProps}
            calculateMetadata={({ props }: { props: DemoVideoProps }) =>
                props.timeline
                    ? {
                          fps: props.timeline.fps,
                          width: props.timeline.width,
                          height: props.timeline.height,
                          durationInFrames: Math.ceil((props.timeline.durationMs * props.timeline.fps) / 1000),
                      }
                    : {}
            }
        />
    );
}
