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

/** User-entry-point coverage for DOM, Native-preference, and Document PiP subtitle rendering. */

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

async function setSizeSlider(page: import('@playwright/test').Page, percent: number) {
    await page.locator('.subtitleSizerSlider').evaluate((el: HTMLInputElement, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, percent);
}

/**
 * Measure bright connected subtitle glyphs in a screenshot. This checks
 * composited pixels -- not CSS assigned to an element that may not be the
 * layer the user actually sees.
 * @param page - Page used to decode the screenshots in a browser canvas.
 * @param withSubtitle - PNG screenshot with the rendered cue visible.
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

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('Document PiP keeps custom subtitles and live appearance controls', async ({ page, config }, testInfo) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const documentPipSupported = await page.evaluate(
        () => typeof window.documentPictureInPicture?.requestWindow === 'function');
    expect(documentPipSupported).toBe(true);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, mainSubtitleLine);
    const cueText = await mainSubtitleLine.textContent();

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;

    const pipVideo = pipPage.locator('.videoPlayerContainer video');
    const pipSubtitleLine = pipPage.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await expect(pipVideo).toBeVisible();
    await expect.poll(() => pipVideo.evaluate((el: HTMLVideoElement) => el.controls))
        .toBe(true);
    await expect(pipSubtitleLine).toBeVisible();
    await expect(pipSubtitleLine).toHaveText(cueText || '');

    // Selecting a secondary track after the player has moved documents must
    // still find the shared subtitle container in the PiP document.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.getByText('Secondary Subtitles', { exact: true }).click();
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    const pipSecondaryLine = pipPage.locator('.videoSecondarySubtitlesInner');
    await expect(pipSecondaryLine).toBeVisible({ timeout: 30_000 });
    await expect(pipSecondaryLine).toHaveText(cueText || '');
    await expect.poll(async () => {
        const primary = await pipSubtitleLine.boundingBox();
        const secondary = await pipSecondaryLine.boundingBox();
        return !!primary && !!secondary
            && (primary.y + primary.height <= secondary.y
                || secondary.y + secondary.height <= primary.y);
    }).toBe(true);

    const initialFontSize = await pipSubtitleLine.evaluate(
        el => parseFloat(getComputedStyle(el).fontSize));
    await pipPage.locator('.documentPipSubtitleAppearanceButton').click();
    await expect(pipPage.locator('.subtitleSizerContainer')).toBeVisible();
    await expectOverlayReachable(pipPage, '.subtitleSizerContainer');
    await expect(pipPage.locator('.videoSubtitlesPreviewLine')).toBeHidden();

    await setSizeSlider(pipPage, 200);
    await expect.poll(() => pipSubtitleLine.evaluate(
        el => parseFloat(getComputedStyle(el).fontSize)))
        .toBeGreaterThan(initialFontSize * 1.5);

    await pipPage.locator('.subtitleFontSelect').selectOption('console');
    await pipPage.locator('.subtitleWeightSelect').selectOption('bold');
    await expect.poll(() => pipSubtitleLine.evaluate(el => ({
        family: getComputedStyle(el).fontFamily,
        weight: getComputedStyle(el).fontWeight
    }))).toMatchObject({
        family: expect.stringContaining('Consolas'),
        weight: '700'
    });
    await testInfo.attach('document-pip-subtitle-appearance.png', {
        body: await pipPage.screenshot(),
        contentType: 'image/png'
    });

    await setSizeSlider(pipPage, 100);
    await pipPage.locator('.subtitleFontSelect').selectOption('');
    await pipPage.locator('.subtitleWeightSelect').selectOption('normal');
    await pipPage.locator('.subtitleSizer-closeButton').click();
    await pipPage.close();

    await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
});

// @covers subtitle_controls.track_menu.sizer_applies_to_rendered_cues
test('subtitle size applies live to real rendered cues', async ({ page, config }, testInfo) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    // The default rendering path is the custom subtitle element; wait for a
    // real cue to render, then park on it.
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, subtitleLine);
    await video.evaluate((el: HTMLVideoElement) => el.pause());

    await openSizeOverlay(page);
    const cueIsolation = await page.addStyleTag({
        content: '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine) { background: #000 !important; }'
    });
    await dragSizeSliderTo(page, 0);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('25');
    const smallPng = await subtitleLine.screenshot();
    await dragSizeSliderTo(page, 1);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('200');
    const largePng = await subtitleLine.screenshot();
    await cueIsolation.evaluate(element => element.remove());
    await testInfo.attach('custom-cue-25.png', { body: smallPng, contentType: 'image/png' });
    await testInfo.attach('custom-cue-200.png', { body: largePng, contentType: 'image/png' });

    const small = await renderedSubtitlePixels(page, smallPng);
    const large = await renderedSubtitlePixels(page, largePng);
    expect(large.largestGlyphPixels).toBeGreaterThan(small.largestGlyphPixels * 2);
    expect(large.largestGlyphHeight).toBeGreaterThan(small.largestGlyphHeight * 2);

    await setSizeSlider(page, 100);
    await page.locator('.subtitleSizer-closeButton').click();
});

// @covers subtitle_controls.track_menu.native_preference_uses_controllable_renderer
test('a saved Native preference still produces a resizable real cue', async ({ page, config }, testInfo) => {
    await login(page, config.username, config.password);
    let legacyCueCount = 0;
    await page.route('**/Subtitles/**/Stream.js?*', async route => {
        const response = await route.fetch();
        const payload = await response.json() as {
            TrackEvents?: Array<{ Text?: string } & Record<string, unknown>>
        };
        const markedEvents = payload.TrackEvents?.map(event => {
            if (!event.Text) return event;
            legacyCueCount++;
            return { ...event, Text: `<font size="24">${event.Text}</font>` };
        });
        await route.fulfill({
            response,
            json: { ...payload, TrackEvents: markedEvents }
        });
    });
    await page.evaluate(() => {
        const server = JSON.parse(localStorage.jellyfin_credentials).Servers[0];
        localStorage.setItem(`${server.UserId}-localplayersubtitleappearance3`, JSON.stringify({
            subtitleStyling: 'Native',
            textSize: '1',
            verticalPosition: -5
        }));
    });
    const video = await startPlayback(page, config);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    // Browser-native caption compositors do not consistently honor live
    // font-size changes. Prove that an old Native preference still selects
    // the controllable element for the actual embedded subtitle track.
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, subtitleLine);
    // Feed the same legacy markup that exposed the user bug through the real
    // subtitle fetch and renderer: the placeholder resized, while
    // <font size="24"> kept the real cue fixed.
    expect(legacyCueCount).toBeGreaterThan(0);
    await expect(subtitleLine.locator('font[size]')).not.toHaveCount(0);
    await video.evaluate((el: HTMLVideoElement) => el.pause());

    await openSizeOverlay(page);
    const cueIsolation = await page.addStyleTag({
        content: '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine) { background: #000 !important; }'
    });
    await dragSizeSliderTo(page, 0);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('25');
    const smallPng = await subtitleLine.screenshot();
    await dragSizeSliderTo(page, 1);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('200');
    const largePng = await subtitleLine.screenshot();
    await cueIsolation.evaluate(element => element.remove());
    await testInfo.attach('saved-native-cue-25.png', { body: smallPng, contentType: 'image/png' });
    await testInfo.attach('saved-native-cue-200.png', { body: largePng, contentType: 'image/png' });

    const small = await renderedSubtitlePixels(page, smallPng);
    const large = await renderedSubtitlePixels(page, largePng);
    expect(large.largestGlyphPixels).toBeGreaterThan(small.largestGlyphPixels * 2);
    expect(large.largestGlyphHeight).toBeGreaterThan(small.largestGlyphHeight * 2);
});
