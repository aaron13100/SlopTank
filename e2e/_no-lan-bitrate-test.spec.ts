// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.
//
// LAN play must not run the server's /Playback/BitrateTest probe before
// starting playback.
//
// Why: every browser client of this server is on the LAN, the library is
// pre-encoded for universal direct play, and the server cannot transcode in
// real time on 2 cores. Automatic bitrate detection on the LAN bought
// nothing and cost twice: ~2s of click-to-play latency (the server writes a
// 3MB test payload) and, under load, a LOW measurement that requested a
// transcode this box cannot perform. Remote (not in-network) playback keeps
// detection; only the in-network Video path skips it.
//
// This spec plays a real item in a real browser and fails if any request to
// /Playback/BitrateTest crosses the wire during the play flow.
import { test, expect, login } from './fixtures';

// The spec's own locator budgets are 60s; under measured box load a cold
// browser needs most of that for page boot, so the default 30s test timeout
// would cut the flow short mid-expect (observed 2026-09-15 at load 24: the
// details page rendered with its Play button after the timeout had already
// failed the test).
test.setTimeout(240_000);

test('LAN playback starts without a bitrate-test round trip', async ({ page }) => {
    const bitrateTestUrls: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('/Playback/BitrateTest')) {
            bitrateTestUrls.push(request.url());
        }
    });

    await login(page, process.env.E2E_USERNAME!, process.env.E2E_PASSWORD!);

    // The item id must be a required env var with a hard fail, not an
    // optional one: an unset LIVE_ITEM_ID navigated to /details?id=undefined,
    // which renders the not-found page and fails on the Play-button locator
    // -- a misleading failure that looks like a player bug (seen 2026-09-15;
    // the var had only ever been set by ad-hoc shell exports).
    const itemId = process.env.E2E_RENTAL_FAMILY_ITEM_ID;
    if (!itemId) {
        throw new Error( // allow-raw-error: e2e setup fast-fail, not app code
            'Missing required env var E2E_RENTAL_FAMILY_ITEM_ID for the LAN bitrate test');
    }

    await page.goto(`/details?id=${itemId}`);
    // The details page renders both a Play button and, once the item has a
    // resume position, a hidden Resume variant of the same class; target the
    // visible one so the click is always the button a user would press.
    await expect(page.locator('.btnPlay:visible').first()).toBeVisible({ timeout: 60_000 });
    await page.locator('.btnPlay:visible').first().click();

    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => await video.evaluate(
        (v: HTMLVideoElement) => (v.readyState >= 2 && v.currentTime > 0) ? v.currentTime : -1
    ), { timeout: 60_000 }).toBeGreaterThan(0);

    expect(video, 'playback must actually start').toBeVisible();
    expect(bitrateTestUrls, 'no /Playback/BitrateTest request may cross the wire on a LAN play')
        .toEqual([]);
});
