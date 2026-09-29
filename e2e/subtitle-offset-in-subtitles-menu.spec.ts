// SlopTank modification notice: added by SlopTank on 2026-09-29.
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

/**
 * The subtitle offset entry lives on the Subtitles (CC) menu, right after the
 * appearance entry (owner decision 2026-09-27); the gear menu no longer
 * offers it. Placement and real-user reachability are the assertions here --
 * the cue-shift physics the slider drives are covered by
 * subtitle-sync-controls.spec.ts and subtitle-ass-rendering.spec.ts.
 */

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
 * pressable by a user, after the opening action sheet has finished fading
 * out: its .dialogBackdrop lingers at opacity 0 with pointer-events auto and
 * swallows presses while it is still in the DOM.
 */
async function expectOverlayReachable(page: import('@playwright/test').Page, selector: string) {
    await expect(page.locator('.dialogBackdrop')).toHaveCount(0);
    expect(await onScreenState(page, selector)).toMatchObject({
        found: true, insideViewport: true, reachable: true
    });
}

test('Subtitle Offset is offered on the Subtitles menu and opens the offset slider', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    // The entry shows only while a subtitle track is active, so enable one
    // through the same menu a user operates, and prove it is active the
    // deterministic way: parked on a rendered cue (an unprompted cue
    // assertion at an arbitrary playhead fails whenever the playhead sits in
    // silence, which is a fixture property, not a player bug).
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    await page.locator('.actionSheetMenuItem', { hasText: 'English' }).first().click();
    const subtitleLine = page.locator('.videoSubtitlesInner:not(.videoSubtitlesPreviewLine)');
    await parkOnCue(video, subtitleLine);

    // The gear menu no longer lists the offset entry.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
    await expect(page.locator('.actionSheetMenuItem', { hasText: 'Subtitle Offset' })).toHaveCount(0);
    // Dismiss the way a user does, with a press on the backdrop's corner,
    // safely away from the centered sheet: dismissal without a selection is
    // a supported sheet interaction, and this stays independent of any
    // keyboard handling.
    await page.mouse.click(5, 5);
    await expect(page.locator('.dialogBackdrop')).toHaveCount(0);

    // ...while the Subtitles menu carries it, on screen and reachable, right
    // where a user looking for subtitle controls will find it.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    const offsetItem = page.locator('.actionSheetMenuItem[data-id="subtitleoffset"]');
    await expect(offsetItem).toBeVisible();

    // toBeVisible() passes for a control laid out under another layer or
    // below the fold; a menu entry means nothing unless a user can press it.
    const placement = await onScreenState(page, '.actionSheetMenuItem[data-id="subtitleoffset"]');
    expect(placement).toMatchObject({ found: true, insideViewport: true, reachable: true });
    // Directly under the appearance entry, per the owner decision.
    const itemNames = await page.locator('.actionSheetMenuItem').allTextContents();
    expect(itemNames.map(name => (name || '').trim()).indexOf('Subtitle Offset'))
        .toBe(itemNames.map(name => (name || '').trim()).indexOf('Subtitle Appearance') + 1);

    await offsetItem.click();
    await expect(page.locator('.subtitleSyncContainer')).toBeVisible();
    await expectOverlayReachable(page, '.subtitleSyncContainer');

    // The overlay this opens is the same subtitle sync control the gear entry
    // used to open: a real slider holding a numeric offset value.
    const sliderValue = await page.locator('.subtitleSyncSlider').inputValue();
    expect(Number.isFinite(parseFloat(sliderValue)), `offset slider value "${sliderValue}" is numeric`).toBe(true);
});
