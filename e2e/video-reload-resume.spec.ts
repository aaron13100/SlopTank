// SlopTank modification notice: added by SlopTank on 2026-09-24.
/**
 * Regression coverage for queue task c273 (t_260922_231151_281): reloading
 * the video page did not reliably resume at the same position.
 *
 * Diagnosis (evidence-based, see the task's test-output.log for the full
 * probe transcript):
 *   - Save side: position is only persisted to the server via a 10s
 *     `setInterval` progress report, an immediate report on pause/unpause,
 *     and a best-effort `reportPlaybackStopped` fired from a `beforeunload`
 *     handler. That handler's report goes through a plain, non-keepalive
 *     `fetch()` (jellyfin-apiclient has no `sendBeacon`/`keepalive` path),
 *     so a hard reload can cancel it mid-flight before the server ever
 *     records the exact position. Measured: a reload after >20s of real
 *     playback resumed at ~3s (an 18s drift), because the last position the
 *     server actually had was from an earlier, already-stale report.
 *   - Restore side: `resumeFromPermalink()` in
 *     src/controllers/playback/video/index.js unconditionally re-unpauses
 *     after `playbackManager.play()`, with no check for whether the item was
 *     actually paused before the reload (Jellyfin's `UserData` carries no
 *     "was paused" flag at all, so the code had nothing to consult). Reload
 *     while paused therefore deterministically resumed PLAYING, every time.
 *
 * The fix adds a synchronous, local (sessionStorage) snapshot of
 * `{ itemId, serverId, positionTicks, paused }`, captured at the same
 * `beforeunload` moment as the existing network report but immune to its
 * cancellation race, and consumed by `resumeFromPermalink()` as the primary
 * source of truth for a same-tab reload (falling back to the server's
 * `UserData.PlaybackPositionTicks`, as before, when no matching snapshot
 * exists -- first visit, cross-device Continue Watching, or an explicit
 * permalink `t=` param, which already takes precedence).
 */
import { expect, login, onScreenState, test, VIDEO_ROUTE } from './fixtures';

test.setTimeout(300_000);

/** How far a resumed position may drift from where playback actually left off. */
const POSITION_TOLERANCE_SECONDS = 5;

async function startPlaybackPastIntro(page: import('@playwright/test').Page, config: { itemId: string, serverId: string }) {
    await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click({ timeout: 120_000 });
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 30_000 })
        .toBeGreaterThan(20);
    return video;
}

// @covers video.reload.mid_playback.resumes_near_same_position_and_playing
test('reload mid-playback resumes near the same position and keeps playing', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlaybackPastIntro(page, config);

    const before = await video.evaluate((el: HTMLVideoElement) => ({ t: el.currentTime, paused: el.paused }));
    expect(before.paused, 'video should be playing before reload').toBe(false);

    await page.reload();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    const videoAfter = page.locator('video').first();
    await expect(videoAfter).toBeVisible({ timeout: 20_000 });

    // The user must see this element, not just have it present in the DOM.
    const screenState = await onScreenState(page, 'video');
    expect(screenState.insideViewport, `video should be on screen after reload: ${JSON.stringify(screenState)}`).toBe(true);

    await expect
        .poll(
            async () => video.evaluate((el: HTMLVideoElement) => el.paused),
            { timeout: 20_000, message: 'reloaded playback should resume playing, not paused' }
        )
        .toBe(false);

    const after = await videoAfter.evaluate((el: HTMLVideoElement) => ({ t: el.currentTime, paused: el.paused }));
    const drift = Math.abs(after.t - before.t);
    expect(drift, `resumed position drifted ${drift.toFixed(2)}s from the pre-reload position `
        + `(before=${before.t.toFixed(2)}s, after=${after.t.toFixed(2)}s)`).toBeLessThanOrEqual(POSITION_TOLERANCE_SECONDS);
});

// @covers video.reload.while_paused.resumes_same_position_and_stays_paused
test('reload while paused resumes at the same position and stays paused', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlaybackPastIntro(page, config);

    // Real user input: spacebar toggles play/pause (video/index.js onKeyDown).
    await page.keyboard.press(' ');
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 })
        .toBe(true);

    // Let the pause's own progress report land before reloading, so this
    // test exercises the restore path, not the pause report's own race.
    await page.waitForTimeout(2_000);

    const before = await video.evaluate((el: HTMLVideoElement) => ({ t: el.currentTime, paused: el.paused }));
    expect(before.paused).toBe(true);

    await page.reload();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    const videoAfter = page.locator('video').first();
    await expect(videoAfter).toBeVisible({ timeout: 20_000 });

    const screenState = await onScreenState(page, 'video');
    expect(screenState.insideViewport, `video should be on screen after reload: ${JSON.stringify(screenState)}`).toBe(true);

    // Hold the assertion window: the buggy code path re-unpauses shortly
    // after play() resolves, so a single instant check right after load
    // would miss it.
    await page.waitForTimeout(5_000);

    const after = await videoAfter.evaluate((el: HTMLVideoElement) => ({ t: el.currentTime, paused: el.paused }));
    expect(after.paused, 'reloaded playback should stay paused when it was paused before the reload').toBe(true);

    const drift = Math.abs(after.t - before.t);
    expect(drift, `resumed position drifted ${drift.toFixed(2)}s from the pre-reload position `
        + `(before=${before.t.toFixed(2)}s, after=${after.t.toFixed(2)}s)`).toBeLessThanOrEqual(POSITION_TOLERANCE_SECONDS);
});
