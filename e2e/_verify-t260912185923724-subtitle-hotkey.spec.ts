// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * One-off real-browser verification for queue task c180 / t_260912_185923_724
 * (subtitle-cycle hotkey): the 'c'/'C' hotkey cycles subtitle tracks with an
 * immediate toast, disambiguates same-language tracks via DisplayTitle, and
 * the Space-bar fix respects a focused OSD button instead of always forcing
 * play/pause.
 *
 * Targets the LOCAL DEV SERVER (not the production build at :8096) so it
 * exercises this task's not-yet-shipped source, per playwright.config.ts's
 * own _verify-t<taskid>-* convention (excluded from the standing suite; run
 * directly with this task's env vars set):
 *
 *   E2E_BASE_URL=http://localhost:8081 npx playwright test \
 *     e2e/_verify-t260912185923724-subtitle-hotkey.spec.ts --project=chromium
 *
 * Item: "2:00 P.M." (The Pitt S01E08, ef2d373c566ee0f5f8d4e8526118af21), a
 * real library item confirmed (via a direct Jellyfin API read, queue task
 * c180's own investigation) to carry three subtitle tracks including two
 * English variants (SRT vs ASS) distinguished only by DisplayTitle -- the
 * exact case item 3 of the spec calls out ("a toast that says 'English'
 * twice in a row... is the failure to avoid").
 *
 * Once this task ships, promote whichever assertions here are worth a
 * standing regression into a real named spec instead of leaving this
 * one-off in place (see the testIgnore comment in playwright.config.ts).
 */
import { expect } from '@playwright/test';

import { test, login, revealOsdControl } from './fixtures';

// This host runs under real ambient contention (see playwright.config.ts's
// own loadScaledMs comment); match the other player specs in e2e/ that set
// 120-300s for the same reason rather than the framework's 30s default.
test.setTimeout(300_000);

const PITT_E08_ITEM = 'ef2d373c566ee0f5f8d4e8526118af21';

/**
 * Start playback of a specific item from its detail page, the way a user
 * does. Mirrors subtitle-track-selection.spec.ts's helper of the same name.
 */
async function startPlayback(
    page: import('@playwright/test').Page,
    config: { serverId: string },
    itemId: string
) {
    await page.goto(`/web/#/details?id=${itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate(
            (el: HTMLVideoElement) => !el.paused && el.readyState >= 2
        ), { timeout: 60_000 })
        .toBe(true);
    return video;
}

/**
 * Record every toast's text as it appears, via a page-side MutationObserver
 * (same pattern as fixtures.ts's countDeliveredPresses), rather than reading
 * it back from the DOM after the fact: toast.ts removes each element ~3.6s
 * after creation, so under this host's real ambient load (see CLAUDE.md's
 * "no quiet box" doctrine) a `.toastContainer .toast` count-based read races
 * that removal and can undercount or miss earlier toasts entirely.
 */
async function watchToasts(
    page: import('@playwright/test').Page
): Promise<import('@playwright/test').JSHandle<{ texts: string[] }>> {
    return page.evaluateHandle(() => {
        const record: { texts: string[] } = { texts: [] };
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (node instanceof HTMLElement && node.classList.contains('toast')) {
                        record.texts.push(node.textContent || '');
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return record;
    });
}

test('c/C cycles subtitle tracks with an immediate, disambiguated toast', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await startPlayback(page, config, PITT_E08_ITEM);

    // Move focus off whatever OSD control the app auto-focused when it
    // showed the OSD (video/index.js's showMainOsdControls() defaults focus
    // to .btnPause), so the hotkey is not eaten by a focused button. A real
    // click at this point does not reliably land on the raw <video> element:
    // a full-page click-catcher div sits above it in the OSD's own layering
    // to handle single/double-click toggling, and Playwright refuses to
    // punch through that on purpose.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const toastWatcher = await watchToasts(page);

    for (let i = 0; i < 4; i++) {
        const before = await toastWatcher.evaluate(r => r.texts.length);
        await page.keyboard.press('c');
        await expect
            .poll(() => toastWatcher.evaluate(r => r.texts.length), { timeout: 10_000, message: 'expected a new toast after pressing c' })
            .toBeGreaterThan(before);
    }

    const seen = await toastWatcher.evaluate(r => r.texts);
    console.log('[c180 verify] observed toast sequence:', JSON.stringify(seen));

    // Every tap must produce a distinct label from the one immediately
    // before it -- the two English tracks (SRT vs ASS) must not both read
    // "Subtitles: English".
    for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).not.toBe(seen[i - 1]);
    }
    expect(seen.every(text => text.startsWith('Subtitles:'))).toBe(true);
});

test('Space toggles play/pause on the bare video but not when focus is on the Subtitles button', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config, PITT_E08_ITEM);

    // Space on the bare video toggles play/pause and back. Blur, not a
    // click: see the sibling test's comment on why a click does not
    // reliably land on the raw <video> element.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const pausedBefore = await video.evaluate((el: HTMLVideoElement) => el.paused);
    await page.keyboard.press('Space');
    await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 })
        .toBe(!pausedBefore);
    await page.keyboard.press('Space');
    await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 })
        .toBe(pausedBefore);

    // Space on a focused OSD button (Subtitles) must activate the button
    // (open its menu), not toggle playback.
    const subtitlesButton = await revealOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await subtitlesButton.focus();
    const pausedBeforeMenu = await video.evaluate((el: HTMLVideoElement) => el.paused);
    await page.keyboard.press('Space');
    await expect(page.locator('.dialogContainer .dialog.opened')).toBeVisible({ timeout: 10_000 });
    const pausedAfterMenu = await video.evaluate((el: HTMLVideoElement) => el.paused);
    expect(pausedAfterMenu).toBe(pausedBeforeMenu);
});
