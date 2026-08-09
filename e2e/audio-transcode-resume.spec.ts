/**
 * Regression coverage for the audio-transcode resume stall
 * (queue task t_260718_132551_465).
 *
 * Items whose video direct-plays but whose audio needs transcoding (e.g.
 * h264 + AC3 in an MKV) are served as HLS with video codec:copy and audio
 * aac_at. Resuming such an item from a mid-file position makes the server
 * kill and restart ffmpeg at the resume segment (-ss + -start_number). With
 * transcode throttling enabled, that flow could deadlock: the throttler
 * pauses ffmpeg based on DownloadPositionTicks, which only advances when a
 * segment response *completes*, while DynamicHlsController's segment wait
 * loop will not complete a response for the transcode-head segment until
 * ffmpeg (paused!) writes the next one. The user-visible result was a video
 * frozen on one frame with the OSD never appearing (the exact symptom
 * reported for 'The Mechanic 2 Resurrection'). Upstream diagnosed the same
 * race in jellyfin/jellyfin PR #16315 and never merged a fix; this server
 * runs with EnableThrottling=false to eliminate the pause leg entirely.
 *
 * This spec drives the real user flow: login -> set a mid-file resume
 * position through the app's own ApiClient -> details page -> Resume ->
 * assert playback actually advances. On failure it dumps forensics that
 * discriminate a server-side hang (pending segment requests) from a
 * client-side append problem (buffered ranges vs currentTime).
 *
 * Requires E2E_TRANSCODE_ITEM_ID: an item id whose audio codec is not
 * direct-playable in Chromium (AC3/DTS), video h264. The Sword Art Online
 * Season 00 extras (BDRip 1080p AC3) qualify permanently on this server.
 */
import type { Page } from '@playwright/test';
import { VIDEO_ROUTE, expect, login, test } from './fixtures';

// This host's live transcoding is slow (see docs/streaming-format-policy in
// the parent mediaserver project): each fatal-error fallback in the second
// spec below forces a real ffmpeg transcode restart, observed taking up to
// ~90s per restart across three chained restarts. 180s was too tight and
// failed the assertion mid-restart even though the underlying fix worked;
// 300s gives headroom without masking a genuine hang.
test.setTimeout(300_000);

const RESUME_POSITION_TICKS = 6_000_000_000; // 10 minutes

function requireTranscodeItemId(): string {
    const value = process.env.E2E_TRANSCODE_ITEM_ID; // allow-direct-env: e2e config read, same pattern as fixtures.ts
    if (!value) {
        throw new Error( // allow-raw-error: test setup fast-fail, matching fixtures.ts convention
            'Missing required env var E2E_TRANSCODE_ITEM_ID. Set it to a library item '
            + 'whose audio requires transcoding (AC3/DTS) while video direct-plays, '
            + 'e.g. one of the Sword Art Online Season 00 AC3 extras.'
        );
    }
    return value;
}

interface PendingReq { url: string; start: number }

interface HlsTestInstance {
    on(eventName: string, listener: () => void): void;
    trigger(eventName: string, data: {
        type: string;
        fatal: boolean;
        details: string;
    }): void;
}

interface HlsTestConstructor {
    prototype: {
        attachMedia(media: HTMLMediaElement): unknown;
    };
    Events: {
        ERROR: string;
        FRAG_BUFFERED: string;
    };
    ErrorTypes: {
        NETWORK_ERROR: string;
    };
}

interface PlaybackTestWindow extends Window {
    ApiClient: {
        ajax(options: {
            type: string;
            url: string;
            data: string;
            contentType: string;
        }): Promise<unknown>;
        getUrl(path: string): string;
    };
    Hls?: HlsTestConstructor;
    __fatalErrorTestHls?: HlsTestInstance;
    __fatalErrorTestGeneration?: number;
    __fatalErrorTestReadyGeneration?: number;
}

async function playCurrentDetailsWithHls(page: Page): Promise<void> {
    await page.locator('.mainDetailButtons .btnPlay').click();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    await expect(page.locator('video').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(
        () => page.evaluate(() => typeof (window as unknown as PlaybackTestWindow).Hls === 'function'),
        { message: 'real HLS playback should load the production hls.js constructor' }
    ).toBe(true);
}

async function captureNextHlsInstance(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as unknown as PlaybackTestWindow;
        const HlsConstructor = testWindow.Hls!;
        const originalAttachMedia = HlsConstructor.prototype.attachMedia;
        HlsConstructor.prototype.attachMedia = function(this: HlsTestInstance, media: HTMLMediaElement) {
            testWindow.__fatalErrorTestHls = this;
            const generation = (testWindow.__fatalErrorTestGeneration ?? 0) + 1;
            testWindow.__fatalErrorTestGeneration = generation;
            this.on(HlsConstructor.Events.FRAG_BUFFERED, () => {
                if (testWindow.__fatalErrorTestHls === this) {
                    testWindow.__fatalErrorTestReadyGeneration = generation;
                }
            });
            return originalAttachMedia.call(this, media);
        };
    });
}

async function emitFatalHlsTimeoutSequence(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as unknown as PlaybackTestWindow;
        const HlsConstructor = testWindow.Hls!;
        const hls = testWindow.__fatalErrorTestHls!;
        const fatalTimeout = {
            type: HlsConstructor.ErrorTypes.NETWORK_ERROR,
            fatal: true,
            details: 'fragLoadTimeOut'
        };

        // Three bounded recovery attempts are allowed. The next fatal timeout
        // must leave the retry loop and reach playbackManager's visible error.
        for (let attempt = 0; attempt < 4; attempt++) {
            hls.trigger(HlsConstructor.Events.ERROR, fatalTimeout);
        }
    });
}

// @covers audio_transcode.resume.mid_file_position.advances_without_freezing
test('resume of an audio-transcode item starts playing and advances', async ({ page, config }) => {
    const itemId = requireTranscodeItemId();

    const pending = new Map<string, PendingReq>();
    const finished: string[] = [];
    const consoleLog: string[] = [];
    let reqSeq = 0;

    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('/videos/') || url.includes('/Videos/') || url.includes('.m3u8') || url.includes('hls1')) {
            pending.set(`${reqSeq++}|${url}`, { url, start: Date.now() });
        }
    });
    const settle = (request: import('@playwright/test').Request, tag: string) => {
        for (const [key, p] of pending) {
            if (p.url === request.url()) {
                finished.push(`${tag} ${Date.now() - p.start}ms ${p.url.slice(0, 200)}`);
                pending.delete(key);
                break;
            }
        }
    };
    page.on('requestfinished', (r) => settle(r, 'ok'));
    page.on('requestfailed', (r) => settle(r, `FAILED(${r.failure()?.errorText})`));
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
            consoleLog.push(`console.${message.type()}: ${message.text().slice(0, 300)}`);
        }
    });
    page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));

    await login(page, config.username, config.password);

    // Set the resume position through the app's own session-report endpoint,
    // exactly what a previous abandoned playback would have recorded.
    await page.evaluate(async ({ id, ticks }) => {
        const api = (window as unknown as PlaybackTestWindow).ApiClient;
        await api.ajax({
            type: 'POST',
            url: api.getUrl('Sessions/Playing/Stopped'),
            data: JSON.stringify({ ItemId: id, PositionTicks: ticks }),
            contentType: 'application/json'
        });
    }, { id: itemId, ticks: RESUME_POSITION_TICKS });

    await page.goto(`/web/#/details?id=${itemId}&serverId=${config.serverId}`);

    const playButton = page.locator('.mainDetailButtons .btnPlay');
    await playButton.click();

    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });

    // The stall fingerprint: currentTime lands at the resume point and then
    // never advances (frozen frame). Give the player 45s to prove it moves.
    let advanced = false;
    let initialTime = -1;
    const started = Date.now();
    while (Date.now() - started < 45_000) {
        const state = await video.evaluate((el: HTMLVideoElement) => ({
            t: el.currentTime, paused: el.paused
        }));
        if (initialTime < 0 && state.t > 0) {
            initialTime = state.t;
        }
        if (initialTime >= 0 && state.t > initialTime + 1.5 && !state.paused) {
            advanced = true;
            break;
        }
        await page.waitForTimeout(1_000);
    }

    if (!advanced) {
        const forensics = await video.evaluate((el: HTMLVideoElement) => {
            const buf: string[] = [];
            for (let i = 0; i < el.buffered.length; i++) {
                buf.push(`[${el.buffered.start(i).toFixed(2)}..${el.buffered.end(i).toFixed(2)}]`);
            }
            return {
                currentTime: el.currentTime,
                paused: el.paused,
                readyState: el.readyState,
                networkState: el.networkState,
                buffered: buf.join(' '),
                error: el.error ? `${el.error.code}:${el.error.message}` : null
            };
        });
        const now = Date.now();
        console.log('=== STALL FORENSICS ===');
        console.log('video:', JSON.stringify(forensics));
        console.log('--- pending requests (server-side hang if any are old) ---');
        console.log([...pending.values()].map((p) => `PENDING ${((now - p.start) / 1000).toFixed(1)}s ${p.url.slice(0, 200)}`).join('\n') || '(none)');
        console.log('--- last finished requests ---');
        console.log(finished.slice(-20).join('\n'));
        console.log('--- console ---');
        console.log(consoleLog.slice(-20).join('\n'));
        console.log('=== END FORENSICS ===');
    }

    expect(advanced, 'video should start advancing after Resume of an audio-transcode item').toBe(true);
});

// @covers playback.error_recovery.hung_server_steady_state.surfaces_error
test('fatal hls.js network errors surface a playback error instead of freezing the video page', async ({ page, config }) => {
    const itemId = requireTranscodeItemId();

    await login(page, config.username, config.password);

    // First playback loads the same hls.js constructor used by the production
    // player. The module exposes it on window for browser integrations.
    await page.goto(`/web/#/details?id=${itemId}&serverId=${config.serverId}`);
    await playCurrentDetailsWithHls(page);

    // Leave playback, then capture the next real Hls instance at the public
    // attachMedia boundary. This keeps the event injection at the platform
    // boundary while the details-page Play button remains the entry point.
    await page.goto(`/web/#/details?id=${itemId}&serverId=${config.serverId}`);
    await captureNextHlsInstance(page);

    await playCurrentDetailsWithHls(page);
    await expect.poll(
        () => page.evaluate(() => Boolean((window as unknown as PlaybackTestWindow).__fatalErrorTestHls)),
        { message: 'the user-started playback should attach a real hls.js instance' }
    ).toBe(true);

    const errorHeading = page.getByRole('heading', { name: 'Playback Error' });
    // playbackManager has two bounded fallbacks for a local item: disable
    // video stream copy, then disable audio stream copy. Drive each real HLS
    // generation to its terminal error; the third has both copy paths
    // disabled and must surface the user-visible error instead of retrying.
    const maxTerminalFailures = 3;
    for (let terminalFailure = 0; terminalFailure < maxTerminalFailures; terminalFailure++) {
        const currentGeneration = await page.evaluate(
            () => (window as unknown as PlaybackTestWindow).__fatalErrorTestGeneration ?? 0
        );
        await expect.poll(
            () => page.evaluate(
                (generation) => (
                    (window as unknown as PlaybackTestWindow).__fatalErrorTestReadyGeneration === generation
                ),
                currentGeneration
            ),
            {
                message: `HLS generation ${currentGeneration} should buffer media before its steady-state failure`,
                timeout: 90_000
            }
        ).toBe(true);
        await emitFatalHlsTimeoutSequence(page);
        if (await errorHeading.isVisible() || terminalFailure === maxTerminalFailures - 1) {
            break;
        }
        await expect.poll(
            async () => {
                if (await errorHeading.isVisible()) {
                    return true;
                }
                return page.evaluate(
                    (generation) => (
                        ((window as unknown as PlaybackTestWindow).__fatalErrorTestGeneration ?? 0) > generation
                    ),
                    currentGeneration
                );
            },
            {
                message: `terminal HLS failure ${terminalFailure + 1} should surface or enter playbackManager fallback`,
                timeout: 90_000
            }
        ).toBe(true);
    }

    await expect(errorHeading).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Playback failed due to a network error.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Got It' })).toBeVisible();
});
