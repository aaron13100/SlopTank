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

/** User-entry-point coverage for subtitle offset discovery and paused-cue synchronization. */

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

/**
 * Drag the offset slider through its real pointer interaction.
 * @param page - Page under test.
 * @param seconds - Target subtitle offset in seconds.
 */
async function dragOffsetSliderTo(page: import('@playwright/test').Page, seconds: number) {
    const syncSlider = page.locator('.subtitleSyncSlider');
    const track = await syncSlider.boundingBox();
    if (!track) throw new Error('subtitle offset slider has no box to drag'); // allow-raw-error: e2e setup fast-fail
    const min = -30;
    const max = 30;
    const fraction = (seconds - min) / (max - min);
    const y = track.y + track.height / 2;
    await page.mouse.move(track.x + track.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * fraction, y, { steps: 10 });
    await page.mouse.up();
    const actual = await syncSlider.inputValue();
    expect(Math.abs(parseFloat(actual) - seconds)).toBeLessThanOrEqual(0.5);
}

// @covers subtitle_controls.track_menu.no_subtitle_enabled.offset_explains_itself
test('subtitle offset explains itself without a subtitle and shifts cues with one', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    // Playback can restore the user's last subtitle choice. Establish the
    // no-subtitle precondition through the same menu a user operates.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'Off' }).first().click();
    await expect(page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)')).toHaveCount(0);

    // Without an enabled subtitle the entry must exist and explain itself (it
    // used to be silently hidden).
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
    const offsetItem = page.locator('.actionSheetMenuItem', { hasText: 'Subtitle Offset' });
    await expect(offsetItem).toBeVisible();
    await offsetItem.click();
    await expect(page.locator('.toast')).toContainText('Turn on a subtitle track');
    await expect(page.locator('.subtitleSyncContainer')).toBeHidden();

    // Enable the external subtitle and park on a cue.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, subtitleLine);
    const textBefore = await subtitleLine.textContent();
    expect(textBefore).toBeTruthy();

    // Now the offset entry opens the overlay.
    // @covers subtitle_controls.track_menu.offset_shifts_displayed_cue
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
    await offsetItem.click();
    await expect(page.locator('.subtitleSyncContainer')).toBeVisible();
    // Same body-appended overlay shape as the size control: it must land on
    // screen, not wherever page flow happens to put it.
    await expectOverlayReachable(page, '.subtitleSyncContainer');

    // Shifting by +8s with a real mouse drag must change which cue text is
    // displayed at the paused position (subtitles appear earlier), and 0 must
    // restore it. No timeupdate is allowed to hide the paused-refresh bug.
    const timeUpdatesBeforeDrag = await video.evaluate((el: HTMLVideoElement) => {
        const state = { count: 0 };
        el.addEventListener('timeupdate', () => state.count++);
        Object.assign(el, { subtitleOffsetTestState: state });
        return state.count;
    });
    expect(timeUpdatesBeforeDrag).toBe(0);

    await dragOffsetSliderTo(page, 8);
    await expect.poll(async () => {
        const line = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
        if (await line.count() === 0) return null;
        return line.evaluate(el => el.classList.contains('hide') ? null : el.textContent);
    }, { timeout: 10_000 }).not.toBe(textBefore);
    await expect.poll(() => video.evaluate(
        (el: HTMLVideoElement & { subtitleOffsetTestState?: { count: number } }) =>
            el.subtitleOffsetTestState?.count
    )).toBe(0);

    await dragOffsetSliderTo(page, 0);
    await expect.poll(async () => subtitleLine.evaluate(
        el => el.classList.contains('hide') ? null : el.textContent
    ), { timeout: 10_000 }).toBe(textBefore);
});
