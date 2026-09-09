// SlopTank modification notice: added or changed by SlopTank on 2026-08-29, 2026-09-09.
import { expect, test } from './fixtures';

test.setTimeout(180_000);

/** Browser-level health checks for the configured E2E origin and harness. */

test('the suite reaches the app and Jellyfin API through its configured origin', async ({ page }) => {
    await page.goto('/web/#/login');

    await expect(page.locator('#loginPage')).toBeVisible({ timeout: 30_000 });

    const publicInfo = await page.evaluate(async () => {
        const response = await fetch('/System/Info/Public');
        return {
            status: response.status,
            body: await response.json() as { ProductName?: string, ServerName?: string }
        };
    });
    expect(publicInfo).toMatchObject({
        status: 200,
        body: { ProductName: 'Jellyfin Server' }
    });
    await expect(page).toHaveTitle(publicInfo.body.ServerName ?? 'SlopTank');
});

test('the browser harness removes a late webpack error overlay', async ({ page }) => {
    await page.goto('/web/');
    await page.evaluate(() => {
        const overlay = document.createElement('iframe');
        overlay.id = 'webpack-dev-server-client-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
        document.body.append(overlay);
    });

    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
});
