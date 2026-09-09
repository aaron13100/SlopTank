// SlopTank modification notice: added or changed by SlopTank on 2026-08-29, 2026-09-02, 2026-09-09.
import {
    clickOsdControl,
    expect,
    login,
    onScreenState,
    test,
    VIDEO_ROUTE
} from './fixtures';

test.setTimeout(180_000);

/** User-entry-point coverage for subtitle appearance controls and persistence. */

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

async function setPositionSlider(page: import('@playwright/test').Page, position: number) {
    await page.locator('.subtitlePositionSlider').evaluate((el: HTMLInputElement, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, position);
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

// @covers subtitle_controls.track_menu.sizer_is_on_screen_and_draggable
test('the TV remote can open, adjust, and close the size control', async ({ page, config }) => {
    await page.addInitScript(() => localStorage.setItem('layout', 'tv'));
    await login(page, config.username, config.password);
    await startPlayback(page, config);

    await expect(page.locator('html')).toHaveClass(/layout-tv/);
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.classList.contains('btnPause')
    )).toBe(true);

    // A TV remote starts on the player's focused pause button. Navigate to
    // Subtitles, then move from the selected track to Subtitle Appearance.
    for (let press = 0; press < 3; press++) {
        await page.keyboard.press('ArrowRight');
    }
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.classList.contains('btnSubtitles')
    )).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('.actionSheetMenuItem').first()).toBeVisible();
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.classList.contains('actionSheetMenuItem')
    )).toBe(true);

    for (let press = 0; press < 10; press++) {
        const focusedText = await page.evaluate(
            () => document.activeElement?.textContent?.trim());
        if (focusedText === 'Subtitle Appearance') break;
        await page.keyboard.press('ArrowUp');
    }
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.textContent?.trim()
    )).toBe('Subtitle Appearance');
    await page.keyboard.press('Enter');
    await expect(page.locator('.subtitleSizerContainer')).toBeVisible();
    await expectOverlayReachable(page, '.subtitleSizerContainer');

    // Only remote keys from here: focus the range control through the app's
    // spatial navigation, adjust it, and observe the rendered preview grow.
    for (let press = 0; press < 10; press++) {
        const sliderFocused = await page.evaluate(
            () => document.activeElement?.classList.contains('subtitleSizerSlider'));
        if (sliderFocused) break;
        await page.keyboard.press('ArrowUp');
    }
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.classList.contains('subtitleSizerSlider')
    )).toBe(true);

    const slider = page.locator('.subtitleSizerSlider');
    const beforeValue = Number(await slider.inputValue());
    const maxValue = Number(await slider.getAttribute('max'));
    const beforeFontSize = await sampleLineFontSize(page);
    const adjustKey = beforeValue < maxValue ? 'ArrowRight' : 'ArrowLeft';
    const restoreKey = adjustKey === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    const adjustedValue = beforeValue + (adjustKey === 'ArrowRight' ? 5 : -5);
    await page.keyboard.press(adjustKey);
    await expect(slider).toHaveValue(String(adjustedValue));
    if (adjustKey === 'ArrowRight') {
        await expect.poll(() => sampleLineFontSize(page)).toBeGreaterThan(beforeFontSize);
    } else {
        await expect.poll(() => sampleLineFontSize(page)).toBeLessThan(beforeFontSize);
    }
    await page.keyboard.press(restoreKey);
    await expect(slider).toHaveValue(String(beforeValue));
    await page.keyboard.press('Enter');

    // The close button is part of the same remote focus graph.
    for (let press = 0; press < 10; press++) {
        const closeFocused = await page.evaluate(
            () => document.activeElement?.classList.contains('subtitleSizer-closeButton'));
        if (closeFocused) break;
        await page.keyboard.press('ArrowUp');
    }
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.classList.contains('subtitleSizer-closeButton')
    )).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('.subtitleSizerContainer')).toHaveCount(0);
    await expect(page.locator('.videoSubtitlesPreviewLine')).toHaveCount(0);
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
    const panel = await page.locator('.subtitleSizerContainer').boundingBox();
    if (!panel) throw new Error('subtitle appearance panel has no box'); // allow-raw-error: e2e setup fast-fail
    await page.mouse.click(Math.max(10, panel.x / 2), panel.y + panel.height / 2);
    await expect(sampleLine).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);

    // 3. The reported flow: open the size control, then turn subtitles off.
    //    Nothing about subtitles may be left on screen afterwards.
    await openSizeOverlay(page);
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'Off' }).first().click();
    await expect(sampleLine).toHaveCount(0);
    await expect(page.locator('.videoSubtitlesInner')).toHaveCount(0);
});

// @covers subtitle_controls.track_menu.open_sizer.live_preview_persists
test('subtitle appearance controls preview live and persist without weakening size behavior', async ({ page, config }) => {
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

    await setSizeSlider(page, 100);
    await setPositionSlider(page, -20);
    const videoBox = await video.boundingBox();
    const topPreviewBox = await previewLine.boundingBox();
    if (!videoBox || !topPreviewBox) {
        throw new Error('video or subtitle preview has no box'); // allow-raw-error: e2e assertion setup
    }
    const visiblePreviewHeight = Math.min(
        topPreviewBox.y + topPreviewBox.height,
        videoBox.y + videoBox.height
    ) - Math.max(topPreviewBox.y, videoBox.y);
    expect(topPreviewBox.y).toBeLessThan(videoBox.y);
    expect(topPreviewBox.y + topPreviewBox.height).toBeGreaterThan(videoBox.y);
    expect(visiblePreviewHeight / topPreviewBox.height).toBeGreaterThan(0.4);
    expect(visiblePreviewHeight / topPreviewBox.height).toBeLessThan(0.6);

    await setSizeSlider(page, 25);
    await setPositionSlider(page, -5);
    const bottomBeforePositionChange = await previewLine.evaluate(
        el => Math.round(el.getBoundingClientRect().bottom));
    await setPositionSlider(page, -8);
    await expect.poll(() => previewLine.evaluate(
        el => Math.round(el.getBoundingClientRect().bottom)))
        .toBeLessThan(bottomBeforePositionChange);

    await page.locator('.subtitleFontSelect').selectOption('console');
    await expect.poll(() => previewLine.evaluate(
        el => getComputedStyle(el).fontFamily))
        .toContain('Consolas');

    await page.locator('.subtitleWeightSelect').selectOption('bold');
    await expect.poll(() => previewLine.evaluate(
        el => getComputedStyle(el).fontWeight))
        .toBe('700');

    // Closing removes the sample line and ends the preview.
    await page.locator('.subtitleSizer-closeButton').click();
    await expect(previewLine).toHaveCount(0);

    // The choice persisted: reopening shows the slider at 25%.
    await openSizeOverlay(page);
    await expect(page.locator('.subtitleSizerValue')).toHaveText('25%');
    await expect(page.locator('.subtitlePositionSlider')).toHaveValue('-8');
    await expect(page.locator('.subtitleFontSelect')).toHaveValue('console');
    await expect(page.locator('.subtitleWeightSelect')).toHaveValue('bold');
    await setSizeSlider(page, 100);
    await setPositionSlider(page, -5);
    await page.locator('.subtitleFontSelect').selectOption('');
    await page.locator('.subtitleWeightSelect').selectOption('normal');
    await page.locator('.subtitleSizer-closeButton').click();
});
