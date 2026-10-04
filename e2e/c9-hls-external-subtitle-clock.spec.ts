// SlopTank modification notice: added by SlopTank on 2026-10-04.
/**
 * Real Chromium/MSE coverage for the HLS source-clock contract.
 *
 * The server-side synthetic fixture proves that copied-video HLS retains the
 * audio/video source timeline after a non-keyframe resume. This test proves
 * the next boundary: production hls.js and Chromium's external WebVTT track
 * observe that same absolute timeline, without a client-side correction.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';

const REQUESTED_START_SECONDS = 6.5;
const SOURCE_CUE_START_SECONDS = 7;
const SOURCE_CUE_END_SECONDS = 9;

type HlsFixture = {
    root: string;
    files: Map<string, { path: string; contentType: string }>;
};

function hlsJsPath(): string {
    const candidates = [
        resolve(process.cwd(), 'node_modules/hls.js/dist/hls.js'),
        resolve(process.cwd(), '../node_modules/hls.js/dist/hls.js'),
        resolve(process.cwd(), '../../../../node_modules/hls.js/dist/hls.js')
    ];
    const path = candidates.find(candidate => existsSync(candidate));
    if (!path) {
        throw new Error(`Could not find hls.js. Checked: ${candidates.join(', ')}`);
    }
    return path;
}

function createHlsFixture(): HlsFixture {
    const root = join(tmpdir(), `sloptank-c9-hls-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const sourcePath = join(root, 'source.mp4');
    const playlistPath = join(root, 'copied-video.m3u8');
    const segmentPattern = join(root, 'segment%d.ts');

    execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=14',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=14',
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-g', '100', '-keyint_min', '100', '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath
    ]);
    execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', sourcePath,
        '-map', '0:v:0', '-map', '0:a:0',
        '-codec:v', 'copy', '-codec:a', 'copy',
        '-copyts', '-avoid_negative_ts', 'disabled',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', segmentPattern, playlistPath
    ]);

    const subtitlePath = join(root, 'external.vtt');
    writeFileSync(subtitlePath, [
        'WEBVTT',
        '',
        `${formatVttTime(SOURCE_CUE_START_SECONDS)} --> ${formatVttTime(SOURCE_CUE_END_SECONDS)}`,
        'source-clock cue',
        ''
    ].join('\n'));

    const files = new Map<string, { path: string; contentType: string }>([
        [ 'copied-video.m3u8', { path: playlistPath, contentType: 'application/vnd.apple.mpegurl' } ],
        [ 'external.vtt', { path: subtitlePath, contentType: 'text/vtt' } ]
    ]);
    for (const name of ['segment0.ts', 'segment1.ts', 'segment2.ts', 'segment3.ts', 'segment4.ts', 'segment5.ts', 'segment6.ts', 'segment7.ts']) {
        const segmentPath = join(root, name);
        if (existsSync(segmentPath)) {
            files.set(name, { path: segmentPath, contentType: 'video/mp2t' });
        }
    }
    return { root, files };
}

function formatVttTime(seconds: number): string {
    const wholeSeconds = Math.floor(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainder = (seconds - wholeSeconds).toFixed(3).slice(2);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${(wholeSeconds % 60).toString().padStart(2, '0')}.${remainder}`;
}

test.describe('HLS external subtitle source clock', () => {
    let fixture: HlsFixture;

    test.beforeAll(() => {
        fixture = createHlsFixture();
    });

    test.afterAll(() => {
        if (fixture) rmSync(fixture.root, { recursive: true, force: true });
    });

    test('resumed copied-video HLS and external VTT cues share the source clock', async ({ page, baseURL }) => {
        expect(baseURL, 'Playwright must provide an HTTP origin for relative HLS URLs').toBeTruthy();
        await page.goto(`${baseURL}/web/`);
        await page.route(/\/c9-hls\/(copied-video\.m3u8|external\.vtt|segment\d+\.ts)(?:\?.*)?$/, async route => {
            const name = new URL(route.request().url()).pathname.split('/').pop()!;
            const file = fixture.files.get(name);
            if (!file) {
                await route.abort();
                return;
            }
            await route.fulfill({
                body: readFileSync(file.path),
                contentType: file.contentType
            });
        });

        await page.setContent(`
            <video id="video" muted playsinline></video>
            <track id="external" kind="subtitles" srclang="en" label="English" src="/c9-hls/external.vtt" default>
        `);
        await page.addScriptTag({ path: hlsJsPath() });

        await page.evaluate(({ requestedStartSeconds }) => {
            const video = document.querySelector<HTMLVideoElement>('#video')!;
            const HlsConstructor = (window as unknown as { Hls: HlsConstructor }).Hls;
            const hls = new HlsConstructor({
                startPosition: requestedStartSeconds,
                enableWorker: false,
                maxBufferLength: 12
            });
            (window as unknown as { __c9Hls?: Hls }).__c9Hls = hls;
            hls.loadSource('/c9-hls/copied-video.m3u8?CopyTimestamps=true');
            hls.attachMedia(video);
            hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
                void video.play();
            });
        }, { requestedStartSeconds: REQUESTED_START_SECONDS });

        const video = page.locator('#video');
        await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
        await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 30_000 })
            .toBeGreaterThan(REQUESTED_START_SECONDS - 0.25);
        await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => ({
            currentTime: element.currentTime,
            activeCueText: Array.from(element.textTracks[0]?.activeCues ?? [])
                .map(cue => (cue as VTTCue).text)
        })), { timeout: 30_000 })
            .toEqual({
                currentTime: expect.any(Number),
                activeCueText: [ 'source-clock cue' ]
            });

        const observation = await video.evaluate((element: HTMLVideoElement) => ({
            currentTime: element.currentTime,
            activeCueText: Array.from(element.textTracks[0]?.activeCues ?? [])
                .map(cue => (cue as VTTCue).text),
            hlsStartPosition: (window as unknown as { __c9Hls: { config: { startPosition: number } } }).__c9Hls.config.startPosition
        }));
        expect(observation.currentTime).toBeGreaterThanOrEqual(SOURCE_CUE_START_SECONDS);
        expect(observation.currentTime).toBeLessThan(SOURCE_CUE_END_SECONDS + 0.25);
        expect(observation.activeCueText).toEqual([ 'source-clock cue' ]);
        expect(observation.hlsStartPosition).toBe(REQUESTED_START_SECONDS);
    });
});

interface Hls {
    loadSource(url: string): void;
    attachMedia(element: HTMLVideoElement): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    config: { startPosition: number };
}

interface HlsConstructor {
    new (options: Record<string, unknown>): Hls;
    Events: { MANIFEST_PARSED: string };
}
