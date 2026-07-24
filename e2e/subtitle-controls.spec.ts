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

/**
 * Compare a screenshot containing a native browser cue with the exact same
 * paused video frame after subtitles are disabled. This measures composited
 * pixels -- not CSS assigned to an element that may not be the layer the user
 * actually sees.
 * @param page - Page used to decode the screenshots in a browser canvas.
 * @param withSubtitle - PNG screenshot with the native cue visible.
 * @param withoutSubtitle - PNG screenshot of the same paused frame without it.
 */
async function renderedSubtitlePixels(
    page: import('@playwright/test').Page,
    withSubtitle: Buffer,
    withoutSubtitle?: Buffer
) {
    return page.evaluate(async ([ subtitlePng, baselinePng ]) => {
        type ScreenshotPixels = {
            width: number;
            height: number;
            pixels: Uint8ClampedArray;
        };

        const decode = async (encoded: string) => {
            const response = await fetch(`data:image/png;base64,${encoded}`);
            const image = await createImageBitmap(await response.blob());
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Could not create screenshot comparison canvas'); // allow-raw-error: test setup fast-fail
            context.drawImage(image, 0, 0);
            return {
                width: image.width,
                height: image.height,
                pixels: context.getImageData(0, 0, image.width, image.height).data
            };
        };

        const createGlyphMask = (subtitle: ScreenshotPixels, baseline: ScreenshotPixels | null) => {
            const mask = new Uint8Array(subtitle.width * subtitle.height);
            for (let offset = 0; offset < subtitle.pixels.length; offset += 4) {
                const changedFromFrame = !baseline || Math.max(
                    Math.abs(subtitle.pixels[offset] - baseline.pixels[offset]),
                    Math.abs(subtitle.pixels[offset + 1] - baseline.pixels[offset + 1]),
                    Math.abs(subtitle.pixels[offset + 2] - baseline.pixels[offset + 2])
                ) > 64;
                const isSubtitleGlyph = Math.min(
                    subtitle.pixels[offset],
                    subtitle.pixels[offset + 1],
                    subtitle.pixels[offset + 2]
                ) > 190;
                // Paused hardware-decoded video frames can still vary between
                // compositor captures. Count only bright cue glyph pixels that
                // differ strongly from the subtitle-off frame, never the movie
                // image or the cue's translucent backdrop.
                if (changedFromFrame && isSubtitleGlyph) {
                    mask[offset / 4] = 1;
                }
            }
            return mask;
        };

        const measureComponent = (
            mask: Uint8Array,
            width: number,
            height: number,
            seed: number
        ) => {
            const neighbors = [
                [ -1, -1 ], [ 0, -1 ], [ 1, -1 ],
                [ -1, 0 ], [ 1, 0 ],
                [ -1, 1 ], [ 0, 1 ], [ 1, 1 ]
            ];
            const stack = [ seed ];
            mask[seed] = 0;
            let pixels = 0;
            let left = width;
            let top = height;
            let right = -1;
            let bottom = -1;
            while (stack.length) {
                const pixel = stack.pop()!;
                const x = pixel % width;
                const y = Math.floor(pixel / width);
                pixels++;
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);

                for (const [ dx, dy ] of neighbors) {
                    const nextX = x + dx;
                    const nextY = y + dy;
                    if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
                    const next = nextY * width + nextX;
                    if (!mask[next]) continue;
                    mask[next] = 0;
                    stack.push(next);
                }
            }
            return {
                pixels,
                width: right - left + 1,
                height: bottom - top + 1
            };
        };

        const measureMask = (mask: Uint8Array, width: number, height: number) => {
            let changedPixels = 0;
            let left = width;
            let top = height;
            let right = -1;
            let bottom = -1;
            let largestGlyph = { pixels: 0, width: 0, height: 0 };

            for (let seed = 0; seed < mask.length; seed++) {
                if (!mask[seed]) continue;
                const x = seed % width;
                const y = Math.floor(seed / width);
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);

                const component = measureComponent(mask, width, height, seed);
                changedPixels += component.pixels;
                if (component.pixels > largestGlyph.pixels) {
                    largestGlyph = component;
                }
            }

            return {
                changedPixels,
                width: right >= left ? right - left + 1 : 0,
                height: bottom >= top ? bottom - top + 1 : 0,
                largestGlyphPixels: largestGlyph.pixels,
                largestGlyphWidth: largestGlyph.width,
                largestGlyphHeight: largestGlyph.height
            };
        };

        const subtitle = await decode(subtitlePng);
        const baseline = baselinePng ? await decode(baselinePng) : null;
        if (baseline && (subtitle.width !== baseline.width || subtitle.height !== baseline.height)) {
            throw new Error('Subtitle screenshots have different dimensions'); // allow-raw-error: test setup fast-fail
        }

        const glyphMask = createGlyphMask(subtitle, baseline);
        return measureMask(glyphMask, subtitle.width, subtitle.height);
    }, [ withSubtitle.toString('base64'), withoutSubtitle?.toString('base64') ]);
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
test('subtitle size applies live to real rendered cues', async ({ page, config }, testInfo) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    // The default rendering path is the custom subtitle element; wait for a
    // real cue to render, then park on it.
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, subtitleLine);

    await openSizeOverlay(page);
    await dragSizeSliderTo(page, 0);
    const smallPng = await subtitleLine.screenshot();
    await dragSizeSliderTo(page, 1);
    const largePng = await subtitleLine.screenshot();
    await testInfo.attach('custom-cue-25.png', { body: smallPng, contentType: 'image/png' });
    await testInfo.attach('custom-cue-200.png', { body: largePng, contentType: 'image/png' });

    const small = await renderedSubtitlePixels(page, smallPng);
    const large = await renderedSubtitlePixels(page, largePng);
    expect(large.largestGlyphPixels).toBeGreaterThan(small.largestGlyphPixels * 2);
    expect(large.largestGlyphHeight).toBeGreaterThan(small.largestGlyphHeight * 2);

    await setSizeSlider(page, 100);
    await page.locator('.subtitleSizer-closeButton').click();
});

// @covers subtitle_controls.track_menu.sizer_applies_to_rendered_cues
test('subtitle size changes the pixels of a real native cue', async ({ page, config }, testInfo) => {
    await login(page, config.username, config.password);
    await page.evaluate(() => {
        const server = JSON.parse(localStorage.jellyfin_credentials).Servers[0];
        localStorage.setItem(`${server.UserId}-localplayersubtitleappearance3`, JSON.stringify({
            subtitleStyling: 'Native',
            textSize: '1',
            verticalPosition: -3
        }));
    });
    const video = await startPlayback(page, config);

    await openOsd(page);
    await page.locator('.videoOsdBottom-maincontrols .btnSubtitles').click();
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    await expect.poll(async () => video.evaluate(async (el: HTMLVideoElement, [target, window]) => {
        if (el.currentTime < target - 1 || el.currentTime > target + window) {
            el.currentTime = target;
        }
        if (el.paused) await el.play();
        return Array.from(el.textTracks).some(track => (track.activeCues?.length ?? 0) > 0);
    }, [ DIALOGUE_TIME, DIALOGUE_WINDOW ]), { timeout: 60_000 }).toBe(true);
    await video.evaluate((el: HTMLVideoElement) => el.pause());

    // Prove this is the missing native branch, not the custom element already
    // covered above.
    await expect(page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)')).toHaveCount(0);

    await openSizeOverlay(page);
    const videoBox = await video.boundingBox();
    if (!videoBox) throw new Error('video has no screenshot bounds'); // allow-raw-error: e2e setup fast-fail

    // Remove every player control from the captured pixels. The paused movie
    // frame then stays bit-identical; only the browser-composited cue can
    // differ between captures.
    await dragSizeSliderTo(page, 0);
    const mask = await page.addStyleTag({
        content: '.videoOsdBottom, .skinHeader, .subtitleSizer { visibility: hidden !important; }'
    });
    const smallPng = await page.screenshot({ clip: videoBox });
    const cueMaskCss = `video.htmlvideoplayer::cue {
        color: transparent !important;
        background-color: transparent !important;
        text-shadow: none !important;
    }`;
    const smallCueMask = await page.addStyleTag({ content: cueMaskCss });
    const smallBaselinePng = await page.screenshot({ clip: videoBox });
    await smallCueMask.evaluate(element => element.remove());
    await mask.evaluate(element => element.remove());
    await dragSizeSliderTo(page, 1);
    const largeMask = await page.addStyleTag({
        content: '.videoOsdBottom, .skinHeader, .subtitleSizer { visibility: hidden !important; }'
    });
    const largePng = await page.screenshot({ clip: videoBox });

    // Do not turn the embedded track off for either baseline: that can
    // reconfigure Direct Play and produce a different video frame. Hide only
    // the native glyphs at the SAME size as each comparison capture, leaving
    // the paused frame and the browser-sized cue backdrop untouched.
    const largeCueMask = await page.addStyleTag({ content: cueMaskCss });
    const largeBaselinePng = await page.screenshot({ clip: videoBox });
    await largeCueMask.evaluate(element => element.remove());
    await largeMask.evaluate(element => element.remove());
    await page.locator('.subtitleSizer-closeButton').click();
    await testInfo.attach('native-cue-25.png', { body: smallPng, contentType: 'image/png' });
    await testInfo.attach('native-cue-200.png', { body: largePng, contentType: 'image/png' });
    await testInfo.attach('native-cue-25-baseline.png', { body: smallBaselinePng, contentType: 'image/png' });
    await testInfo.attach('native-cue-200-baseline.png', { body: largeBaselinePng, contentType: 'image/png' });

    const small = await renderedSubtitlePixels(page, smallPng, smallBaselinePng);
    const large = await renderedSubtitlePixels(page, largePng, largeBaselinePng);
    await testInfo.attach('native-cue-raster-metrics.json', {
        body: Buffer.from(JSON.stringify({ small, large }, null, 2)),
        contentType: 'application/json'
    });

    // The assertion is deliberately on rasterized output. Reading
    // getComputedStyle(video, '::cue') or the preview element would reproduce
    // the false positive that allowed the user-visible bug through. Bright
    // core pixels do not scale quadratically because font antialiasing changes
    // across sizes, so combine a conservative area increase with a much
    // stronger physical-height assertion.
    expect(small.largestGlyphPixels).toBeGreaterThan(0);
    expect(large.largestGlyphPixels).toBeGreaterThan(small.largestGlyphPixels * 1.5);
    expect(large.largestGlyphHeight).toBeGreaterThan(small.largestGlyphHeight * 2);
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
