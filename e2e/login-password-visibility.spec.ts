// SlopTank modification notice: added or changed by SlopTank on 2026-11-04.
/** The login password control must be on screen and operable with real input. */
import { test, expect } from '@playwright/test';
import { onScreenState } from './fixtures';
import { loadScaledMs } from './load-scaled-bounds';

test.setTimeout(loadScaledMs(120_000));

for (const layout of ['desktop', 'experimental']) {
    test.describe(layout, () => {
        test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
        test('password visibility is reachable by mouse, keyboard and touch', async ({ page }, testInfo) => {
            await page.addInitScript(value => {
                localStorage.setItem('layout', value);
                // The known dev-only runtime overlay intercepts otherwise reachable app controls.
                new MutationObserver(() => {
                    document.getElementById('webpack-dev-server-client-overlay')?.remove();
                }).observe(document, { childList: true, subtree: true });
            }, layout);
            await page.goto('/web/index.html');
            const selectServer = page.getByRole('heading', { name: 'Select Server' });
            const password = page.locator('#txtManualPassword:visible');
            const manual = page.getByRole('button', { name: 'Manual Login', exact: true });
            await expect(selectServer.or(password).or(manual)).toBeVisible({ timeout: loadScaledMs(60_000) });
            if (await selectServer.isVisible()) {
                await page.getByText('Add Server', { exact: true }).click();
                await page.getByLabel('Host').fill(new URL(page.url()).origin);
                await page.getByText('Connect', { exact: true }).click();
            }
            await expect(password.or(manual)).toBeVisible({ timeout: loadScaledMs(60_000) });
            if (!(await password.isVisible())) await manual.click();
            await password.fill('Visible password check');
            const toggle = page.locator('#btnTogglePassword');
            await expect.poll(async () => onScreenState(page, '#btnTogglePassword')).toMatchObject({
                found: true, insideViewport: true, reachable: true
            });
            await expect(password).toHaveAttribute('type', 'password');
            await toggle.click();
            await expect(password).toHaveAttribute('type', 'text');
            await expect(toggle).toHaveAttribute('aria-pressed', 'true');
            await password.focus();
            await page.keyboard.press('Tab');
            await expect(toggle).toBeFocused();
            await page.keyboard.press('Space');
            await expect(password).toHaveAttribute('type', 'password');
            await page.keyboard.press('Enter');
            await expect(password).toHaveAttribute('type', 'text');
            await toggle.tap();
            await expect(password).toHaveAttribute('type', 'password');
            await expect(password).toHaveValue('Visible password check');
            await expect(page.locator('#loginPage')).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath('password-control.png') });
        });
    });
}
