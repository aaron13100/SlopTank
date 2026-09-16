// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.
import { test } from '@playwright/test';
import { login } from './fixtures';

// Every sibling probe in this file family sets an explicit generous timeout
// for this contended 2-core box; this was the one exception left on
// Playwright's 30s default, which the initial page.goto alone can exceed
// under load (observed 2026-09-16: "Test timeout of 30000ms exceeded" still
// inside page.goto('/web/#/login'), before login() even ran).
test.setTimeout(120_000);

test('login probe', async ({ page }) => {
    const t0 = Date.now();
    await login(page, process.env.E2E_USERNAME as string, process.env.E2E_PASSWORD as string);
    console.log('LOGIN_OK', Date.now() - t0, 'ms', page.url());
    await page.screenshot({ path: '/tmp/login-probe.png' });
});
