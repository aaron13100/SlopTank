import { expect, login, test } from './fixtures';

test.setTimeout(120_000);

/**
 * Requires E2E_EPISODE_ITEM_ID: a TV episode item id whose series has a
 * following episode, so the web client queues an "up next" playlist and
 * shows the OSD's Next Track control. Season 1 Episode 1 of any multi
 * episode series qualifies.
 */
function requireEpisodeItemId(): string {
    const value = process.env.E2E_EPISODE_ITEM_ID; // allow-direct-env: e2e config read, same pattern as fixtures.ts
    if (!value) {
        throw new Error( // allow-raw-error: test setup fast-fail, matching fixtures.ts convention
            'Missing required env var E2E_EPISODE_ITEM_ID. Set it to a TV episode '
            + 'whose series has a following episode, e.g. a season 1 episode 1.'
        );
    }
    return value;
}

async function expectPlaybackToAdvance(video: import('@playwright/test').Locator, timeout: number) {
    await expect(video).toBeVisible({ timeout });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout })
        .toBe(false);
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout })
        .toBeGreaterThanOrEqual(2);

    const initialTime = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout })
        .toBeGreaterThan(initialTime + 0.5);
}

// Regression coverage for the appRouter history fix (commit 5ec2da7e33):
// an in-player item change (next episode) must replace the /video history
// entry instead of pushing a new one, so Back exits to the page the player
// was launched from instead of stepping back through played episodes.
test('next episode then Back exits the player instead of resuming the previous episode', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();

    await login(page, config.username, config.password);
    await page.goto(`/web/#/details?id=${episodeId}&serverId=${config.serverId}`);

    const playButton = page.locator('.mainDetailButtons .btnPlay');
    await playButton.click();
    await page.waitForURL(/#\/video\?id=/, { timeout: 60_000 });

    const video = page.locator('video').first();
    await expectPlaybackToAdvance(video, 20_000);

    const firstEpisodeUrl = new URL(page.url());
    expect(firstEpisodeUrl.hash).toContain(`id=${episodeId}`);
    const historyIdxDuringFirstEpisode = await page.evaluate(() => window.history.state?.idx);

    // Reveal the OSD bottom controls; they auto-hide on inactivity, same as
    // every other OSD button this suite drives (see video-permalink.spec.ts).
    await page.mouse.move(20, 20);
    await page.mouse.move(100, 100);
    const nextTrackButton = page.locator('.videoOsdBottom-maincontrols .btnNextTrack');
    await expect(nextTrackButton).toBeVisible({ timeout: 20_000 });
    await nextTrackButton.click();

    // This is a hash router (createHashRouter): the /video?id=... route lives
    // in the URL's hash fragment, not its real pathname/search, so match it
    // as a string rather than through the WHATWG URL's path/query parsing
    // (see the existing convention in video-permalink.spec.ts).
    await expect
        .poll(() => page.url(), { timeout: 20_000 })
        .not.toContain(`id=${episodeId}`);
    expect(page.url()).toContain('#/video?id=');
    const nextEpisodeId = page.url().match(/#\/video\?id=([^&]+)/)?.[1];
    expect(nextEpisodeId).toBeTruthy();
    await expectPlaybackToAdvance(video, 20_000);

    // The in-place item change must replace the history entry, not push a
    // new one: the router's entry index stays the same across the transition.
    const historyIdxAfterNextTrack = await page.evaluate(() => window.history.state?.idx);
    expect(historyIdxAfterNextTrack).toBe(historyIdxDuringFirstEpisode);

    await page.goBack();

    // Back must land on the details page the player was launched from (the
    // replaced video entry means there is nothing to step back through), not
    // resume playback of either episode.
    await page.waitForURL(/#\/details\?id=/, { timeout: 20_000 });
    expect(page.url()).toContain(`id=${episodeId}`);
    expect(page.url()).not.toContain('/video');
});

// Regression coverage for the same appRouter fix's other branch: back()
// falls back to goHome() when the current tab has no in-app history behind
// it, e.g. a permalink opened directly in a fresh tab. This exercises that
// fallback through the natural end-of-playback path (onPlaybackStopped ->
// appRouter.back()) instead of a manual Back press.
test('a fresh-tab permalink exits to home when playback ends with no next item', async ({ page, context, config }) => {
    await login(page, config.username, config.password);

    const permalinkPage = await context.newPage();
    const browserDiagnostics: string[] = [];
    permalinkPage.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
            browserDiagnostics.push(`console.${message.type()}: ${message.text()}`);
        }
    });
    permalinkPage.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`));

    try {
        await permalinkPage.goto(`/web/#/video?id=${config.itemId}&serverId=${config.serverId}`);

        const video = permalinkPage.locator('video').first();
        await expectPlaybackToAdvance(video, 30_000);

        await expect
            .poll(() => video.evaluate((el: HTMLVideoElement) => el.duration), { timeout: 20_000 })
            .toBeGreaterThan(0);
        await video.evaluate((el: HTMLVideoElement) => {
            el.currentTime = Math.max(0, el.duration - 1);
        });

        // The app tears the player down (removing <video> from the DOM) as
        // soon as it treats playback as stopped, which races a direct
        // el.ended read. The URL transition to home is the durable,
        // user-visible signal that playback ended with no next item and
        // appRouter fell back to goHome() (no in-app history behind a
        // fresh-tab permalink).
        await permalinkPage.waitForURL(/#\/home/, { timeout: 30_000 }).finally(async () => {
            await test.info().attach('browser-diagnostics', {
                body: browserDiagnostics.join('\n') || 'No browser warnings or errors.',
                contentType: 'text/plain'
            });
        });
    } finally {
        await permalinkPage.close();
    }
});
