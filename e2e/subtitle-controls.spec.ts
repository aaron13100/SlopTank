import { expect, login, onScreenState, test } from './fixtures';

test.setTimeout(180_000);

/**
 * Real-browser regression coverage for the in-player subtitle controls:
 *   - the size slider changes the RENDERED subtitle size live (measured
 *     element font-size, not style plumbing) and previews a sample line when
 *     no subtitle/cue is on screen;
 *   - the chosen size persists across reopening the control;
 *   - the subtitle offset entry stays visible without an enabled subtitle
 *     and explains itself instead of silently doing nothing;
 *   - with an enabled subtitle the offset overlay opens and actually shifts
 *     which cue text is displayed.
 */

async function startPlayback(page: import('@playwright/test').Page, config: { itemId: string, serverId: string }) {
    await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay').click();
    await page.waitForURL(/#\/video\?id=/, { timeout: 60_000 });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 30_000 })
        .toBe(true);
    return video;
}

async function openOsd(page: import('@playwright/test').Page) {
    await page.mouse.move(20, 20);
    await page.mouse.move(100, 100);
}

/** Playback position, in seconds, known to sit inside spoken dialogue. */
const DIALOGUE_TIME = 95;

/** Seconds after DIALOGUE_TIME still expected to contain dialogue. */
const DIALOGUE_WINDOW = 20;

/**
 * Park playback on a rendered subtitle cue and hold it there.
 *
 * Two separate races have to be beaten, and both produce the same misleading
 * symptom -- the cue element present but empty, so `toBeVisible()` reports
 * hidden:
 *   1. a `currentTime` write issued while the player is still starting up is
 *      silently discarded, leaving the playhead at 0 where nothing is spoken;
 *   2. pausing immediately after a seek that DID land freezes the player before
 *      it has decoded the new position or run the subtitle renderer for it, so
 *      the cue text never arrives and never will -- the renderer updates on
 *      timeupdate, which a paused element stops firing.
 * So: keep the playhead inside the dialogue window, keep it playing, and only
 * pause once real text is actually on screen.
 * @param video - The player's video element.
 * @param subtitleLine - The rendered (non-preview) subtitle text element.
 */
async function parkOnCue(
    video: import('@playwright/test').Locator,
    subtitleLine: import('@playwright/test').Locator
) {
    await expect
        .poll(async () => {
            const position = await video.evaluate(async (el: HTMLVideoElement, [target, window]) => {
                // Re-seek only when outside the window, so normal playback
                // through the dialogue is not yanked back to the start of it.
                if (el.currentTime < target - 1 || el.currentTime > target + window) {
                    el.currentTime = target;
                }
                if (el.paused) await el.play();
                return el.currentTime;
            }, [ DIALOGUE_TIME, DIALOGUE_WINDOW ]);
            const text = (await subtitleLine.textContent()) ?? '';
            return position >= DIALOGUE_TIME - 1 && text.trim().length > 0;
        }, { timeout: 60_000 })
        .toBe(true);
    await video.evaluate((el: HTMLVideoElement) => el.pause());
    await expect(subtitleLine).toBeVisible({ timeout: 10_000 });
    await expect(subtitleLine).not.toBeEmpty();
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
    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.getByText('Subtitle Size', { exact: true }).click();
    await expect(page.locator('.subtitleSizerContainer')).toBeVisible();
    await expectOverlayReachable(page, '.subtitleSizerContainer');
}

/**
 * Drag the size slider with a real mouse press, the way a user does, rather
 * than dispatching input events at the element.
 * @param page - Page under test.
 * @param fraction - Target position along the slider track, 0 to 1.
 */
async function dragSizeSliderTo(page: import('@playwright/test').Page, fraction: number) {
    const track = await page.locator('.subtitleSizerSlider').boundingBox();
    if (!track) throw new Error('subtitle size slider has no box to drag'); // allow-raw-error: e2e setup fast-fail, not production code
    const y = track.y + track.height / 2;
    await page.mouse.move(track.x + track.width * 0.5, y);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * fraction, y, { steps: 10 });
    await page.mouse.up();
}

function sampleLineFontSize(page: import('@playwright/test').Page) {
    return page.locator('.videoSubtitlesPreviewLine').evaluate(
        el => parseFloat(getComputedStyle(el).fontSize));
}

async function setSizeSlider(page: import('@playwright/test').Page, percent: number) {
    await page.locator('.subtitleSizerSlider').evaluate((el: HTMLInputElement, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, percent);
}

function previewFontSize(page: import('@playwright/test').Page) {
    return page.locator('.videoSubtitlesPreviewLine').evaluate(
        el => parseFloat(getComputedStyle(el).fontSize));
}

// @covers subtitle_controls.track_menu.sizer_is_on_screen_and_draggable
test('the size control lands on screen and a real drag resizes what is shown', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await startPlayback(page, config);

    await openSizeOverlay(page);

    // The user must be able to press the slider itself, not just have it exist.
    expect(await onScreenState(page, '.subtitleSizerSlider')).toMatchObject({
        found: true, insideViewport: true, reachable: true
    });

    // The control must not sit on top of the sample it is there to preview.
    const overlap = await page.evaluate(() => {
        const panel = document.querySelector('.subtitleSizerContainer')?.getBoundingClientRect();
        const sample = document.querySelector('.videoSubtitlesPreviewLine')?.getBoundingClientRect();
        if (!panel || !sample) return null;
        return !(panel.bottom <= sample.top || panel.top >= sample.bottom);
    });
    expect(overlap).toBe(false);

    const before = await sampleLineFontSize(page);
    await dragSizeSliderTo(page, 1);
    await expect.poll(() => sampleLineFontSize(page)).toBeGreaterThan(before);

    await dragSizeSliderTo(page, 0);
    await expect.poll(() => sampleLineFontSize(page)).toBeLessThan(before);
});

// @covers subtitle_controls.track_menu.sizer_dismissal_clears_sample_line
test('the sample line goes away however the user dismisses the size control', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const sampleLine = page.locator('.videoSubtitlesPreviewLine');

    // 1. Escape closes it and takes the sample line with it.
    await openSizeOverlay(page);
    await expect(sampleLine).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sampleLine).toHaveCount(0);
    await expect(page.locator('.subtitleSizerContainer')).toHaveCount(0);

    // 2. Pressing the video dismisses it -- and must not also pause the movie,
    //    since dismissing was the whole point of the press.
    await openSizeOverlay(page);
    const viewport = page.viewportSize()!;
    await page.mouse.click(viewport.width / 2, viewport.height * 0.3);
    await expect(sampleLine).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);

    // 3. The reported flow: open the size control, then turn subtitles off.
    //    Nothing about subtitles may be left on screen afterwards.
    await openSizeOverlay(page);
    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.locator('.actionSheetMenuItem', { hasText: 'Off' }).first().click();
    await expect(sampleLine).toHaveCount(0);
    await expect(page.locator('.videoSubtitlesInner')).toHaveCount(0);
});

// @covers subtitle_controls.track_menu.open_sizer.live_preview_persists
test('subtitle size slider previews live at the subtitle position and persists', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    // No subtitle track is enabled: opening the size control must still show
    // a sample line where subtitles appear -- that IS the requested feature.
    await openSizeOverlay(page);
    const previewLine = page.locator('.videoSubtitlesPreviewLine');
    await expect(previewLine).toBeVisible();
    await expect(previewLine).not.toBeEmpty();

    const videoHeight = await video.evaluate((el: HTMLVideoElement) => el.getBoundingClientRect().height);
    const baseline = videoHeight * 0.045;

    await setSizeSlider(page, 200);
    await expect.poll(() => previewFontSize(page)).toBeCloseTo(baseline * 2, 0);

    await setSizeSlider(page, 25);
    await expect.poll(() => previewFontSize(page)).toBeCloseTo(baseline * 0.25, 0);

    // Closing removes the sample line and ends the preview.
    await page.locator('.subtitleSizer-closeButton').click();
    await expect(previewLine).toHaveCount(0);

    // The choice persisted: reopening shows the slider at 25%.
    await openSizeOverlay(page);
    await expect(page.locator('.subtitleSizerValue')).toHaveText('25%');
    await setSizeSlider(page, 100);
    await page.locator('.subtitleSizer-closeButton').click();
});

// @covers subtitle_controls.track_menu.sizer_applies_to_rendered_cues
test('subtitle size applies live to real rendered cues', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    // The default rendering path is the custom subtitle element; wait for a
    // real cue to render, then park on it.
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, subtitleLine);

    const measure = () => subtitleLine.evaluate(el => parseFloat(getComputedStyle(el).fontSize));

    await openSizeOverlay(page);
    await setSizeSlider(page, 200);
    const sizeAt200 = await measure();
    await setSizeSlider(page, 50);
    const sizeAt50 = await measure();
    expect(sizeAt200 / sizeAt50).toBeCloseTo(4, 0);

    await setSizeSlider(page, 100);
    await page.locator('.subtitleSizer-closeButton').click();
});

// @covers subtitle_controls.track_menu.sizer_does_not_move_subtitle
test('changing the size resizes the subtitle in place instead of sliding it up the screen', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
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

// @covers subtitle_controls.track_menu.no_subtitle_enabled.offset_explains_itself
test('subtitle offset explains itself without a subtitle and shifts cues with one', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    // Without an enabled subtitle the entry must exist and explain itself
    // (it used to be silently hidden).
    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnVideoOsdSettings').click();
    const offsetItem = page.locator('.actionSheetMenuItem', { hasText: 'Subtitle Offset' });
    await expect(offsetItem).toBeVisible();
    await offsetItem.click();
    await expect(page.locator('.toast')).toContainText('Turn on a subtitle track');
    await expect(page.locator('.subtitleSyncContainer')).toBeHidden();

    // Enable the external subtitle and park on a cue.
    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await video.evaluate((el: HTMLVideoElement) => {
        el.currentTime = 95;
        el.pause();
    });
    await expect(subtitleLine).toBeVisible({ timeout: 20_000 });
    const textBefore = await subtitleLine.textContent();
    expect(textBefore).toBeTruthy();

    // Now the offset entry opens the overlay.
    // @covers subtitle_controls.track_menu.offset_shifts_displayed_cue
    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnVideoOsdSettings').click();
    await offsetItem.click();
    await expect(page.locator('.subtitleSyncContainer')).toBeVisible();
    // Same body-appended overlay shape as the size control: it must land on
    // screen, not wherever page flow happens to put it.
    await expectOverlayReachable(page, '.subtitleSyncContainer');

    // Shifting by +8s must change which cue text is displayed at the paused
    // position (subtitles appear earlier), and 0 must restore it.
    const syncSlider = page.locator('.subtitleSyncSlider');
    await syncSlider.evaluate((el: HTMLInputElement) => {
        el.value = '8';
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(async () => {
        const line = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
        if (await line.count() === 0) return null;
        return line.evaluate(el => el.classList.contains('hide') ? null : el.textContent);
    }, { timeout: 10_000 }).not.toBe(textBefore);

    await syncSlider.evaluate((el: HTMLInputElement) => {
        el.value = '0';
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(async () => subtitleLine.evaluate(
        el => el.classList.contains('hide') ? null : el.textContent
    ), { timeout: 10_000 }).toBe(textBefore);
});
