// SlopTank modification notice: added by SlopTank on 2026-09-30 (c301).
import type { Page } from '@playwright/test';
import {
    clickOsdControl,
    expect,
    login,
    onScreenState,
    test,
    VIDEO_ROUTE,
    wakeOsd
} from './fixtures';

test.setTimeout(240_000);

/**
 * User-reported regression (c301): after entering Picture in Picture the
 * playback controls jumped from the bottom of the screen to roughly the middle
 * and stayed there after exit. Two PiP modes exist in Chrome and both are
 * covered through the real OSD button: Document PiP (the player's own popup
 * window) and Chrome's video-only PiP (the API exposed when Document PiP is
 * absent). Controls must stay anchored to the bottom of the main window while
 * PiP is open, and leaving PiP must restore the exact pre-PiP layout.
 */

const ALL_PIP_WINDOW_SIZES: Array<[ number, number ]> = [ [ 320, 180 ], [ 400, 225 ], [ 640, 360 ], [ 1100, 650 ] ];
const ALL_MAIN_WINDOW_SIZES: Array<[ number, number ]> = [ [ 1440, 900 ], [ 1920, 1080 ], [ 900, 700 ] ];

/**
 * Comma-separated "WxH" list from an opt-in env var, so a heavily loaded host can
 * run the same matrix in bounded slices instead of one run that outlives its
 * timeout. Unset means the whole matrix.
 */
function sizesFromEnv(name: string, all: Array<[ number, number ]>): Array<[ number, number ]> {
    const raw = process.env[name]; // allow-direct-env: opt-in matrix slicing in an e2e spec
    if (!raw) return all;
    const wanted = new Set(raw.split(',').map(entry => entry.trim()));
    const selected = all.filter(([ w, h ]) => wanted.has(`${w}x${h}`));
    if (selected.length !== wanted.size) {
        throw new Error(`${name}=${raw} names a size outside the matrix`); // allow-raw-error: test setup fast-fail, not production code
    }
    return selected;
}

const PIP_WINDOW_SIZES = sizesFromEnv('E2E_PIP_WINDOW_SIZES', ALL_PIP_WINDOW_SIZES);
const MAIN_WINDOW_SIZES = sizesFromEnv('E2E_PIP_MAIN_SIZES', ALL_MAIN_WINDOW_SIZES);
const PIP_CYCLES = Number(process.env.E2E_PIP_CYCLES || 3); // allow-direct-env: opt-in matrix slicing in an e2e spec

interface Box { top: number; bottom: number; left: number; width: number; height: number }

interface PlayerLayout {
    viewport: { width: number; height: number };
    /** Geometry of the controls a user presses. */
    controls: Box | null;
    /** Height of every direct child, so a geometry shift names the row that moved. */
    controlsRows: string[];
    controlsStyle: Record<string, string> | null;
    overlayStyle: Record<string, string> | null;
    container: { box: Box | null; style: Record<string, string> | null; attributes: Record<string, string | null> };
    video: { box: Box | null; attributes: Record<string, string | null> };
    /** Where the player surface sits in the main document. */
    dialogPlacement: { parent: string | null; siblingIndex: number };
    documentState: { htmlClass: string; htmlStyle: string | null; bodyClass: string; bodyStyle: string | null };
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
}

/**
 * Wake the OSD and read every layout fact that PiP must not disturb.
 *
 * The OSD carries a transient `.osdMediaStatus` row ("Fetching additional
 * data", 24px) from the player's beginFetch event to its endFetch event, i.e.
 * while the item's extra data loads early in playback. Under host load that
 * window outlasts several seconds, and a baseline taken inside it differs by
 * exactly that row from every later reading. It is a time-driven loading
 * indicator, unrelated to PiP, so a reading is only taken once the row is gone
 * and the geometry then agrees across three consecutive wakes.
 */
async function measureLayout(page: Page): Promise<PlayerLayout> {
    let previous: PlayerLayout | null = null;
    let agreeing = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
        await expect
            .poll(async () => {
                await wakeOsd(page);
                return (await page.locator('.videoOsdBottom-maincontrols:visible').count()) > 0;
            })
            .toBe(true);
        const fetching = await page.evaluate(() => {
            const status = document.querySelector('.videoOsdBottom-maincontrols:not([hidden]) .osdMediaStatus');
            return !!status && !status.classList.contains('hide');
        });
        if (fetching) {
            previous = null;
            agreeing = 0;
            await page.waitForTimeout(500);
            continue;
        }
        const current = await readLayout(page);
        agreeing = previous && JSON.stringify(previous.controls) === JSON.stringify(current.controls) ? agreeing + 1 : 0;
        if (agreeing >= 2) {
            return current;
        }
        previous = current;
        await page.waitForTimeout(1_000);
    }
    throw new Error('OSD controls geometry never settled across 60 samples'); // allow-raw-error: test setup fast-fail, not production code
}

async function readLayout(page: Page): Promise<PlayerLayout> {
    return page.evaluate(() => {
        const box = (el: Element | null): Box | null => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
                top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
                width: Math.round(r.width), height: Math.round(r.height)
            };
        };
        const style = (el: Element | null, props: string[]): Record<string, string> | null => {
            if (!el) return null;
            const computed = getComputedStyle(el);
            return Object.fromEntries(props.map(p => [ p, computed.getPropertyValue(p) ]));
        };
        const attributes = (el: Element | null, names: string[]) =>
            Object.fromEntries(names.map(n => [ n, el ? el.getAttribute(n) : null ]));
        const positioning = [ 'position', 'top', 'bottom', 'left', 'right', 'transform', 'display', 'align-items', 'width', 'height', 'margin-top', 'margin-bottom' ];

        const controls = document.querySelector('.videoOsdBottom-maincontrols:not([hidden])');
        const overlay = document.querySelector('.videoOsdBottom');
        const container = document.querySelector('.videoPlayerContainer');
        const video = container?.querySelector('video') ?? null;
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            controls: box(controls),
            controlsRows: controls ? Array.from(controls.children).map(c => `${c.tagName.toLowerCase()}.${(c.className || '').toString().replace(/\s+/g, '.')}:${Math.round(c.getBoundingClientRect().height)}`) : [],
            controlsStyle: style(controls, positioning),
            overlayStyle: style(overlay, positioning),
            container: {
                box: box(container),
                style: style(container, positioning),
                attributes: attributes(container, [ 'class', 'style' ])
            },
            video: { box: box(video), attributes: attributes(video, [ 'class', 'style', 'controls' ]) },
            dialogPlacement: {
                parent: container?.parentElement?.tagName ?? null,
                siblingIndex: container?.parentElement ? Array.from(container.parentElement.children).indexOf(container) : -1
            },
            documentState: {
                htmlClass: document.documentElement.className,
                htmlStyle: document.documentElement.getAttribute('style'),
                bodyClass: document.body.className,
                bodyStyle: document.body.getAttribute('style')
            }
        };
    });
}

function expectAnchoredToBottom(layout: PlayerLayout, label: string) {
    expect(layout.controls, `${label}: controls must exist`).not.toBeNull();
    expect(layout.controls?.bottom, `${label}: controls bottom edge must be the window bottom`).toBe(layout.viewport.height);
    expect(layout.controlsStyle?.position, `${label}: controls stay fixed`).toBe('fixed');
    expect(layout.controlsStyle?.transform, `${label}: controls carry no transform`).toBe('none');
    expect(layout.overlayStyle?.bottom, `${label}: OSD overlay bottom offset`).toBe('0px');
}

async function assertControlsReachable(page: Page, label: string) {
    const state = await onScreenState(page, '.videoOsdBottom-maincontrols .btnPip');
    expect(state, `${label}: the PiP button must be on screen and pressable`).toMatchObject({
        found: true, insideViewport: true, reachable: true
    });
}

/**
 * What the Document PiP popup itself shows the user: the native video controls,
 * the subtitle appearance button, and anything of the main-page OSD that leaked in.
 */
async function readPopupControls(pip: Page) {
    return pip.evaluate(() => {
        const box = (el: Element | null) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
        };
        const video = document.querySelector('video') as HTMLVideoElement | null;
        const button = document.querySelector('.documentPipSubtitleAppearanceButton');
        const osd = document.querySelector('.videoOsdBottom');
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            nativeControls: !!video?.controls,
            button: box(button),
            osdPresent: !!osd,
            osdBox: osd ? box(osd) : null
        };
    });
}

/** Evidence screenshots, only when E2E_PIP_SHOTS_DIR names a directory. */
async function shoot(page: Page, name: string) {
    const dir = process.env.E2E_PIP_SHOTS_DIR; // allow-direct-env: opt-in evidence capture in an e2e spec
    if (dir) {
        await page.screenshot({ path: `${dir}/${name}.png` });
    }
}

async function shootPopup(pip: Page, name: string) {
    const dir = process.env.E2E_PIP_SHOTS_DIR; // allow-direct-env: opt-in evidence capture in an e2e spec
    if (dir) {
        await pip.screenshot({ path: `${dir}/${name}.png` });
    }
}

async function openDocumentPip(page: Page): Promise<Page> {
    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pip = await pipPagePromise;
    await expect(pip.locator('.videoPlayerContainer video')).toBeVisible();
    return pip;
}

for (const [ mainWidth, mainHeight ] of MAIN_WINDOW_SIZES) {
    // @covers player_controls.picture_in_picture.controls_stay_bottom_anchored_through_document_pip
    // @covers player_controls.picture_in_picture.layout_not_stranded_after_exit
    test(`Document PiP keeps controls bottom-anchored and restores the layout exactly (main ${mainWidth}x${mainHeight})`, async ({ page, config }) => {
        await login(page, config.username, config.password);
        await page.setViewportSize({ width: mainWidth, height: mainHeight });
        await startPlayback(page, config);
        const before = await measureLayout(page);
        expectAnchoredToBottom(before, 'before PiP');
        await shoot(page, `c301-green-docpip-${mainWidth}x${mainHeight}-before`);

        for (let cycle = 1; cycle <= PIP_CYCLES; cycle++) {
            const pip = await openDocumentPip(page);

            for (const [ width, height ] of PIP_WINDOW_SIZES) {
                await pip.setViewportSize({ width, height });
                const label = `cycle ${cycle}, PiP window ${width}x${height}`;

                // The popup hosts the video surface: it must fill the window and
                // leave the appearance control reachable, at every size.
                await expect.poll(() => pip.evaluate(() => {
                    const video = document.querySelector('.videoPlayerContainer video');
                    const box = video?.getBoundingClientRect();
                    return box ? { w: Math.round(box.width), h: Math.round(box.height), bottom: Math.round(box.bottom) } : null;
                }), { message: `${label}: PiP video fills the window` }).toEqual({ w: width, h: height, bottom: height });
                expect(await onScreenState(pip, '.documentPipSubtitleAppearanceButton'), label).toMatchObject({
                    found: true, insideViewport: true, reachable: true
                });

                // The main window shows no player surface while it is in the
                // popup, and its controls must not have moved.
                const during = await measureLayout(page);
                expectAnchoredToBottom(during, label);
                expect(during.controls, `${label}: controls geometry unchanged`).toEqual(before.controls);
                await assertControlsReachable(page, label);
                const popup = await readPopupControls(pip);
                expect(popup.nativeControls, `${label}: popup shows native video controls`).toBe(true);
                expect(popup.button, `${label}: popup appearance button exists`).not.toBeNull();
                expect(popup.button!.bottom, `${label}: appearance button inside popup`).toBeLessThanOrEqual(popup.viewport.height);
                expect(popup.button!.right, `${label}: appearance button inside popup`).toBeLessThanOrEqual(popup.viewport.width);
                if (popup.osdPresent) {
                    expect(popup.osdBox?.bottom, `${label}: any OSD in the popup stays bottom-anchored`).toBe(popup.viewport.height);
                }
                if (cycle === 1) {
                    await shoot(page, `c301-green-docpip-${mainWidth}x${mainHeight}-during-${width}x${height}`);
                    await shootPopup(pip, `c301-green-docpip-${mainWidth}x${mainHeight}-popup-${width}x${height}`);
                }
            }

            await pip.close();
            await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
            const after = await measureLayout(page);
            expectAnchoredToBottom(after, `after exit ${cycle}`);
            expect(after, `cycle ${cycle}: exiting PiP restores the exact pre-PiP layout`).toEqual(before);
            if (cycle === 1) {
                await shoot(page, `c301-green-docpip-${mainWidth}x${mainHeight}-after`);
            }
        }
    });
}

// @covers player_controls.picture_in_picture.controls_stay_bottom_anchored_through_video_pip
for (const [ mainWidth, mainHeight ] of MAIN_WINDOW_SIZES) {
    test(`Video-only PiP keeps controls bottom-anchored and restores the layout exactly (main ${mainWidth}x${mainHeight})`, async ({ page, config }) => {
        await page.addInitScript(() => {
        // Chrome's video-only PiP is what the player falls back to without the
        // Document PiP API.
            Object.defineProperty(window, 'documentPictureInPicture', { value: undefined });
        });
        await login(page, config.username, config.password);
        await page.setViewportSize({ width: mainWidth, height: mainHeight });
        await startPlayback(page, config);
        const before = await measureLayout(page);
        expectAnchoredToBottom(before, 'before PiP');

        for (let cycle = 1; cycle <= PIP_CYCLES; cycle++) {
            await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
            await expect.poll(() => page.evaluate(() => !!document.pictureInPictureElement)).toBe(true);
            const during = await measureLayout(page);
            expectAnchoredToBottom(during, `cycle ${cycle} during PiP`);
            expect(during.controls, `cycle ${cycle}: controls geometry unchanged`).toEqual(before.controls);
            await assertControlsReachable(page, `cycle ${cycle} during PiP`);

            await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
            await expect.poll(() => page.evaluate(() => !!document.pictureInPictureElement)).toBe(false);
            const after = await measureLayout(page);
            expect(after, `cycle ${cycle}: exiting PiP restores the exact pre-PiP layout`).toEqual(before);
        }
    });
}

// @covers player_controls.picture_in_picture.double_press_enter_race
test('A double press on the PiP button still ends with the player back in the main window', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await startPlayback(page, config);
    await wakeOsd(page);
    const before = await measureLayout(page);

    const pipPages: Page[] = [];
    page.context().on('page', popup => pipPages.push(popup));
    await wakeOsd(page);
    await page.locator('.videoOsdBottom-maincontrols:visible .btnPip').dblclick();
    await expect.poll(() => pipPages.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(3_000);

    for (const popup of pipPages) {
        if (!popup.isClosed()) await popup.close();
    }
    await expect(page.locator('.videoPlayerContainer video')).toBeVisible();
    const after = await measureLayout(page);
    expect(after, 'closing every PiP popup restores the exact pre-PiP layout').toEqual(before);
});
