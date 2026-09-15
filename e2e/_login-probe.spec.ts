// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.
import { test } from '@playwright/test';
import { login } from './fixtures';

test('login probe', async ({ page }) => {
    const t0 = Date.now();
    await login(page, process.env.E2E_USERNAME as string, process.env.E2E_PASSWORD as string);
    console.log('LOGIN_OK', Date.now() - t0, 'ms', page.url());
    await page.screenshot({ path: '/tmp/login-probe.png' });
});
