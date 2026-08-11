import { expect } from '@playwright/test';

import { test, login, requireControlsItemId } from './fixtures';

test.setTimeout(180_000);

/**
 * The intersection nothing covered: the in-player Subtitles menu opened while
 * the address bar is already the canonical `/w/<permalink>`.
 *
 * `e2e/video-permalink.spec.ts` covers the canonicalization itself (the URL
 * arrives and the same <video> element survives it) and
 * `e2e/subtitle-track-selection.spec.ts` covers the Subtitles menu, but the
 * reported 2026-08-09 failure lived precisely where they meet: the router's
 * location and the browser's had silently diverged during canonicalization,
 * and opening the Subtitles menu was what made the router re-read
 * window.location, match the root `w/:permalinkId` route and unmount the
 * player. Either test alone stays green while that bug is present.
 *
 * The element stamp is the load-bearing assertion. "A video is visible" is
 * also true of a player that was destroyed and rebuilt, which is the
 * regression itself; a stamp read back off the same element is not.
 */

const WATCH_PERMALINK_ROUTE = /\/w\/(?:tt\d+|(?:tm|tv)-(?:mv|tv|ep|se|co)-\d+|sk-[0-9a-hjkmnp-tv-z]{26})(?:[?#]|$)/;

// @covers video.permalink.canonicalized_url_survives_subtitle_menu
test('the subtitle menu keeps the player mounted once the URL has canonicalized', async ({ page, config }) => {
    const itemId = requireControlsItemId();

    let documentLoads = 0;
    page.on('load', () => {
        documentLoads++;
    });

    await login(page, config.username, config.password);

    await page.goto(`/web/details?id=${itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay').click();

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 60_000 })
        .toBe(true);

    // The feature must actually be present before its interaction can be tested.
    // Failing here means canonicalization regressed, not the subtitle menu.
    await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 90_000 });

    await video.evaluate((el: HTMLVideoElement) => el.setAttribute('data-e2e-player-identity', 'canonicalized'));
    const loadsBefore = documentLoads;

    await page.mouse.move(20, 20);
    await page.mouse.move(100, 100);
    await page.locator('.btnSubtitles').click();
    await expect(page.locator('.actionSheetMenuItem').first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');

    await expect(video).toHaveAttribute('data-e2e-player-identity', 'canonicalized');
    expect(documentLoads - loadsBefore).toBe(0);
    expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);
    await expect(page).toHaveURL(WATCH_PERMALINK_ROUTE);
});
