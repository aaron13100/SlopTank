// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
import { expect, login, test } from './fixtures';

test.setTimeout(180_000);

/**
 * Regression coverage for the details-page prefetch in
 * components/viewManager/prefetchVideoController.ts: the video player
 * controller's chunk (and its legacy view HTML) should already be
 * requested by the time the user reaches Play, instead of the click being
 * what first asks the network for it, and clicking must reuse what was
 * already fetched rather than requesting it a second time.
 *
 * Chunk filenames are content-hashed and not otherwise predictable, so the
 * match below is anchored on the STABLE part webpack derives from the
 * `playback/video/index` request -- confirmed once against a real dev
 * build (`playback-video.<hash>.chunk.js`,
 * `playback-video-index-html.<hash>.chunk.js`) -- while still excluding the
 * unrelated `playback-video-<MenuName>` chunks the controller itself lazy
 * loads once it actually runs (SubtitleTrackMenu, EpisodePlaybackMenu,
 * SyncPlayIconControl).
 */
const VIDEO_CONTROLLER_CHUNK = /\/playback-video(-index-html)?\.[0-9a-f]+\.chunk\.js(?:\?|$)/;

/**
 * Stops the real playback session the test started, cloning the stop report
 * from the client's own start/progress request the same way
 * playback-start-latency.spec.ts does, so a passing run never leaves a
 * phantom "active session" behind on the live Jellyfin host.
 *
 * @param page - Page the click happened on.
 * @param itemId - The item this test played.
 */
async function stopWhateverStarted(page: import('@playwright/test').Page, itemId: string): Promise<void> {
    const started = await page.waitForRequest(
        (request) => request.method() === 'POST'
            && /\/Sessions\/Playing$/.test(new URL(request.url()).pathname)
            && (request.postDataJSON() as { ItemId?: string } | null)?.ItemId === itemId,
        { timeout: 30_000 }
    ).catch(() => null);
    if (!started) return;

    const report = started.postDataJSON() as { ItemId: string; PlaySessionId: string; [key: string]: unknown };
    const stopUrl = new URL(started.url());
    stopUrl.pathname = stopUrl.pathname.replace(/\/Sessions\/Playing$/, '/Sessions/Playing/Stopped');
    const headers = started.headers();
    const authorizationHeaders: Record<string, string> = {};
    for (const name of [ 'authorization', 'x-emby-authorization', 'x-emby-token' ]) {
        if (headers[name]) authorizationHeaders[name] = headers[name];
    }
    await page.context().request.post(stopUrl.toString(), { data: report, headers: authorizationHeaders, timeout: 30_000 });
}

test.describe('video controller prefetch', () => {
    test('the details page warms the video player controller before Play is clicked, and reuses it on click', async ({ page, config }) => {
        await login(page, config.username, config.password);

        const controllerChunkRequests: string[] = [];
        page.on('request', (request) => {
            if (VIDEO_CONTROLLER_CHUNK.test(request.url())) {
                controllerChunkRequests.push(request.url());
            }
        });

        await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);
        const playButton = page.locator('.mainDetailButtons .btnPlay:visible');
        await expect(playButton).toBeVisible({ timeout: 60_000 });

        // The warmup is scheduled at idle priority (requestIdleCallback,
        // falling back to a 1.5s timer), so give it a real chance to fire --
        // exactly the gap a person spends looking at the page before
        // pressing Play -- before asserting on it.
        await expect
            .poll(() => controllerChunkRequests.length, {
                timeout: 15_000,
                message: 'expected the video controller chunk to already be requested while still on the details page'
            })
            .toBeGreaterThan(0);
        const requestedBeforeClick = [ ...controllerChunkRequests ];

        await playButton.click();
        await expect(page.locator('video').first()).toBeVisible({ timeout: 60_000 });

        // Give any (wrongly) re-triggered fetch a moment to show up before
        // asserting its absence.
        await page.waitForTimeout(2_000);
        expect(
            controllerChunkRequests,
            'clicking Play re-fetched the video controller chunk instead of reusing the details-page warmup'
        ).toEqual(requestedBeforeClick);

        await stopWhateverStarted(page, config.itemId);
    });
});
