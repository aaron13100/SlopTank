// SlopTank modification notice: added or changed by SlopTank on 2026-09-15.
// Owner-named movies must always play (standing goal rule). Budget-agnostic:
// this asserts function (moving frames), not latency; latency budgets live
// in the latency probes.
import { test, expect, login } from './fixtures';

function requireMovieEnv(name: string): string {
    const value = name === 'Rental Family'
        ? process.env.E2E_RENTAL_FAMILY_ITEM_ID
        : process.env.E2E_WOOD_JOB_ITEM_ID;
    if (!value) {
        throw new Error( // allow-raw-error: e2e setup fast-fail, not app code
            `Missing required env var for the ${name} must-play test`);
    }
    return value;
}

const MOVIES = [
    ['Rental Family', () => requireMovieEnv('Rental Family')],
    ['Wood Job!', () => requireMovieEnv('Wood Job!')]
] as const;

test.setTimeout(180_000);

for (const [name, itemId] of MOVIES) {
    test(`playing ${name} end to end`, async ({ page, config }) => {
        await login(page, config.username, config.password);
        await page.goto(`/details?id=${itemId()}`);
        await expect(page.locator('.btnPlay:visible').first()).toBeVisible({ timeout: 90_000 });
        await page.locator('.btnPlay:visible').first().click();
        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 90_000 });
        await expect.poll(async () => video.evaluate(
            (el: HTMLVideoElement) => (el.readyState >= 2 && el.currentTime > 0) ? el.currentTime : -1
        ), { timeout: 90_000 }).toBeGreaterThan(0);
    });
}
