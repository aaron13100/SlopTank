// SlopTank modification notice: added or changed by SlopTank on 2026-08-09, 2026-08-11, 2026-08-29, 2026-09-02, 2026-09-09.
import { expect } from '@playwright/test';

import { test, login, requireAssSubtitleItemId, clickOsdControl } from './fixtures';

// Playwright's default is 30s, which is under this file's own 60s playback
// polls -- the test budget expired before the assertion it was waiting on
// could resolve, reporting a timeout rather than a result. Every other player
// spec in e2e/ sets 120-300s for the same reason.
test.setTimeout(180_000);

/**
 * Regression coverage for the reported failure: picking a subtitle track from
 * the in-player Subtitles menu navigates the page and playback never returns.
 *
 * The subtitle appearance, positioning and sync specs cover the controls
 * (size, position, offset) and the "Off" entry, but nothing in the suite has
 * ever selected an actual subtitle TRACK from that menu. That is the gap this
 * file closes, so the test is written to fail while the bug is present.
 *
 * What the user sees is "the page reloads and then loads forever", so the
 * assertions are about survival rather than about subtitles rendering:
 * the document must not be torn down, the video element must still exist, and
 * the playhead must still advance afterwards.
 */

/**
 * Start playback of a specific item from its detail page, the way a user does.
 *
 * Deliberately does not assume a URL shape: root pretty URLs canonicalize
 * `/web/video` to `/web/w/<id>` mid-playback, so waiting on a particular
 * pathname would couple this regression test to the router's current scheme.
 *
 * @param page - The Playwright page.
 * @param config - Fixture config carrying the server id.
 * @param itemId - Library item to play.
 * @returns The player's video element locator.
 */
async function startPlayback(
    page: import('@playwright/test').Page,
    config: { serverId: string },
    itemId: string
) {
    await page.goto(`/web/#/details?id=${itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate(
            (el: HTMLVideoElement) => !el.paused && el.readyState >= 2
        ), { timeout: 60_000 })
        .toBe(true);
    return video;
}

/** Open the Subtitles menu the way a mouse user does. */
async function openSubtitleMenu(page: import('@playwright/test').Page) {
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
}

// @covers subtitle_controls.track_menu.selecting_a_track_keeps_playback_alive
test('choosing a subtitle track does not reload the page or kill playback', async ({ page, config }) => {
    const itemId = requireAssSubtitleItemId();

    // Count real document loads. A SPA track switch must produce none: the
    // reported symptom is the page visibly reloading, and that is a distinct
    // failure from playback merely stalling.
    let documentLoads = 0;
    page.on('load', () => {
        documentLoads++;
    });

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') {
            consoleErrors.push(message.text());
        }
    });
    page.on('pageerror', (error) => {
        consoleErrors.push(`pageerror: ${error.message}`);
    });

    await login(page, config.username, config.password);
    const video = await startPlayback(page, config, itemId);

    const loadsBeforeSelection = documentLoads;
    const urlBeforeSelection = page.url();
    const positionBeforeSelection = await video.evaluate((el: HTMLVideoElement) => el.currentTime);

    await openSubtitleMenu(page);
    await expect(page.locator('.actionSheetMenuItem').first()).toBeVisible();

    // Real tracks carry the stream index in `data-id`; the menu COMMANDS carry
    // string ids ("subtitlesize", "secondarysubtitle") and Off carries "-1".
    // Filtering on the text alone silently selects "Subtitle Appearance" and
    // makes this test pass without ever choosing a subtitle.
    const trackEntries = page.locator('.actionSheetMenuItem').filter({
        has: page.locator('xpath=self::*[number(@data-id) >= 0]')
    });
    const trackCount = await trackEntries.count();
    expect(trackCount, 'fixture item must expose at least one subtitle track').toBeGreaterThan(0);
    const chosenTrack = (await trackEntries.first().textContent())?.trim();
    const chosenIndex = await trackEntries.first().getAttribute('data-id');
    expect(Number(chosenIndex), 'selected entry must be a subtitle stream, not a menu command')
        .toBeGreaterThanOrEqual(0);
    await trackEntries.first().click();

    // 1. The document must not have been reloaded.
    await page.waitForTimeout(3_000);
    expect(documentLoads - loadsBeforeSelection,
        `page reloaded after selecting "${chosenTrack}" (url before: ${urlBeforeSelection}, after: ${page.url()})`
    ).toBe(0);

    // 2. The player must still be on screen. This is the "loads forever" half:
    //    the view is torn down and nothing replaces it.
    await expect(page.locator('video').first(),
        `video element vanished after selecting "${chosenTrack}"`
    ).toBeVisible({ timeout: 10_000 });

    // 3. The movie must still be running. A subtitle switch that silently
    //    restarts the stream and never recovers leaves the playhead frozen.
    await expect
        .poll(async () => page.locator('video').first().evaluate(
            (el: HTMLVideoElement) => el.currentTime
        ), { timeout: 30_000, message: `playback never resumed after selecting "${chosenTrack}"` })
        .toBeGreaterThan(positionBeforeSelection);

    expect(consoleErrors, 'console errors raised while switching subtitle track').toEqual([]);
});

// @covers subtitle_controls.track_menu.opening_the_menu_keeps_the_player_mounted
test('opening the subtitle menu does not unmount the player', async ({ page, config }) => {
    // The reported failure was not the track switch itself: merely opening the
    // Subtitles menu and picking Subtitle Appearance destroyed the view. The
    // address bar had been rewritten to the watch permalink behind React
    // Router's back with a raw history.replaceState, so the router's location
    // and the browser's disagreed; the first re-render matched the ROOT
    // `w/:permalinkId` route and unmounted the player. No document reload is
    // involved, which is why "it reloads the page" has to be measured as a
    // teardown rather than as a load event.
    let documentLoads = 0;
    page.on('load', () => {
        documentLoads++;
    });

    await login(page, config.username, config.password);

    await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate(
            (el: HTMLVideoElement) => !el.paused && el.readyState >= 2
        ), { timeout: 60_000 })
        .toBe(true);

    const loadsBefore = documentLoads;

    await openSubtitleMenu(page);
    await expect(page.locator('.actionSheetMenuItem').first()).toBeVisible();
    await page.getByText('Subtitle Appearance', { exact: true }).click();

    // The overlay is the point of the click, so assert it arrives...
    await expect(page.locator('.subtitleSizerContainer')).toBeVisible({ timeout: 15_000 });

    // ...and, more importantly, that the movie is still there behind it.
    const state = await page.evaluate(() => ({
        videos: document.querySelectorAll('video').length,
        osd: document.querySelectorAll('.videoOsdBottom').length
    }));
    expect(state, `player was unmounted; url is now ${page.url()}`)
        .toMatchObject({ videos: 1, osd: 1 });
    expect(documentLoads - loadsBefore, 'document reloaded').toBe(0);
});
