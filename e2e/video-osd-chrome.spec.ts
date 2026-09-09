// SlopTank modification notice: added or changed by SlopTank on 2026-08-12, 2026-09-02, 2026-09-09.
import { expect, type Page } from '@playwright/test';

import { test, login, onScreenState, WATCH_PERMALINK_ROUTE } from './fixtures';

test.setTimeout(180_000);

/**
 * The app header must follow the playback controls while a video is playing.
 *
 * Reported 2026-08-12: "the header ... now never disappears even when we're
 * playing a movie at full screen ... that header is supposed to fade at the
 * same time that the playback controls fade."
 *
 * The app has always had that behaviour on /web/video: `apps/experimental/
 * routes/video` renders an OSD toolbar inside a <Fade> driven by the
 * SHOW_VIDEO_OSD event, and `apps/experimental/components/AppToolbar`
 * suppressed the standard navigation toolbar by testing
 * `location.pathname === '/web/video'`. Identifying a view by a literal URL is
 * what broke: once playback canonicalizes its address to `/w/<alias>`, the
 * very same view is on screen under a different path, so the navigation
 * toolbar rendered permanently over the movie and the OSD toolbar never
 * rendered at all.
 *
 * These assert what the viewer sees rather than which component rendered:
 * every header-shaped bar across the top of the viewport is measured for
 * effective opacity through its whole ancestor chain, because a <Fade> leaves
 * the element mounted and full-size at opacity 0, and `display: none` is
 * inherited from an ancestor the selector never names.
 */

interface OsdChromeState {
    controlsVisible: boolean
    topBarCount: number
    topBars: string[]
}

/**
 * Describes every header-shaped bar that is actually visible across the top of
 * the viewport, plus whether the playback controls are up.
 *
 * "Visible" is deliberately not `toBeVisible()`: MUI's Fade keeps the toolbar
 * mounted at its full size with opacity 0, and the legacy `.skinHeader` lives
 * inside a `display: none` wrapper under the experimental layout. Both satisfy
 * Playwright's visibility heuristics in at least one direction, so this walks
 * the ancestor chain and multiplies the computed opacity instead.
 */
async function osdChromeState(page: Page): Promise<OsdChromeState> {
    return page.evaluate(() => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };

        const effectiveOpacity = (element: Element): number | null => {
            let opacity = 1;
            let node: Element | null = element;
            while (node) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return null;
                opacity *= Number.parseFloat(style.opacity) || 0;
                node = node.parentElement;
            }
            return opacity;
        };

        const describe = (element: Element): string | null => {
            const opacity = effectiveOpacity(element);
            if (opacity === null || opacity <= 0.05) return null;

            const box = element.getBoundingClientRect();
            // A header spans the top of the screen. Anything narrow, zero
            // height, or below the top quarter of the viewport is some other
            // toolbar (a dialog's, the OSD's own bottom bar) and is not what
            // was reported.
            if (box.height <= 0 || box.width < viewport.width * 0.5) return null;
            if (box.top > viewport.height * 0.25 || box.bottom <= 0) return null;

            const classes = (element.className || '').toString().trim().replace(/\s+/g, '.');
            return `${element.tagName.toLowerCase()}.${classes} opacity=${opacity.toFixed(2)} top=${Math.round(box.top)} height=${Math.round(box.height)}`;
        };

        const topBars = Array.from(document.querySelectorAll('.MuiAppBar-root, .MuiToolbar-root, .skinHeader'))
            .map(describe)
            .filter((entry): entry is string => entry !== null);

        const controls = document.querySelector('.videoOsdBottom-maincontrols');
        const controlsOpacity = controls ? effectiveOpacity(controls) : null;

        return {
            controlsVisible: controlsOpacity !== null && controlsOpacity > 0.05,
            topBarCount: topBars.length,
            topBars
        };
    });
}

/** Plays an item and waits until the address has canonicalized to /w/<alias>. */
async function playUntilCanonicalized(
    page: Page,
    config: { username: string, password: string, itemId: string, serverId: string }
) {
    await login(page, config.username, config.password);

    // config.itemId deliberately: it direct-plays. E2E_CONTROLS_ITEM_ID is AC3,
    // which Chrome cannot decode, so the server transcodes it and the run
    // measures transcode throughput on a 2-core box instead of chrome.
    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 60_000 })
        .toBe(true);

    await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 90_000 });

    // Canonicalization currently rebuilds the player once (c159), so settle
    // before measuring chrome rather than racing that rebuild.
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 60_000 })
        .toBe(true);

    return video;
}

/** Wakes the OSD the way a viewer does, and waits for the controls to be up. */
async function showOsd(page: Page) {
    await page.mouse.move(20, 20);
    await page.mouse.move(120, 120);
    await expect
        .poll(() => osdChromeState(page), { timeout: 15_000 })
        .toMatchObject({ controlsVisible: true });
}

// @covers video_osd_chrome.header_is_present_while_the_controls_are_up
test('the header is on screen while the playback controls are up', async ({ page, config }) => {
    await playUntilCanonicalized(page, config);
    await showOsd(page);

    const state = await osdChromeState(page);
    expect(
        state.topBarCount,
        `expected a header across the top while the playback controls are up: ${JSON.stringify(state)}`
    ).toBeGreaterThan(0);
});

// @covers video_osd_chrome.header_does_not_persist_when_the_controls_fade
test('the header goes away when the playback controls fade', async ({ page, config }) => {
    await playUntilCanonicalized(page, config);
    await showOsd(page);

    // The OSD hides itself after three idle seconds. Nothing here moves the
    // mouse again, so this is the viewer sitting still and watching the movie.
    await expect
        .poll(() => osdChromeState(page), {
            message: 'the playback controls faded but a header bar stayed on screen over the movie',
            timeout: 30_000
        })
        .toMatchObject({ controlsVisible: false, topBarCount: 0 });
});

// @covers video_osd_chrome.header_returns_after_leaving_the_player
test('the navigation header comes back after leaving the player', async ({ page, config }) => {
    await playUntilCanonicalized(page, config);
    await showOsd(page);

    await page.goBack();

    // Suppressing the navigation toolbar for playback must not outlive
    // playback: the way to break this test is to fix the one above by deleting
    // the header rather than by tying it to the OSD.
    await expect
        .poll(() => onScreenState(page, '.MuiAppBar-root'), {
            message: 'the navigation toolbar did not come back after leaving the player',
            timeout: 60_000
        })
        .toMatchObject({ found: true, insideViewport: true });
});
