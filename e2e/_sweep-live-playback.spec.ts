import { test, expect } from '@playwright/test';
import { login } from './fixtures';

/**
 * Live-site playback sweep over a caller-supplied item list.
 *
 * Plays every item in LIVE_SWEEP_IDS (comma-separated Jellyfin item ids) in
 * one logged-in browser session, sequentially, and records per-item start
 * latency and stream URL. One item at a time keeps the contended 2-core host
 * under the same load a single real viewer produces, so a failure means the
 * item is broken, not that the sweep saturated the box.
 *
 * Env: E2E_USERNAME, E2E_PASSWORD, E2E_BASE_URL, LIVE_SWEEP_IDS,
 * LIVE_SWEEP_BUDGET_MS (optional, default 90s per item).
 */
const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;
const IDS = (process.env.LIVE_SWEEP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const BUDGET = Number(process.env.LIVE_SWEEP_BUDGET_MS ?? 90_000);

test.setTimeout(45 * 60_000);

test(`live playback sweep over ${IDS.length} items`, async ({ page }) => {
    const failures: string[] = [];
    const results: string[] = [];

    await login(page, USERNAME, PASSWORD);
    await expect(page.getByRole('button', { name: 'User Menu' })).toBeVisible({ timeout: 60_000 });

    for (const id of IDS) {
        const startedAt = Date.now();
        try {
            await page.goto(`/details?id=${id}`, { waitUntil: 'domcontentloaded' });
            const playButton = page.locator('.btnPlay').first();
            await expect(playButton).toBeVisible({ timeout: 30_000 });
            await playButton.click();

            const video = page.locator('video').first();
            await expect(video).toBeVisible({ timeout: BUDGET });
            // readyState>=2 plus a clock tick proves real media data arrived,
            // not an element stuck on a spinner waiting for its first segment.
            await expect
                .poll(
                    async () => {
                        const state = await video.evaluate((el: HTMLVideoElement) => el.readyState);
                        const time = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
                        return state >= 2 && time > 0 ? 1 : 0;
                    },
                    { timeout: BUDGET }
                )
                .toBe(1);
            const src = await video.evaluate((el: HTMLVideoElement) => el.currentSrc);
            const ms = Date.now() - startedAt;
            const mode = /master\.m3u8|main\.m3u8/.test(src) ? 'transcode' : 'direct';
            const line = `SWEEP_OK ${id} ${ms}ms ${mode}`;
            console.log(line);
            results.push(line);
        } catch (error) {
            let src = 'no-video-element';
            try {
                src = (await page.locator('video').first().evaluate((el: HTMLVideoElement) => el.currentSrc)).slice(0, 120);
            } catch (srcError) {
                src = `src-unavailable: ${srcError instanceof Error ? srcError.message.slice(0, 80) : String(srcError)}`;
            }
            const line = `SWEEP_FAIL ${id} ${Date.now() - startedAt}ms src=${src} ${
                error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : String(error)
            }`;
            console.log(line);
            results.push(line);
            failures.push(id);
        }
    }

    console.log(`SWEEP_SUMMARY total=${IDS.length} failed=${failures.length}`);
    expect(failures, `broken items: ${failures.join(',')}`).toEqual([]);
});
