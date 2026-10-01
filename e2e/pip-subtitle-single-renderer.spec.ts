// SlopTank modification notice: added by SlopTank on 2026-10-01 (c301).
import type { Page } from '@playwright/test';
import {
    clickOsdControl,
    expect,
    login,
    parkOnCue,
    test,
    VIDEO_ROUTE
} from './fixtures';

test.setTimeout(240_000);

/**
 * c301: a Document PiP capture showed one cue drawn twice with a slight
 * offset. Exactly one subtitle renderer may paint a cue at any moment, in
 * every window the player is in: the SlopTank DOM overlay, an ASS canvas, or
 * the browser's native text-track cue rendering, never two of them.
 */

interface RendererCount {
    /** Visible DOM overlay lines that currently carry cue text. */
    domLines: number;
    /** Canvas renderers (ASS/PGS) attached in this document. */
    canvases: number;
    /** Native text tracks the browser is painting (mode "showing"). */
    nativeShowing: string[];
    /** Every text track and its mode, for diagnosis. */
    allTracks: string[];
}

async function startPlayback(page: Page, config: { itemId: string; serverId: string }) {
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

/** Count the subtitle renderers painting in one document. */
async function countRenderers(target: Page): Promise<RendererCount> {
    return target.evaluate(() => {
        const visibleWithText = (el: Element) => {
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
                && box.width > 0 && box.height > 0 && (el.textContent ?? '').trim().length > 0;
        };
        const lines = Array.from(document.querySelectorAll(
            '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine), .videoSecondarySubtitlesInner'
        )).filter(visibleWithText);
        const videos = Array.from(document.querySelectorAll('video'));
        const tracks = videos.flatMap(v => Array.from(v.textTracks));
        return {
            domLines: lines.length,
            canvases: document.querySelectorAll('canvas.libassjs-canvas, .videoSubtitles canvas').length,
            nativeShowing: tracks.filter(t => t.mode === 'showing').map(t => `${t.kind}:${t.label || t.language || '?'}`),
            allTracks: tracks.map(t => `${t.kind}:${t.label || t.language || '?'}:${t.mode}`)
        };
    });
}

/**
 * The renderer count across every window the player may be drawn in. A cue
 * that is painted by the DOM overlay AND by a native showing track is a
 * double draw, as is the same overlay line present in two documents.
 */
async function expectOneRenderer(pages: Page[], label: string) {
    const counts = await Promise.all(pages.map(countRenderers));
    const domLines = counts.reduce((sum, c) => sum + c.domLines, 0);
    const nativeShowing = counts.reduce((sum, c) => sum + c.nativeShowing.length, 0);
    const canvases = counts.reduce((sum, c) => sum + c.canvases, 0);
    expect(domLines + nativeShowing + canvases, `${label}: exactly one subtitle renderer paints the cue (${JSON.stringify(counts)})`).toBe(1);
}

/** Evidence screenshots, only when E2E_PIP_SHOTS_DIR names a directory. */
async function shoot(target: Page, name: string) {
    const dir = process.env.E2E_PIP_SHOTS_DIR; // allow-direct-env: opt-in evidence capture in an e2e spec
    if (dir) {
        await target.screenshot({ path: `${dir}/${name}.png` });
    }
}

async function selectEnglishAndPark(page: Page, video: ReturnType<Page['locator']>) {
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    await parkOnCue(video, page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)'));
}

// @covers subtitle_controls.track_menu.single_renderer_in_document_pip
test('Document PiP paints each cue with exactly one subtitle renderer', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    await selectEnglishAndPark(page, video);
    await expectOneRenderer([ page ], 'main window before PiP');

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pip = await pipPagePromise;
    await expect(pip.locator('.videoPlayerContainer video')).toBeVisible();
    await expect.poll(() => pip.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)').isVisible()).toBe(true);
    await expectOneRenderer([ page, pip ], 'Document PiP open');
    await shoot(pip, 'c301-ghost-docpip-popup');

    await pip.close();
    await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
    await expect.poll(() => page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)').isVisible()).toBe(true);
    await expectOneRenderer([ page ], 'after Document PiP exit');
});

// @covers subtitle_controls.track_menu.single_renderer_in_video_pip
test('Video-only PiP paints each cue with exactly one subtitle renderer', async ({ page, config }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'documentPictureInPicture', { value: undefined });
    });
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    await selectEnglishAndPark(page, video);
    await expectOneRenderer([ page ], 'before video PiP');

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    await expect.poll(() => page.evaluate(() => !!document.pictureInPictureElement)).toBe(true);
    // The overlay is not drawn in Chrome's video-only PiP window, so the cue
    // must not also be a native track: the overlay stays the only renderer.
    await expectOneRenderer([ page ], 'video-only PiP open');

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    await expect.poll(() => page.evaluate(() => !!document.pictureInPictureElement)).toBe(false);
    await expectOneRenderer([ page ], 'after video-only PiP exit');
});
