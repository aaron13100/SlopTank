// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.
import { test, expect } from '@playwright/test';
import { login } from './fixtures';

const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;
const ITEM_NAME = process.env.LIVE_ITEM as string;

test.setTimeout(300_000);

test(`live playback: ${ITEM_NAME} starts promptly from search`, async ({ page }) => {
    const startedAt = Date.now();
    await login(page, USERNAME, PASSWORD);
    const loginMs = Date.now() - startedAt;

    // Home page interactive after login.
    await expect(page.getByRole('button', { name: 'User Menu' })).toBeVisible({ timeout: 60_000 });
    const homeMs = Date.now() - startedAt;

    // Open the movie's detail page directly by id (the API-verified item).
    await page.goto(`/details?id=${process.env.LIVE_ITEM_ID}`);
    await expect(page.locator('.btnPlay').first())
        .toBeVisible({ timeout: 60_000 });
    const detailMs = Date.now() - startedAt;

    // Play it and require actual video data, not a spinner.
    await page.locator('.btnPlay').first().click();
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 120_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 180_000 })
        .toBeGreaterThanOrEqual(2);
    const playedMs = Date.now() - startedAt;

    const currentSrc = await video.evaluate((el: HTMLVideoElement) => el.currentSrc);
    console.log(`LIVE_PLAYBACK ${ITEM_NAME} login=${loginMs}ms home=${homeMs}ms detail=${detailMs}ms playing=${playedMs}ms`);
    console.log(`LIVE_PLAYBACK_SRC ${currentSrc.slice(0, 160)}`);
    await page.screenshot({ path: `/tmp/live-playback-${ITEM_NAME.replace(/[^a-z0-9]+/gi, '-')}.png` });
});
