// SlopTank modification notice: added or changed by SlopTank on 2026-09-15.
import { test, expect } from '@playwright/test';
import { login } from './fixtures';

const ALIAS = process.env.T260904_ALIAS as string;
const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;

test.setTimeout(300_000);

test('t_260904_113604_449 product verification: converted permalinked file still plays at its watch link', async ({ page }) => {
    await login(page, USERNAME, PASSWORD);

    await page.goto(`/w/${ALIAS}`);

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 120_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 120_000 })
        .toBeGreaterThanOrEqual(2);

    const currentSrc = await video.evaluate((el: HTMLVideoElement) => el.currentSrc);
    console.log('T260904_RESULT_URL', page.url());
    console.log('T260904_RESULT_SRC', currentSrc);
    await page.screenshot({ path: process.env.T260904_SCREENSHOT || '/tmp/t260904-watch-page.png' });
});
