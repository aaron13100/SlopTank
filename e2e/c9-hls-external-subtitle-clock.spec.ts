// SlopTank modification notice: added or changed by SlopTank on 2026-10-04, 2026-10-07.
/**
 * Real Chromium/MSE coverage for the HLS source-clock contract.
 *
 * The server-side synthetic fixture proves that copied-video HLS retains the
 * audio/video source timeline after a non-keyframe resume. This test proves
 * the next boundary: production hls.js and Chromium's external WebVTT track
 * observe that same absolute timeline, without a client-side correction.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loadScaledMs } from './load-scaled-bounds';

const REQUESTED_START_SECONDS = 6.5;
const SOURCE_CUE_START_SECONDS = 7;
const SOURCE_CUE_END_SECONDS = 9;
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';

type HlsFixture = {
    root: string;
    files: Map<string, { path: string; contentType: string }>;
    accurateSeekAudioVideoSkewSeconds: number;
    resumedAudioVideoSkewSeconds: number;
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
    const root = mkdtempSync(join(tmpdir(), 'sloptank-c9-hls-'));
    const sourcePath = join(root, 'source.mp4');
    const playlistPath = join(root, 'copied-video.m3u8');
    const segmentPattern = join(root, 'segment%d.ts');
    const accurateSeekPlaylistPath = join(root, 'accurate-seek.m3u8');
    const accurateSeekSegmentPattern = join(root, 'accurate-seek-segment%d.ts');
    const resumedPlaylistPath = join(root, 'resumed.m3u8');
    const resumedBrowserPlaylistPath = join(root, 'resumed-browser.m3u8');
    const resumedSegmentPattern = join(root, 'resumed-segment%d.ts');

    execFileSync(FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=14',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=14',
        '-vf', "drawbox=x=0:y=0:w=32:h=32:color=red:t=fill,drawbox=x=0:y=0:w=32:h=32:color=green:t=fill:enable='gte(t,7)*lt(t,9)',drawbox=x=0:y=0:w=32:h=32:color=blue:t=fill:enable='gte(t,9)'",
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-g', '100', '-keyint_min', '100', '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath
    ], { timeout: loadScaledMs(60_000) });
    execFileSync(FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error',
        '-i', sourcePath,
        '-map', '0:v:0', '-map', '0:a:0',
        '-codec:v', 'copy', '-codec:a', 'copy',
        '-copyts', '-avoid_negative_ts', 'disabled',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', segmentPattern, playlistPath
    ], { timeout: loadScaledMs(60_000) });
    const generateResumedHls = (noAccurateSeek: boolean, outputSegmentPattern: string, outputPlaylistPath: string) => {
        execFileSync(FFMPEG_PATH, [
            '-hide_banner', '-loglevel', 'error',
            ...(noAccurateSeek ? [ '-noaccurate_seek' ] : []),
            '-ss', REQUESTED_START_SECONDS.toString(), '-i', sourcePath,
            '-map', '0:v:0', '-map', '0:a:0',
            '-codec:v:0', 'copy', '-start_at_zero', '-codec:a:0', 'aac',
            '-copyts', '-avoid_negative_ts', 'disabled',
            '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'mpegts', '-hls_playlist_type', 'vod',
            '-hls_segment_filename', outputSegmentPattern, outputPlaylistPath
        ], { timeout: loadScaledMs(60_000) });
    };
    generateResumedHls(false, accurateSeekSegmentPattern, accurateSeekPlaylistPath);
    generateResumedHls(true, resumedSegmentPattern, resumedPlaylistPath);

    // DynamicHlsPlaylistGenerator advertises the full source timeline, not the
    // short playlist FFmpeg writes after a segment request restarts encoding.
    // The 6.5s seek retains the source's 4s keyframe, so its first output file
    // supplies source segment 1. Without the full manifest Hls.js normalizes
    // that file to zero and the external cue can accompany the wrong frame.
    writeFileSync(resumedBrowserPlaylistPath, readFileSync(playlistPath, 'utf8').replace(
        /segment(\d+)\.ts/g,
        (name, index: string) => Number(index) === 0 ? name : `resumed-segment${Number(index) - 1}.ts`
    ));

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
        [ 'resumed.m3u8', { path: resumedBrowserPlaylistPath, contentType: 'application/vnd.apple.mpegurl' } ],
        [ 'accurate-seek.m3u8', { path: accurateSeekPlaylistPath, contentType: 'application/vnd.apple.mpegurl' } ],
        [ 'external.vtt', { path: subtitlePath, contentType: 'text/vtt' } ]
    ]);
    for (const name of [
        'segment0.ts', 'segment1.ts', 'segment2.ts', 'segment3.ts', 'segment4.ts', 'segment5.ts', 'segment6.ts', 'segment7.ts',
        'accurate-seek-segment0.ts', 'accurate-seek-segment1.ts', 'accurate-seek-segment2.ts', 'accurate-seek-segment3.ts',
        'resumed-segment0.ts', 'resumed-segment1.ts', 'resumed-segment2.ts', 'resumed-segment3.ts'
    ]) {
        const segmentPath = join(root, name);
        if (existsSync(segmentPath)) {
            files.set(name, { path: segmentPath, contentType: 'video/mp2t' });
        }
    }
    const accurateSeekAudioVideoSkewSeconds = getDecodedAudioVideoSkew(accurateSeekPlaylistPath);
    const resumedAudioVideoSkewSeconds = getDecodedAudioVideoSkew(resumedPlaylistPath);
    return { root, files, accurateSeekAudioVideoSkewSeconds, resumedAudioVideoSkewSeconds };
}

function getDecodedAudioVideoSkew(playlistPath: string): number {
    const getFirstPts = (selector: 'v:0' | 'a:0') => {
        const output = execFileSync('/usr/local/bin/ffprobe', [
            '-v', 'error', '-select_streams', selector, '-show_frames',
            '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', playlistPath
        ], { encoding: 'utf8', timeout: loadScaledMs(60_000) });
        const probe = JSON.parse(output) as { frames: Array<{ best_effort_timestamp_time: string }> };
        const timestamp = Number(probe.frames[0]?.best_effort_timestamp_time);
        expect(Number.isFinite(timestamp), `${selector} first decoded PTS: ${output}`).toBe(true);
        return timestamp;
    };

    return Math.abs(getFirstPts('v:0') - getFirstPts('a:0'));
}

function formatVttTime(seconds: number): string {
    const wholeSeconds = Math.floor(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainder = (seconds - wholeSeconds).toFixed(3).slice(2);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${(wholeSeconds % 60).toString().padStart(2, '0')}.${remainder}`;
}

async function observeSourceCue(page: Page, baseURL: string | undefined, fixture: HlsFixture, playlistName: string) {
    expect(baseURL, 'Playwright must provide an HTTP origin for relative HLS URLs').toBeTruthy();
    await page.goto(`${baseURL}/web/`);
    await page.route(/\/c9-hls\/(copied-video\.m3u8|accurate-seek\.m3u8|resumed\.m3u8|external\.vtt|(?:accurate-seek-|resumed-)?segment\d+\.ts)(?:\?.*)?$/, async route => {
        const name = new URL(route.request().url()).pathname.split('/').pop()!;
        const file = fixture.files.get(name);
        if (!file) {
            await route.abort();
            return;
        }
        await route.fulfill({ body: readFileSync(file.path), contentType: file.contentType });
    });
    await page.setContent(`
        <video id="video" muted playsinline>
            <track id="external" kind="subtitles" srclang="en" label="English" default>
        </video>
    `);
    await page.addScriptTag({ path: hlsJsPath() });
    await page.evaluate(({ requestedStartSeconds, playlistName: requestedPlaylistName }) => {
        const video = document.querySelector<HTMLVideoElement>('#video')!;
        const HlsConstructor = (window as unknown as { Hls: HlsConstructor }).Hls;
        const hls = new HlsConstructor({
            startPosition: requestedStartSeconds,
            enableWorker: false,
            maxBufferLength: 12
        });
        (window as unknown as { __c9Hls?: Hls }).__c9Hls = hls;
        hls.loadSource(`/c9-hls/${requestedPlaylistName}?CopyTimestamps=true`);
        hls.attachMedia(video);
        video.querySelector<HTMLTrackElement>('#external')!.src = '/c9-hls/external.vtt';
        video.textTracks[0].mode = 'hidden';
        hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
            video.play().catch(error => {
                throw new Error(`HLS fixture playback failed: ${String(error)}`);
            });
        });
    }, { requestedStartSeconds: REQUESTED_START_SECONDS, playlistName });

    const video = page.locator('#video');
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState), {
        timeout: loadScaledMs(30_000),
        message: 'expected Hls.js to append a decodable video frame'
    }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => ({
        currentTime: element.currentTime,
        activeCueText: Array.from(element.textTracks[0]?.activeCues ?? []).map(cue => (cue as VTTCue).text)
    })), { timeout: loadScaledMs(30_000), message: 'expected the source-time external cue to become active during playback' })
        .toEqual({ currentTime: expect.any(Number), activeCueText: [ 'source-clock cue' ] });

    const observation = await video.evaluate((element: HTMLVideoElement) => {
        element.pause();
        const canvas = document.createElement('canvas');
        canvas.width = element.videoWidth;
        canvas.height = element.videoHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(element, 0, 0);
        return {
            currentTime: element.currentTime,
            activeCueText: Array.from(element.textTracks[0]?.activeCues ?? []).map(cue => (cue as VTTCue).text),
            hlsStartPosition: (window as unknown as { __c9Hls: { config: { startPosition: number } } }).__c9Hls.config.startPosition,
            sourceFramePixel: Array.from(context.getImageData(16, 16, 1, 1).data).slice(0, 3)
        };
    });
    expect(observation.currentTime).toBeGreaterThanOrEqual(SOURCE_CUE_START_SECONDS);
    expect(observation.currentTime).toBeLessThan(SOURCE_CUE_END_SECONDS + 0.25);
    expect(observation.activeCueText).toEqual([ 'source-clock cue' ]);
    expect(observation.hlsStartPosition).toBe(REQUESTED_START_SECONDS);
    expect(observation.sourceFramePixel, JSON.stringify(observation)).toEqual([
        expect.any(Number), expect.any(Number), expect.any(Number)
    ]);
    expect(observation.sourceFramePixel[1], JSON.stringify(observation)).toBeGreaterThan(100);
    expect(observation.sourceFramePixel[0], JSON.stringify(observation)).toBeLessThan(30);
    expect(observation.sourceFramePixel[2], JSON.stringify(observation)).toBeLessThan(30);
    return observation;
}

test.describe('HLS external subtitle source clock', () => {
    test.setTimeout(loadScaledMs(120_000));
    let fixture: HlsFixture;

    test.beforeAll(() => {
        fixture = createHlsFixture();
    });

    test.afterAll(() => {
        if (fixture) rmSync(fixture.root, { recursive: true, force: true });
    });

    test('resumed copied-video HLS and external VTT cues share the source clock', async ({ page, baseURL }) => {
        await observeSourceCue(page, baseURL, fixture, 'copied-video.m3u8');
    });

    test('input-side resumed HLS keeps transcoded audio on the copied-video source clock', async ({ page, baseURL }) => {
        expect(fixture.accurateSeekAudioVideoSkewSeconds, 'Accurate-seek control must reproduce the decoded A/V mismatch').toBeGreaterThan(0.2);
        expect(
            fixture.resumedAudioVideoSkewSeconds,
            'FFprobe first decoded audio/video PTS must retain the same preroll with noaccurate_seek'
        ).toBeLessThanOrEqual(0.04);

        await observeSourceCue(page, baseURL, fixture, 'resumed.m3u8');
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
