import {
    clickOsdControl,
    expect,
    login,
    onScreenState,
    parkOnCue,
    test,
    VIDEO_ROUTE
} from './fixtures';

test.setTimeout(180_000);

/** User-entry-point coverage for subtitle vertical anchoring independent of text size. */

async function startPlayback(page: import('@playwright/test').Page, config: { itemId: string, serverId: string }) {
    await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 30_000 })
        .toBe(true);
    return video;
}

/**
 * Assert a body-appended player overlay is not merely present but actually
 * pressable by a user.
 *
 * These overlays are opened from an action sheet, and that sheet leaves its
 * .dialogBackdrop in the DOM while it fades out: opacity 0, so nothing is
 * visible, but pointer-events: auto at z-index 999998, so it covers the whole
 * viewport and swallows presses. Reachability only means anything once the menu
 * has finished closing, so wait for that instead of racing it -- otherwise the
 * check reports whichever of the two won the scheduler on that run.
 * @param page - Page under test.
 * @param selector - Overlay container that must be reachable.
 */
async function expectOverlayReachable(page: import('@playwright/test').Page, selector: string) {
    await expect(page.locator('.dialogBackdrop')).toHaveCount(0);
    // toBeVisible() alone passed while the control was laid out below the fold
    // and no user could reach it; every open must land it on screen.
    expect(await onScreenState(page, selector)).toMatchObject({
        found: true, insideViewport: true, reachable: true
    });
}

async function openSizeOverlay(page: import('@playwright/test').Page) {
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.getByText('Subtitle Appearance', { exact: true }).click();
    await expect(page.locator('.subtitleSizerContainer')).toBeVisible();
    await expectOverlayReachable(page, '.subtitleSizerContainer');
}

async function setSizeSlider(page: import('@playwright/test').Page, percent: number) {
    await page.locator('.subtitleSizerSlider').evaluate((el: HTMLInputElement, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, percent);
}

// @covers subtitle_controls.track_menu.sizer_does_not_move_subtitle
test('changing the size resizes the subtitle in place instead of sliding it up the screen', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, subtitleLine);

    // Where the subtitle sits, and how big it is, are independent axes: the
    // size control must only change the second one. Measuring the anchored
    // bottom edge is what the user actually watches -- text grows upward from
    // where they put it.
    const box = () => subtitleLine.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
    });

    await openSizeOverlay(page);

    await setSizeSlider(page, 50);
    const small = await box();
    await setSizeSlider(page, 200);
    const large = await box();

    // The size axis works.
    expect(large.height).toBeGreaterThan(small.height * 2);
    // The position axis does not move with it. Vertical position was expressed
    // in em against the subtitle's own font-size, so quadrupling the size slid
    // the line ~150px up the screen: out of the letterbox bar at small sizes,
    // into the middle of the picture at large ones.
    expect(Math.abs(large.bottom - small.bottom)).toBeLessThanOrEqual(2);

    await setSizeSlider(page, 100);
    await page.locator('.subtitleSizer-closeButton').click();
});
