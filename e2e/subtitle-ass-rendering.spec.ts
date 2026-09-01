import {
    clickOsdControl,
    expect,
    login,
    onScreenState,
    requireAssSubtitleItemId,
    test,
    VIDEO_ROUTE
} from './fixtures';

test.setTimeout(180_000);

/** User-entry-point coverage for authored ASS layout and live libass controls. */

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

/**
 * Measure the pixels the libass canvas actually presents to the user.
 * @param page - Page containing the active libass renderer.
 * @returns Sampled non-transparent pixel count/hash and their vertical bounds.
 */
async function assCanvasSignature(page: import('@playwright/test').Page) {
    return page.locator(
        '.libassjs-canvas-parent:not(.libassjs-canvas-parent-secondary) .libassjs-canvas'
    ).evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext('2d');
        if (!context) {
            return {
                alphaPixels: 0,
                hash: 0,
                minY: -1,
                maxY: -1,
                width: canvas.width,
                height: canvas.height
            };
        }

        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let alphaPixels = 0;
        let hash = 2166136261;
        let minY = canvas.height;
        let maxY = -1;
        for (let offset = 0; offset < pixels.length; offset += 64) {
            const alpha = pixels[offset + 3];
            if (alpha > 0) {
                alphaPixels++;
                const y = Math.floor((offset / 4) / canvas.width);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
            hash ^= pixels[offset] + pixels[offset + 1] + pixels[offset + 2] + alpha;
            hash = Math.imul(hash, 16777619);
        }
        return {
            alphaPixels,
            hash: hash >>> 0,
            minY: alphaPixels ? minY : -1,
            maxY,
            width: canvas.width,
            height: canvas.height
        };
    });
}

/**
 * Convert libass's non-transparent canvas rows into screen coordinates after
 * the player has applied its live CSS translation.
 */
async function assRenderedVerticalBounds(page: import('@playwright/test').Page) {
    const canvas = page.locator(
        '.libassjs-canvas-parent:not(.libassjs-canvas-parent-secondary) .libassjs-canvas'
    );
    const signature = await assCanvasSignature(page);
    const box = await canvas.boundingBox();
    if (!box || signature.minY < 0) {
        throw new Error('ASS subtitle has no rendered screen bounds'); // allow-raw-error: e2e assertion setup
    }
    const scale = box.height / signature.height;
    return {
        top: box.y + signature.minY * scale,
        bottom: box.y + (signature.maxY + 1) * scale
    };
}

/**
 * Measure the visible screen bounds of one libass canvas.
 */
async function renderedAssCanvasBounds(canvas: import('@playwright/test').Locator) {
    return canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d');
        const screen = element.getBoundingClientRect();
        if (!context || !element.width || !element.height) return null;
        const pixels = context.getImageData(0, 0, element.width, element.height).data;
        let minX = element.width;
        let minY = element.height;
        let maxX = -1;
        let maxY = -1;
        for (let offset = 3; offset < pixels.length; offset += 4) {
            if (pixels[offset] === 0) continue;
            const pixel = (offset - 3) / 4;
            const x = pixel % element.width;
            const y = Math.floor(pixel / element.width);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
        if (maxY < 0) return null;
        const scaleX = screen.width / element.width;
        const scaleY = screen.height / element.height;
        return {
            top: screen.top + minY * scaleY,
            right: screen.left + (maxX + 1) * scaleX,
            bottom: screen.top + (maxY + 1) * scaleY,
            left: screen.left + minX * scaleX
        };
    });
}

async function seekAndPauseAssCue(
    video: import('@playwright/test').Locator,
    page: import('@playwright/test').Page,
    seconds: number
) {
    await video.evaluate(async (el: HTMLVideoElement, targetTime) => {
        const seeked = new Promise<void>(resolve => {
            el.addEventListener('seeked', () => resolve(), { once: true });
        });
        el.currentTime = targetTime;
        await seeked;
        el.pause();
    }, seconds);
    await expect.poll(() => assCanvasSignature(page), { timeout: 30_000 })
        .toMatchObject({ alphaPixels: expect.any(Number) });
    await expect.poll(async () => (await assCanvasSignature(page)).alphaPixels, {
        timeout: 30_000
    }).toBeGreaterThan(50);
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

// @covers subtitle_controls.track_menu.ass_authored_layout_live_appearance_secondary_and_offset
test('ASS preserves authored layout while appearance, secondary, and paused offset remain controllable', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const bundledFontResponses: Array<{ url: string, status: number }> = [];
    page.on('response', response => {
        if (
            response.request().method() === 'GET'
            && /(caveat|cinzel|comic-neue|courier-prime|noto-serif|roboto-mono)-latin-(400|700)-normal/.test(response.url())
        ) {
            bundledFontResponses.push({
                url: response.url(),
                status: response.status()
            });
        }
    });
    const video = await startPlayback(page, {
        itemId: requireAssSubtitleItemId(),
        serverId: config.serverId
    });

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();

    await expect(page.locator('.libassjs-canvas')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => bundledFontResponses.length, { timeout: 30_000 })
        .toBe(12);
    expect(bundledFontResponses.every(response =>
        response.status === 200
        && !new URL(response.url).pathname.includes('/web/libraries/')
    )).toBe(true);

    // This fixture intentionally has a DefaultTop cue and a normal bottom cue
    // active together here. Keeping pixels in both halves proves that the
    // controllable path did not flatten ASS into bottom-only plain captions.
    await seekAndPauseAssCue(video, page, 122.8);
    const authoredLayout = await assCanvasSignature(page);
    expect(authoredLayout.minY).toBeLessThan(authoredLayout.height * 0.4);
    expect(authoredLayout.maxY).toBeGreaterThan(authoredLayout.height * 0.6);

    await openSizeOverlay(page);
    await expect(page.locator('.subtitleSizerControls')).toBeVisible();
    await expect(page.locator('.subtitleSizerMessage')).toBeHidden();
    await expect(page.locator('.videoSubtitlesPreviewLine'))
        .toHaveText('This is how subtitles will look');
    // The controls still create a sample for cue gaps/no-track playback, but
    // it must not compete with real subtitles that are already on screen.
    await expect(page.locator('.videoSubtitlesPreviewLine')).toBeHidden();

    // Positioned cues use the same real font files and weight override as
    // ordinary dialogue. Assert each control separately: the old combined
    // assertion passed when only weight worked and font silently fell back.
    await page.locator('.subtitleFontSelect').selectOption('console');
    await expect.poll(async () => (await assCanvasSignature(page)).hash, {
        timeout: 30_000
    }).not.toBe(authoredLayout.hash);
    const positionedWithFont = await assCanvasSignature(page);
    await page.locator('.subtitleWeightSelect').selectOption('bold');
    await expect.poll(async () => (await assCanvasSignature(page)).hash, {
        timeout: 30_000
    }).not.toBe(positionedWithFont.hash);
    await page.locator('.subtitleFontSelect').selectOption('');
    await page.locator('.subtitleWeightSelect').selectOption('normal');

    // A single long bottom-centre dialogue cue makes rendered-pixel
    // comparisons and visible endpoint checks stable.
    await seekAndPauseAssCue(video, page, 185.5);

    await setSizeSlider(page, 25);
    await expect.poll(async () => (await assCanvasSignature(page)).alphaPixels, {
        timeout: 30_000
    }).toBeGreaterThan(10);
    const small = await assCanvasSignature(page);

    await setSizeSlider(page, 200);
    await expect.poll(async () => (await assCanvasSignature(page)).alphaPixels, {
        timeout: 30_000
    }).toBeGreaterThan(small.alphaPixels * 2);
    const large = await assCanvasSignature(page);

    await page.locator('.subtitleFontSelect').selectOption('console');
    await expect.poll(async () => (await assCanvasSignature(page)).hash, {
        timeout: 30_000
    }).not.toBe(large.hash);
    const bottomWithFont = await assCanvasSignature(page);
    await page.locator('.subtitleWeightSelect').selectOption('bold');
    await expect.poll(async () => (await assCanvasSignature(page)).hash, {
        timeout: 30_000
    }).not.toBe(bottomWithFont.hash);

    await setSizeSlider(page, 100);
    await page.locator('.subtitleFontSelect').selectOption('');
    await page.locator('.subtitleWeightSelect').selectOption('normal');

    const videoBox = await video.boundingBox();
    if (!videoBox) throw new Error('video has no box'); // allow-raw-error: e2e setup fast-fail

    // The preview's normal bottom position must match an ordinary authored
    // dialogue cue, not just the translated midpoint of the position slider.
    await setPositionSlider(page, -5);
    const defaultCanvas = page.locator(
        '.libassjs-canvas-parent:not(.libassjs-canvas-parent-secondary) .libassjs-canvas'
    );
    await expect.poll(() => renderedAssCanvasBounds(defaultCanvas))
        .not.toBeNull();
    const defaultCueBounds = await renderedAssCanvasBounds(defaultCanvas);
    if (!defaultCueBounds) {
        throw new Error('ASS dialogue has no rendered bounds'); // allow-raw-error: e2e assertion setup
    }
    await video.evaluate(async (el: HTMLVideoElement) => {
        const seeked = new Promise<void>(resolve => {
            el.addEventListener('seeked', () => resolve(), { once: true });
        });
        el.currentTime = 0;
        await seeked;
        el.pause();
    });
    const defaultPreviewLine = page.locator('.videoSubtitlesPreviewLine');
    await expect(defaultPreviewLine).toBeVisible();
    const defaultPreviewBox = await defaultPreviewLine.boundingBox();
    if (!defaultPreviewBox) {
        throw new Error('ASS cue-gap preview has no box'); // allow-raw-error: e2e assertion setup
    }
    expect(Math.abs(
        defaultPreviewBox.y + defaultPreviewBox.height - defaultCueBounds.bottom
    )).toBeLessThan(videoBox.height * 0.01);
    await seekAndPauseAssCue(video, page, 185.5);

    // The sample shown in a cue gap uses the same effective lower-edge anchor
    // as ordinary ASS dialogue instead of the DOM renderer's old, different
    // centre/top interpolation.
    await setPositionSlider(page, -12);
    const alignmentCanvas = page.locator(
        '.libassjs-canvas-parent:not(.libassjs-canvas-parent-secondary) .libassjs-canvas'
    );
    await expect.poll(async () => {
        const positionedBounds = await renderedAssCanvasBounds(alignmentCanvas);
        return positionedBounds?.bottom;
    }).toBeLessThan(defaultCueBounds.bottom);
    const realCueBounds = await renderedAssCanvasBounds(alignmentCanvas);
    if (!realCueBounds) {
        throw new Error('ASS dialogue has no rendered bounds'); // allow-raw-error: e2e assertion setup
    }
    // libass recalculates canvas top/left on resize. The vertical-position
    // transform must survive that pass instead of being canceled by an
    // inverse canvas top adjustment.
    const originalViewport = page.viewportSize();
    if (!originalViewport) {
        throw new Error('browser has no viewport size'); // allow-raw-error: e2e assertion setup
    }
    await page.setViewportSize({
        width: originalViewport.width - 1,
        height: originalViewport.height
    });
    await expect.poll(async () => {
        const resizedBounds = await renderedAssCanvasBounds(alignmentCanvas);
        if (!resizedBounds) return Number.POSITIVE_INFINITY;
        return Math.abs(resizedBounds.bottom - realCueBounds.bottom);
    }).toBeLessThanOrEqual(1);
    await page.setViewportSize(originalViewport);
    await expect.poll(async () => {
        const restoredBounds = await renderedAssCanvasBounds(alignmentCanvas);
        if (!restoredBounds) return Number.POSITIVE_INFINITY;
        return Math.abs(restoredBounds.bottom - realCueBounds.bottom);
    }).toBeLessThanOrEqual(1);
    await video.evaluate(async (el: HTMLVideoElement) => {
        const seeked = new Promise<void>(resolve => {
            el.addEventListener('seeked', () => resolve(), { once: true });
        });
        el.currentTime = 0;
        await seeked;
        el.pause();
    });
    const previewLine = page.locator('.videoSubtitlesPreviewLine');
    await expect(previewLine).toBeVisible();
    const assGapPreviewBox = await previewLine.boundingBox();
    if (!assGapPreviewBox) {
        throw new Error('ASS cue-gap preview has no box'); // allow-raw-error: e2e assertion setup
    }
    expect(Math.abs(
        assGapPreviewBox.y + assGapPreviewBox.height - realCueBounds.bottom
    )).toBeLessThan(videoBox.height * 0.01);
    await seekAndPauseAssCue(video, page, 185.5);

    await setPositionSlider(page, -20);
    await expect.poll(async () => (await assRenderedVerticalBounds(page)).top)
        .toBeLessThan(videoBox.y);
    const topBounds = await assRenderedVerticalBounds(page);
    expect(topBounds.bottom).toBeGreaterThan(videoBox.y);
    const visibleTopCueHeight = topBounds.bottom - videoBox.y;
    const topCueHeight = topBounds.bottom - topBounds.top;
    expect(visibleTopCueHeight / topCueHeight).toBeGreaterThan(0.3);
    expect(visibleTopCueHeight / topCueHeight).toBeLessThan(0.7);

    await setPositionSlider(page, -5);
    await expect.poll(async () => (await assRenderedVerticalBounds(page)).bottom)
        .toBeLessThanOrEqual(videoBox.y + videoBox.height);
    const bottomBounds = await assRenderedVerticalBounds(page);
    expect(bottomBounds.bottom).toBeGreaterThan(videoBox.y + videoBox.height * 0.8);
    expect(bottomBounds.top).toBeGreaterThanOrEqual(videoBox.y);

    await page.locator('.subtitleSizer-closeButton').click();

    // ASS is also independently selectable as a secondary subtitle. The
    // primary canvas must remain connected when the second renderer appears.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.getByText('Secondary Subtitles', { exact: true }).click();
    await page.locator('.actionSheetMenuItem', { hasText: 'French' }).first().click();
    await expect(page.locator('.libassjs-canvas')).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(async () => {
        const alphaCounts = await page.locator('.libassjs-canvas').evaluateAll(
            canvases => canvases.map(canvas => {
                const element = canvas as HTMLCanvasElement;
                const context = element.getContext('2d');
                if (!context) return 0;
                const pixels = context.getImageData(0, 0, element.width, element.height).data;
                let count = 0;
                for (let offset = 3; offset < pixels.length; offset += 64) {
                    if (pixels[offset] > 0) count++;
                }
                return count;
            })
        );
        return alphaCounts.every(count => count > 50);
    }, { timeout: 30_000 }).toBe(true);
    const primaryCanvas = page.locator(
        '.libassjs-canvas-parent:not(.libassjs-canvas-parent-secondary) .libassjs-canvas'
    );
    const secondaryCanvas = page.locator(
        '.libassjs-canvas-parent-secondary .libassjs-canvas'
    );
    await expect.poll(async () => {
        const primary = await renderedAssCanvasBounds(primaryCanvas);
        const secondary = await renderedAssCanvasBounds(secondaryCanvas);
        if (!primary || !secondary) return false;
        const horizontallySeparate = secondary.right <= primary.left
            || secondary.left >= primary.right;
        const verticallySeparate = secondary.bottom <= primary.top
            || secondary.top >= primary.bottom;
        return horizontallySeparate || verticallySeparate;
    }, { timeout: 30_000 }).toBe(true);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
    await page.locator('.actionSheetMenuItem', { hasText: 'Subtitle Offset' }).click();
    await expect(page.locator('.subtitleSyncContainer')).toBeVisible();
    await expectOverlayReachable(page, '.subtitleSyncContainer');

    const timeUpdatesBeforeDrag = await video.evaluate((el: HTMLVideoElement) => {
        const state = { count: 0 };
        el.addEventListener('timeupdate', () => state.count++);
        Object.assign(el, { assOffsetTestState: state });
        return state.count;
    });
    expect(timeUpdatesBeforeDrag).toBe(0);

    const before = await assCanvasSignature(page);
    await dragOffsetSliderTo(page, 30);
    await expect.poll(() => assCanvasSignature(page), { timeout: 10_000 }).not.toEqual(before);
    await expect.poll(() => video.evaluate(
        (el: HTMLVideoElement & { assOffsetTestState?: { count: number } }) =>
            el.assOffsetTestState?.count
    )).toBe(0);

    await dragOffsetSliderTo(page, 0);
    await expect.poll(() => assCanvasSignature(page), { timeout: 10_000 }).toEqual(before);
});
