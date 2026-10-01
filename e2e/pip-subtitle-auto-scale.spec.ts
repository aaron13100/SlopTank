// SlopTank modification notice: added or changed by SlopTank on 2026-10-01.
import type { Page } from '@playwright/test';
import {
    clickOsdControl,
    expect,
    login,
    openDocumentPip,
    selectEnglishAndPark,
    startPlayback,
    test
} from './fixtures';

test.setTimeout(300_000);

/**
 * c303: entering Picture in Picture must automatically give subtitles a
 * readable size derived from the PiP viewport, without touching the durable
 * user preference. A real Chrome Document PiP window is 320x180 to 640x360,
 * where the ordinary proportional size (4.5% of video height) is ~8 to 16px.
 *
 * The target is an independent statement of the contract, not an import of
 * the implementation: userScale x max(14, 7.5% of PiP viewport height).
 * Rental Family carries burned-in subtitles in the source pixels, so every
 * measurement is of the DOM cue element's computed font-size, never pixels.
 */

const PIP_WINDOW_SIZES: Array<[ number, number ]> = [ [ 320, 180 ], [ 400, 225 ], [ 640, 360 ], [ 1100, 650 ] ];
const CUE = '.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)';
const PREFERENCE_KEY_SUFFIX = 'localplayersubtitleappearance3';

function targetPx(userScale: number, pipHeight: number): number {
    return userScale * Math.max(14, 0.075 * pipHeight);
}

/** Every stored copy of the persisted subtitle appearance preference. */
async function readStoredPreference(page: Page): Promise<Record<string, string | null>> {
    return page.evaluate(suffix => {
        const entries: Record<string, string | null> = {};
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key && key.endsWith(suffix)) {
                entries[key] = localStorage.getItem(key);
            }
        }
        return entries;
    }, PREFERENCE_KEY_SUFFIX);
}

/** The user's text-size multiplier from the stored preference (1 when unset). */
function userScaleFrom(stored: Record<string, string | null>): number {
    const raw = Object.values(stored).find(value => value) ?? '{}';
    const textSize = JSON.parse(raw).textSize;
    const presets: Record<string, number> = { smaller: 0.75, small: 0.75, large: 1.25, larger: 1.5, extralarge: 2 };
    const numeric = typeof textSize === 'string' && textSize.trim() !== '' ? Number(textSize) : textSize;
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
        return Math.min(2, Math.max(0.25, numeric));
    }
    return presets[textSize] ?? 1;
}

/** Computed cue font-size once three consecutive readings agree. */
async function settledCueFontPx(target: Page): Promise<number> {
    let last = Number.NaN;
    let agreeing = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const current = await target.locator(CUE).evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        agreeing = current === last ? agreeing + 1 : 0;
        if (agreeing >= 3) {
            return current;
        }
        last = current;
        await target.waitForTimeout(250);
    }
    return last;
}

/** Evidence screenshots, only when E2E_PIP_SHOTS_DIR names a directory. */
async function shoot(target: Page, name: string) {
    const dir = process.env.E2E_PIP_SHOTS_DIR; // allow-direct-env: opt-in evidence capture in an e2e spec
    if (dir) {
        await target.screenshot({ path: `${dir}/${name}.png` });
    }
}

// @covers subtitle_controls.appearance_sizing.document_pip_auto_scale
test('Document PiP subtitles auto-scale to the PiP viewport, track resizes, and restore exactly on exit', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    await selectEnglishAndPark(page, video);

    const storedBefore = await readStoredPreference(page);
    const userScale = userScaleFrom(storedBefore);
    const mainBefore = await settledCueFontPx(page);
    console.log(`C303-MEASURE main before PiP: cue ${mainBefore}px, main viewport ${JSON.stringify(page.viewportSize())}, userScale ${userScale}`);

    const pip = await openDocumentPip(page);
    await expect(pip.locator(CUE)).toBeVisible();

    const sizesSeen: number[] = [];
    for (const [ width, height ] of PIP_WINDOW_SIZES) {
        await pip.setViewportSize({ width, height });
        await expect.poll(() => pip.evaluate(() => window.innerHeight), { message: `PiP ${width}x${height} applied` }).toBe(height);
        const px = await settledCueFontPx(pip);
        sizesSeen.push(px);
        console.log(`C303-MEASURE PiP ${width}x${height}: viewport height ${await pip.evaluate(() => window.innerHeight)}, cue ${px}px, target ${targetPx(userScale, height).toFixed(2)}px`);
        if (width === 400) {
            await shoot(pip, `c303-popup-${process.env.C303_PHASE || 'run'}-400x225`); // allow-direct-env: opt-in evidence label in an e2e spec
        }
        expect.soft(px, `PiP ${width}x${height}: cue font-size is at least the readable target`)
            .toBeGreaterThanOrEqual(targetPx(userScale, height) - 0.5);
    }

    // Resize back down and up again: the size follows the window, it is not
    // fixed at whatever the entry size produced.
    await pip.setViewportSize({ width: 320, height: 180 });
    await expect.poll(() => pip.evaluate(() => window.innerHeight)).toBe(180);
    const shrunk = await settledCueFontPx(pip);
    await pip.setViewportSize({ width: 640, height: 360 });
    await expect.poll(() => pip.evaluate(() => window.innerHeight)).toBe(360);
    const grown = await settledCueFontPx(pip);
    console.log(`C303-MEASURE resize 640x360 -> 320x180 -> 640x360: ${sizesSeen[2]}px -> ${shrunk}px -> ${grown}px`);
    expect.soft(shrunk, 'after shrinking to 180px high the size tracks the new height').toBeGreaterThanOrEqual(targetPx(userScale, 180) - 0.5);
    expect.soft(shrunk, 'a smaller window yields a smaller cue').toBeLessThan(grown);
    expect.soft(grown, 'after growing to 360px high the size tracks the new height').toBeGreaterThanOrEqual(targetPx(userScale, 360) - 0.5);

    expect.soft(await readStoredPreference(page), 'PiP scaling never writes the durable preference').toEqual(storedBefore);

    await pip.close();
    await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
    await expect(page.locator(CUE)).toBeVisible();
    const mainAfter = await settledCueFontPx(page);
    console.log(`C303-MEASURE main after exit: cue ${mainAfter}px`);
    expect(mainAfter, 'exiting PiP restores the exact pre-PiP main window size').toBe(mainBefore);
    expect(await readStoredPreference(page), 'the durable preference is unchanged by the whole cycle').toEqual(storedBefore);
});

// @covers subtitle_controls.appearance_sizing.video_pip_native_cues_unstyleable
test('Video-only PiP shows no page-styleable subtitle: no native track is showing', async ({ page, config }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'documentPictureInPicture', { value: undefined });
    });
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    await selectEnglishAndPark(page, video);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    await expect.poll(() => page.evaluate(() => !!document.pictureInPictureElement)).toBe(true);
    const state = await page.evaluate(() => {
        const tracks = Array.from(document.querySelectorAll('video')).flatMap(v => Array.from(v.textTracks));
        return {
            nativeShowing: tracks.filter(t => t.mode === 'showing').length,
            cueStyleRules: document.querySelectorAll('style[id$="-cuestyle"]').length
        };
    });
    console.log(`C303-MEASURE video-only PiP: ${JSON.stringify(state)}`);
    // Chrome draws only native text tracks in its own PiP window. The player
    // renders cues through its DOM overlay, so no showing track exists for
    // page styling (::cue) to reach; there is nothing to scale there.
    expect(state.nativeShowing).toBe(0);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    await expect.poll(() => page.evaluate(() => !!document.pictureInPictureElement)).toBe(false);
});
