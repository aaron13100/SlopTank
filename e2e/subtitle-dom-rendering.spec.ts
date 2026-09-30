// SlopTank modification notice: added or changed by SlopTank on 2026-08-29, 2026-09-02, 2026-09-09, 2026-09-27, 2026-09-30.
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

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('Document PiP subtitle appearance close button stays transparent over the dark panel', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, mainSubtitleLine);

    await openSizeOverlay(page);
    const normalCloseBackground = await page.locator('.subtitleSizer-closeButton')
        .evaluate(button => getComputedStyle(button).backgroundColor);
    expect(normalCloseBackground).toBe('rgba(0, 0, 0, 0)');
    await page.keyboard.press('Escape');

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;
    await pipPage.locator('.documentPipSubtitleAppearanceButton').click();

    const closeButton = pipPage.locator('.subtitleSizer-closeButton');
    await expect(closeButton).toBeVisible();
    const closeStyle = await closeButton.evaluate(button => ({
        background: getComputedStyle(button).backgroundColor,
        classes: button.className
    }));

    expect(closeStyle.classes.split(/\s+/)).toContain('paper-icon-button-light');
    expect(closeStyle.background).toBe('rgba(0, 0, 0, 0)');
});

/**
 * Sample the PiP close button's computed styling for one interaction state.
 *
 * The pass condition is the one the owner actually saw broken: an isolated
 * LIGHT background square on the dark panel. Any background that composites
 * with the panel (rgba(28, 28, 28, 0.8) over black) to a light color fails,
 * and so does an icon too dark to read, so the assertion covers themed
 * hover/focus/active tints while rejecting the UA-default button face the
 * missing class used to produce.
 *
 * @param pipPage - Page for the Document PiP window.
 * @returns Computed-state facts for the close button.
 */
async function readCloseButtonState(pipPage: import('@playwright/test').Page) {
    return pipPage.locator('.subtitleSizer-closeButton').evaluate(button => {
        type Rgba = { r: number, g: number, b: number, a: number };
        const parseColor = (value: string): Rgba | null => {
            const match = value.match(/rgba?\(([^)]+)\)/);
            if (!match) return null;
            const parts = match[1].split(',').map(Number);
            return {
                r: parts[0], g: parts[1], b: parts[2],
                a: parts.length > 3 ? parts[3] : 1
            };
        };
        const luminance = (color: Rgba | null) => {
            if (!color) return null;
            return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
        };
        const rawBackground = getComputedStyle(button).backgroundColor;
        const background = parseColor(rawBackground);
        // Composite the button background over the dark panel color.
        let compositeMaxChannel: number | null = null;
        if (background) {
            compositeMaxChannel = background.a * Math.max(background.r, background.g, background.b)
                + (1 - background.a) * 28;
        }
        const icon = button.querySelector('.material-icons');
        const iconColor = icon ? parseColor(getComputedStyle(icon).color) : null;
        return {
            rawBackground,
            backgroundCompositesLight: compositeMaxChannel !== null && compositeMaxChannel > 96,
            iconLuminance: luminance(iconColor)
        };
    });
}

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('Document PiP close button interaction states keep a dark background and visible icon', async ({ page, config }, testInfo) => {
    test.setTimeout(240_000);
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, mainSubtitleLine);

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;
    await pipPage.locator('.documentPipSubtitleAppearanceButton').click();
    const closeButton = pipPage.locator('.subtitleSizer-closeButton');
    await expect(closeButton).toBeVisible();

    const states: Record<string, unknown> = {};
    const assertState = async (label: string) => {
        const state = await readCloseButtonState(pipPage);
        states[label] = state;
        expect(state.backgroundCompositesLight, `${label} background ${state.rawBackground}`)
            .toBe(false);
        expect(state.iconLuminance, `${label} icon luminance`).toBeGreaterThanOrEqual(0.35);
    };

    await assertState('rest');

    await closeButton.hover();
    await assertState('hover');

    // Keyboard focus, the way a user gets it: Tab into the panel until the
    // close button itself is the focused element.
    await pipPage.locator('.subtitleSizerContainer').click({ position: { x: 12, y: 70 } });
    let focused = false;
    for (let attempt = 0; attempt < 8 && !focused; attempt++) {
        await pipPage.keyboard.press('Tab');
        focused = await pipPage.evaluate(() =>
            document.activeElement?.classList.contains('subtitleSizer-closeButton') ?? false);
    }
    expect(focused, 'Tab navigation must reach the close button').toBe(true);
    await assertState('keyboardFocus');

    // :active needs a held press; release off the button so the press never
    // completes a click that would close the overlay mid-assertion.
    const box = await closeButton.boundingBox();
    if (!box) throw new Error('close button has no box'); // allow-raw-error: e2e setup fast-fail, not production code
    await pipPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pipPage.mouse.down();
    await assertState('active');
    await pipPage.mouse.move(box.x - 40, box.y + box.height + 40);
    await pipPage.mouse.up();

    await testInfo.attach('pip-close-button-states.json', {
        body: JSON.stringify(states, null, 2),
        contentType: 'application/json'
    });
    await pipPage.close();
});

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('Document PiP appearance panel upgrades its sliders and selects like the main panel', async ({ page, config }, testInfo) => {
    test.setTimeout(240_000);
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, mainSubtitleLine);

    // The main-window panel is the design reference: the same template,
    // upgraded by the main document's custom-element registry.
    await openSizeOverlay(page);
    const mainPanel = await page.locator('.subtitleSizer').evaluate(panel => {
        const slider = panel.querySelector('.subtitleSizerSlider') as HTMLInputElement;
        const select = panel.querySelector('.subtitleFontSelect') as HTMLSelectElement;
        const lower = slider.parentElement?.querySelector<HTMLElement>('.mdl-slider-background-lower');
        return {
            sliderClasses: slider.className,
            sliderFillWidth: lower?.style.width ?? '(none)',
            selectClasses: select.className,
            selectBackground: getComputedStyle(select).backgroundColor,
            selectLabels: Array.from(panel.querySelectorAll('.subtitleSizerSelectGrid .selectLabel'))
                .map(label => (label.textContent || '').trim()),
            selectArrows: panel.querySelectorAll('.subtitleSizerSelectGrid .selectArrowContainer').length
        };
    });
    await page.keyboard.press('Escape');

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;
    await pipPage.locator('.documentPipSubtitleAppearanceButton').click();
    await expect(pipPage.locator('.subtitleSizerContainer')).toBeVisible();

    const pipPanel = await pipPage.locator('.subtitleSizer').evaluate(panel => {
        const slider = panel.querySelector('.subtitleSizerSlider') as HTMLInputElement;
        const select = panel.querySelector('.subtitleFontSelect') as HTMLSelectElement;
        const lower = slider.parentElement?.querySelector<HTMLElement>('.mdl-slider-background-lower');
        return {
            sliderClasses: slider.className,
            sliderContainerChildren: Array.from(slider.parentElement?.children ?? [])
                .map(child => child.className),
            hasTrackDom: !!slider.parentElement?.querySelector('.mdl-slider-background-flex'),
            sliderFillWidth: lower?.style.width ?? '(none)',
            selectClasses: select.className,
            selectBackground: getComputedStyle(select).backgroundColor,
            selectLabels: Array.from(panel.querySelectorAll('.subtitleSizerSelectGrid .selectLabel'))
                .map(label => (label.textContent || '').trim()),
            selectArrows: panel.querySelectorAll('.subtitleSizerSelectGrid .selectArrowContainer').length
        };
    });
    await testInfo.attach('pip-panel-controls.json', {
        body: JSON.stringify({ mainPanel, pipPanel }, null, 2),
        contentType: 'application/json'
    });

    // The v0 registry never fires in the popup document, so the component
    // must have upgraded its controls itself: styling classes, slider track
    // DOM with a real fill, select labels and arrows, and computed styles
    // identical to the main panel.
    expect(pipPanel.sliderClasses.split(/\s+/)).toContain('mdl-slider');
    expect(pipPanel.hasTrackDom).toBe(true);
    expect(parseFloat(pipPanel.sliderFillWidth)).toBeGreaterThan(30);
    expect(pipPanel.sliderFillWidth).toBe(mainPanel.sliderFillWidth);
    expect(pipPanel.selectClasses.split(/\s+/)).toEqual(
        expect.arrayContaining([ 'emby-select', 'emby-select-withcolor' ]));
    expect(pipPanel.selectBackground).toBe(mainPanel.selectBackground);
    expect(pipPanel.selectLabels).toEqual(mainPanel.selectLabels);
    expect(pipPanel.selectLabels.length).toBe(2);
    expect(pipPanel.selectLabels.every(label => label.length > 0)).toBe(true);
    expect(pipPanel.selectArrows).toBe(2);

    await pipPage.close();
});

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('manual Document PiP subtitle sizing does not replace the normal preference on exit', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, mainSubtitleLine);

    // Restore the real account to its captured pre-diagnostic 100% setting,
    // then use that normal size as the durable value each PiP cycle must keep.
    await openSizeOverlay(page);
    await setSizeSlider(page, 100);
    const normalFontSize = await mainSubtitleLine.evaluate(
        line => getComputedStyle(line).fontSize);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('100');
    await page.keyboard.press('Escape');

    for (const temporarySize of [ '150', '125' ]) {
        const pipPagePromise = page.context().waitForEvent('page');
        await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
        const pipPage = await pipPagePromise;
        await pipPage.locator('.documentPipSubtitleAppearanceButton').click();

        const pipSlider = pipPage.locator('.subtitleSizerSlider');
        await expect(pipSlider).toHaveValue('100');
        await pipSlider.focus();
        const adjustmentSteps = (Number(temporarySize) - 100) / 5;
        for (let step = 0; step < adjustmentSteps; step++) {
            await pipSlider.press('ArrowRight');
        }
        await expect(pipSlider).toHaveValue(temporarySize);

        await pipPage.close();
        await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
        await openSizeOverlay(page);
        await expect(page.locator('.subtitleSizerSlider')).toHaveValue('100');
        const restoredFontSize = await mainSubtitleLine.evaluate(
            line => getComputedStyle(line).fontSize);
        expect(restoredFontSize).toBe(normalFontSize);
        await page.keyboard.press('Escape');
    }
});

/**
 * Read the server-side display preferences document for the logged-in user.
 *
 * Subtitle appearance itself is device-local, so this document must be
 * byte-identical across a PiP session too: it proves no PiP code path
 * touched the server-side preferences store at all.
 *
 * @param page - Page logged in as the user under test.
 * @returns Raw response text of the usersettings display preferences.
 */
async function readServerDisplayPrefs(page: import('@playwright/test').Page) {
    return page.evaluate(async () => {
        const credentials = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
        const token = credentials.Servers?.[0]?.AccessToken;
        if (!token) return '(no token)';
        const response = await fetch('/Users/Me', {
            headers: { Authorization: `MediaBrowser Token="${token}"` }
        });
        const user = await response.json();
        const prefs = await fetch(`/DisplayPreferences/usersettings?userId=${user.Id}&client=emby`, {
            headers: { Authorization: `MediaBrowser Token="${token}"` }
        });
        return prefs.text();
    });
}

/**
 * Read the durable subtitle-appearance storage blob(s) from the page.
 *
 * Subtitle appearance persists through appSettings into localStorage under
 * `localplayersubtitleappearance3` (user-prefixed). Byte-identical before and
 * after a PiP session is the proof that nothing in the session leaked into
 * the durable store.
 *
 * @param page - Page logged in as the user under test.
 * @returns Map of localStorage key to stored value for every appearance key.
 */
async function readDurableAppearance(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const stored: Record<string, string | null> = {};
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key && /localplayersubtitleappearance/.test(key)) {
                stored[key] = localStorage.getItem(key);
            }
        }
        return stored;
    });
}

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('Document PiP exit via playback teardown keeps the normal preference', async ({ page, config }, testInfo) => {
    test.setTimeout(300_000);
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, mainSubtitleLine);

    await openSizeOverlay(page);
    await setSizeSlider(page, 100);
    await page.keyboard.press('Escape');
    const durableBefore = await readDurableAppearance(page);

    // In Chrome's Document PiP the popup document never contains the OSD, so
    // the in-player PiP toggle cannot exist there. The toggle a user still
    // has is the main window's own .btnPip while PiP is open; probe whether
    // that control is reachable, and record the outcome either way.
    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;
    await pipPage.locator('.documentPipSubtitleAppearanceButton').click();
    const pipSlider = pipPage.locator('.subtitleSizerSlider');
    await expect(pipSlider).toHaveValue('100');
    await pipSlider.focus();
    await pipSlider.press('ArrowRight');
    await expect(pipSlider).toHaveValue('105');

    let mainToggleReachable = false;
    for (let attempt = 0; attempt < 4 && !mainToggleReachable; attempt++) {
        await page.mouse.move(20, 20);
        await page.mouse.move(120, 120);
        mainToggleReachable = await page.locator('.btnPip:visible').count() > 0;
    }
    await testInfo.attach('pip-main-toggle-probe.json', {
        body: JSON.stringify({ mainToggleReachable }),
        contentType: 'application/json'
    });

    if (mainToggleReachable) {
        // Exit route 1: the main window's PiP toggle while the popup is open.
        await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
        await expect.poll(() => pipPage.isClosed()).toBe(true);
        await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
        expect(await readDurableAppearance(page)).toEqual(durableBefore);

        // A fresh PiP session for the teardown exit below.
        const reopenPromise = page.context().waitForEvent('page');
        await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
        const secondPip = await reopenPromise;
        await secondPip.locator('.documentPipSubtitleAppearanceButton').click();
        const secondSlider = secondPip.locator('.subtitleSizerSlider');
        await expect(secondSlider).toHaveValue('100');
        await secondSlider.focus();
        await secondSlider.press('ArrowRight');
        await expect(secondSlider).toHaveValue('105');

        // Exit route 2: playback teardown while Document PiP is open.
        await page.goBack();
        await expect.poll(() => secondPip.isClosed(), { timeout: 30_000 })
            .toBe(true);
    } else {
        // Exit route 2 only: playback teardown while Document PiP is open.
        await page.goBack();
        await expect.poll(() => pipPage.isClosed(), { timeout: 30_000 })
            .toBe(true);
    }

    await expect.poll(() => page.locator('.videoPlayerContainer video').count())
        .toBe(0);
    expect(await readDurableAppearance(page)).toEqual(durableBefore);

    // The durable preference must survive the whole session: restart
    // playback and read it back through the normal panel.
    const restarted = await startPlayback(page, config);
    await restarted.evaluate((el: HTMLVideoElement) => el.pause());
    await openSizeOverlay(page);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('100');
    expect(await readDurableAppearance(page)).toEqual(durableBefore);
    await page.keyboard.press('Escape');
});

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('Document PiP multi-field appearance adjustments leave the durable settings untouched', async ({ page, config }, testInfo) => {
    test.setTimeout(300_000);
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, mainSubtitleLine);

    // Fix a multi-field durable baseline: size 100, and whatever position,
    // font and weight the fresh account starts with.
    await openSizeOverlay(page);
    await setSizeSlider(page, 100);
    const baseline = await page.locator('.subtitleSizer').evaluate(panel => ({
        position: (panel.querySelector('.subtitlePositionSlider') as HTMLInputElement).value,
        font: (panel.querySelector('.subtitleFontSelect') as HTMLSelectElement).value,
        weight: (panel.querySelector('.subtitleWeightSelect') as HTMLSelectElement).value
    }));
    await page.keyboard.press('Escape');

    const durableBefore = await readDurableAppearance(page);
    const serverPrefsBefore = await readServerDisplayPrefs(page);

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;
    await pipPage.locator('.documentPipSubtitleAppearanceButton').click();

    // Adjust every persisted field inside the PiP session.
    const pipSlider = pipPage.locator('.subtitleSizerSlider');
    await expect(pipSlider).toHaveValue('100');
    await pipSlider.focus();
    await pipSlider.press('ArrowRight');
    await expect(pipSlider).toHaveValue('105');

    const positionSlider = pipPage.locator('.subtitlePositionSlider');
    await positionSlider.focus();
    await positionSlider.press('ArrowRight');
    await expect(positionSlider.inputValue()).not.toBe(baseline.position);

    await pipPage.locator('.subtitleFontSelect').selectOption('console');
    await pipPage.locator('.subtitleWeightSelect').selectOption('bold');
    await testInfo.attach('pip-multifield-during.png', {
        body: await pipPage.screenshot(),
        contentType: 'image/png'
    });

    await pipPage.close();
    await expect(page.locator('.videoPlayerContainer video')).toBeVisible();

    // The durable document must be byte-identical, server-side too.
    expect(await readDurableAppearance(page)).toEqual(durableBefore);
    const serverPrefsAfter = await readServerDisplayPrefs(page);
    expect(serverPrefsAfter).toBe(serverPrefsBefore);

    // And the normal panel must show the baseline values, restored.
    await openSizeOverlay(page);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('100');
    const restored = await page.locator('.subtitleSizer').evaluate(panel => ({
        position: (panel.querySelector('.subtitlePositionSlider') as HTMLInputElement).value,
        font: (panel.querySelector('.subtitleFontSelect') as HTMLSelectElement).value,
        weight: (panel.querySelector('.subtitleWeightSelect') as HTMLSelectElement).value
    }));
    expect(restored).toEqual(baseline);
    await page.keyboard.press('Escape');
});

// @covers subtitle_controls.track_menu.document_pip_custom_renderer_and_live_appearance
test('Document PiP panel opened from the main window menu stays transient', async ({ page, config }) => {
    test.setTimeout(300_000);
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const mainSubtitleLine = page.locator(
        '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, mainSubtitleLine);

    await openSizeOverlay(page);
    await setSizeSlider(page, 100);
    await page.keyboard.press('Escape');
    const durableBefore = await readDurableAppearance(page);

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;

    // The user opens the appearance panel from the main window's subtitle
    // menu while PiP is open: the panel is hosted in the PiP window, so the
    // adjustment made there is a PiP-context adjustment.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.getByText('Subtitle Appearance', { exact: true }).click();
    const pipSlider = pipPage.locator('.subtitleSizerSlider');
    await expect(pipSlider).toBeVisible();
    await expect(pipSlider).toHaveValue('100');
    await pipSlider.focus();
    await pipSlider.press('ArrowRight');
    await expect(pipSlider).toHaveValue('105');

    await pipPage.close();
    await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
    expect(await readDurableAppearance(page)).toEqual(durableBefore);
    await openSizeOverlay(page);
    await expect(page.locator('.subtitleSizerSlider')).toHaveValue('100');
    await page.keyboard.press('Escape');
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
