import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { Branding, Timeline, Tracks } from '../schema/video.ts';

// Written here rather than imported from Root.tsx: Node does not read JSX, only Remotion's bundler does.
const COMPOSITION_ID = 'DemoVideo';

const HEADLESS_SHELLS = [
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-headless-shell-linux-arm64', 'chrome-headless-shell'],
    ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
    ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
    ['chrome-linux', 'headless_shell'],
];

function playwrightCaches(): string[] {
    return [
        process.env.PLAYWRIGHT_BROWSERS_PATH,
        join(homedir(), '.cache/ms-playwright'),
        join(homedir(), 'Library/Caches/ms-playwright'),
    ].filter((path): path is string => undefined !== path && existsSync(path));
}

/** A named Chrome, else the Chromium installed by `demo-studio browser`; null lets Remotion download its own. */
export function findBrowser(chromePath: string | null): string | null {
    if (chromePath && existsSync(chromePath)) {
        return chromePath;
    }
    for (const cache of playwrightCaches()) {
        for (const entry of readdirSync(cache)
            .filter((name) => name.startsWith('chromium_headless_shell-'))
            .sort()
            .reverse()) {
            for (const [platform, binary] of HEADLESS_SHELLS) {
                const candidate = join(cache, entry, platform, binary);
                if (existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }

    return null;
}

/** The package root: Remotion bundles the composition from its TypeScript sources, shipped with the package. */
function packageRoot(): string {
    let directory = import.meta.dirname;
    while (!existsSync(join(directory, 'package.json'))) {
        const parent = dirname(directory);
        if (parent === directory) {
            throw new Error('demo-studio package root not found.');
        }
        directory = parent;
    }

    return directory;
}

export interface RenderOptions {
    runDir: string;
    tracks: Tracks;
    branding: Branding;
    output: string;
    browser: string | null;
    concurrency: number | null;
    onProgress: (step: 'bundle' | 'render', progress: number) => void;
}

/** Remotion render: the run directory is the public directory, for captured frames and narration. */
export async function renderVideo(timeline: Timeline, options: RenderOptions): Promise<void> {
    const serveUrl = await bundle({
        entryPoint: join(packageRoot(), 'src/video/index.ts'),
        publicDir: options.runDir,
        // Captured frames weigh hundreds of megabytes: a link rather than a copy.
        symlinkPublicDir: true,
        onProgress: (progress) => options.onProgress('bundle', progress / 100),
    });
    const inputProps = { timeline, tracks: options.tracks, branding: options.branding };
    const browserExecutable = options.browser ?? undefined;
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, browserExecutable });
    await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        crf: 18,
        imageFormat: 'jpeg',
        jpegQuality: 92,
        outputLocation: options.output,
        inputProps,
        browserExecutable,
        concurrency: options.concurrency,
        onProgress: ({ progress }) => options.onProgress('render', progress),
    });
}
