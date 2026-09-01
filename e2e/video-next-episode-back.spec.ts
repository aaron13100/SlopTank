import { VIDEO_ROUTE, expect, login, onScreenState, revealOsdControl, test, wakeOsd } from './fixtures';

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

async function startEpisodePlayback(page: import('@playwright/test').Page, config: {
    episodeId: string;
    serverId: string;
}) {
    await page.goto(`/web/details?id=${config.episodeId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    const video = page.locator('video').first();
    await expectPlaybackToAdvance(video, 20_000);
    await wakeOsd(page);
    return video;
}

async function fetchEpisode(page: import('@playwright/test').Page, episodeId: string) {
    return page.evaluate(async id => {
        const api = (window as unknown as {
            ApiClient: {
                getCurrentUserId(): string;
                getItem(userId: string, itemId: string): Promise<Record<string, unknown>>;
            };
        }).ApiClient;
        return api.getItem(api.getCurrentUserId(), id);
    }, episodeId);
}

test('Episodes opens a reachable series list and switches the playing episode', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();
    await login(page, config.username, config.password);
    const video = await startEpisodePlayback(page, { episodeId, serverId: config.serverId });

    const episodesButton = await revealOsdControl(page, '.videoOsdBottom-maincontrols .btnEpisodes');
    await episodesButton.click();
    await expect.poll(
        () => onScreenState(page, '.episodePlaybackMenu'),
        { message: 'expected the episode list to be fully on screen and reachable' }
    ).toMatchObject({ found: true, insideViewport: true, reachable: true });

    const rows = page.locator('.episodePlaybackMenu-item');
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    await expect(page.locator('.episodePlaybackMenu-item[aria-current="true"]')).toHaveCount(1);
    await expect(rows.first().locator('.episodePlaybackMenu-title')).not.toBeEmpty();
    await expect(rows.first().locator('.episodePlaybackMenu-summary')).not.toBeEmpty();
    await expect(rows.first().locator('.episodePlaybackMenu-watchedState')).not.toBeEmpty();
    await expect(rows.first().locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', /\d+/);

    const nextRow = page.locator('.episodePlaybackMenu-item:not([aria-current="true"])').first();
    const nextEpisodeId = await nextRow.getAttribute('data-item-id');
    expect(nextEpisodeId).toBeTruthy();
    await nextRow.click();

    await expect(page.locator('.episodePlaybackMenu')).toBeHidden();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(`id=${nextEpisodeId}`);
    await expectPlaybackToAdvance(video, 30_000);
});

test('Episodes fails closed with the server error visible when its series request fails', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();
    await login(page, config.username, config.password);
    await page.route(/\/Shows\/[^/]+\/Episodes\?.*Fields=Overview/i, route => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'episode catalogue unavailable' })
    }));

    await startEpisodePlayback(page, { episodeId, serverId: config.serverId });

    await expect(page.locator('.videoOsdBottom-maincontrols .btnEpisodes')).toBeHidden();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Could not load episodes', { timeout: 20_000 });
    await expect(toast).toContainText('500');
});

test('Episodes stays omitted when the series has only one playable episode', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();
    await login(page, config.username, config.password);
    const episode = await fetchEpisode(page, episodeId);
    const episodeResponse = page.waitForResponse(/\/Shows\/[^/]+\/Episodes\?.*fields=Overview/i);
    await page.route(/\/Shows\/[^/]+\/Episodes\?.*fields=Overview/i, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ Items: [ episode ], TotalRecordCount: 1 })
    }));

    await startEpisodePlayback(page, { episodeId, serverId: config.serverId });
    await episodeResponse;

    await expect(page.locator('.videoOsdBottom-maincontrols .btnEpisodes')).toBeHidden();
    await expect(page.locator('.episodePlaybackMenu-item')).toHaveCount(0);
});

// Regression coverage for the appRouter history fix (commit 5ec2da7e33):
// an in-player item change (next episode) must replace the /video history
// entry instead of pushing a new one, so Back exits to the page the player
// was launched from instead of stepping back through played episodes.
// @covers video.next_episode_back.next_episode.replaces_history_entry
test('next episode then Back exits the player instead of resuming the previous episode', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();

    await login(page, config.username, config.password);
    const episode = await fetchEpisode(page, episodeId);
    await page.goto(`/web/details?id=${episodeId}&serverId=${config.serverId}`);

    const playButton = page.locator('.mainDetailButtons .btnPlay:visible');
    await playButton.click();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });

    const video = page.locator('video').first();
    await expectPlaybackToAdvance(video, 20_000);

    // The player's own address, whatever spelling it currently holds. It
    // starts as /web/video?id=<episode> and canonicalizes in place to
    // /web/w/<permalink> at a time this test does not control, so what the
    // next-episode switch has to change is "the address", not "the id
    // parameter": pinning the spelling is what left this test asserting a
    // hash fragment the app stopped producing on 2026-08-03.
    const firstEpisodeUrl = page.url();
    const historyIdxDuringFirstEpisode = await page.evaluate(() => window.history.state?.idx);

    const nextTrackButton = await revealOsdControl(page, '.videoOsdBottom-maincontrols .btnNextTrack');
    await nextTrackButton.click();

    await expect
        .poll(() => page.url(), { timeout: 20_000 })
        .not.toBe(firstEpisodeUrl);
    expect(page.url()).toMatch(VIDEO_ROUTE);
    await expectPlaybackToAdvance(video, 20_000);

    // The in-place item change must replace the history entry, not push a
    // new one: the router's entry index stays the same across the transition.
    const historyIdxAfterNextTrack = await page.evaluate(() => window.history.state?.idx);
    expect(historyIdxAfterNextTrack).toBe(historyIdxDuringFirstEpisode);

    await page.goBack();

    // Back must land on the details page the player was launched from (the
    // replaced video entry means there is nothing to step back through), not
    // resume playback of either episode. Assert the rendered page rather than
    // the URL: the details page canonicalizes to a root permalink too, so its
    // address is no more stable than the player's, while the title it shows
    // is exactly what the user checks to know where Back took them.
    await expect
        .poll(() => page.url(), { timeout: 20_000 })
        .not.toMatch(VIDEO_ROUTE);
    await expect(page.locator('.nameContainer')).toContainText(episode.Name as string, { timeout: 20_000 });
    await expect(page.locator('video')).toHaveCount(0);
});

// Regression coverage for the same appRouter fix's other branch: back()
// falls back to goHome() when the current tab has no in-app history behind
// it, e.g. a permalink opened directly in a fresh tab. This exercises that
// fallback through the natural end-of-playback path (onPlaybackStopped ->
// appRouter.back()) instead of a manual Back press.
// @covers video.next_episode_back.playback_ends_no_next_item.exits_home
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
        // The legacy hash spelling deliberately: bridgeLegacyHashRoute
        // replaceState's it to /web/video?id= before the router boots, which
        // is the entry point a shared old link still arrives through, and it
        // is the one that reaches the player from a cold tab. Navigating
        // straight to /web/video?id= leaves the fresh tab with no <video> at
        // all, which is its own question and not this test's subject.
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
        await permalinkPage.waitForURL(/\/web\/home/, { timeout: 30_000 }).finally(async () => {
            await test.info().attach('browser-diagnostics', {
                body: browserDiagnostics.join('\n') || 'No browser warnings or errors.',
                contentType: 'text/plain'
            });
        });
    } finally {
        await permalinkPage.close();
    }
});
