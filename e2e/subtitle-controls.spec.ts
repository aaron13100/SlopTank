import { expect, login, test } from './fixtures';

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

async function openSizeOverlay(page: import('@playwright/test').Page) {
    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.getByText('Subtitle Size', { exact: true }).click();
    await expect(page.locator('.subtitleSizerContainer')).toBeVisible();
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

test('subtitle size applies live to real rendered cues', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    // The default rendering path is the custom subtitle element; wait for a
    // real cue to render, then park on it.
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => {
            el.currentTime = 95; // inside known dialogue
            return true;
        }))
        .toBe(true);
    await video.evaluate((el: HTMLVideoElement) => el.pause());
    await expect(subtitleLine).toBeVisible({ timeout: 20_000 });
    await expect(subtitleLine).not.toBeEmpty();

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
    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnVideoOsdSettings').click();
    await offsetItem.click();
    await expect(page.locator('.subtitleSyncContainer')).toBeVisible();

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
