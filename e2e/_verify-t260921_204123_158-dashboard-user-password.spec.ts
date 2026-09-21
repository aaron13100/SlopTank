// SlopTank modification notice: added or changed by SlopTank on 2026-09-22.
import { expect, test } from '@playwright/test';
import { login, onScreenState } from './fixtures';

/**
 * One-off verification spec for i265 (t_260921_204123_158): the dashboard user
 * Password page spinner-forevered on a bare /web/dashboard/users/password URL
 * because a disabled useUser query stays pending forever behind the Loading
 * gate. The page now falls back to the logged-in user.
 *
 * NOT part of the standing suite (the _verify-t prefix is excluded by
 * playwright.config.ts): test 3 actually saves a password, and the server
 * revokes every other token of that user on a password save (UserController
 * UpdateUserPassword -> RevokeUserTokens), so test 3 must only be run with a
 * disposable admin user created for the run, never with a real account that
 * holds other sessions. Promote the render assertions of tests 1 and 2 into a
 * standing named spec when the fixed build ships.
 *
 * Env: E2E_USERNAME, E2E_PASSWORD, E2E_BASE_URL. Tests 1 and 2 accept any
 * admin; test 3 requires the disposable-admin setup above.
 */
const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;

test.setTimeout(180_000);

test('bare password URL renders the logged-in user form', async ({ page }) => {
    await page.goto('/web/#/login', { waitUntil: 'domcontentloaded' });
    await login(page, USERNAME, PASSWORD);
    await page.goto('/web/dashboard/users/password', { waitUntil: 'domcontentloaded' });

    await expect.poll(
        () => onScreenState(page, '#txtNewPassword'),
        { message: 'expected the new-password field on screen for a bare password URL', timeout: 30_000 }
    ).toMatchObject({ found: true, insideViewport: true, reachable: true });

    // A user that logged in with a password must be offered the
    // current-password field; failing here means the environment changed.
    await expect(page.locator('#txtCurrentPassword')).toBeVisible({ timeout: 10_000 });
});

test('password tab from a user profile still renders', async ({ page }) => {
    await page.goto('/web/#/login', { waitUntil: 'domcontentloaded' });
    await login(page, USERNAME, PASSWORD);
    await page.goto('/web/dashboard/users', { waitUntil: 'domcontentloaded' });

    const profileLink = page.locator('a[href*="users/profile?userId="]').first();
    await expect(profileLink).toBeVisible({ timeout: 30_000 });
    await profileLink.click();

    const passwordTab = page.locator('.localnav :text("Password")').first();
    await expect(passwordTab).toBeVisible({ timeout: 30_000 });
    await passwordTab.click();

    await expect.poll(
        () => onScreenState(page, '#txtNewPassword'),
        { message: 'expected the new-password field on screen via the Password tab', timeout: 30_000 }
    ).toMatchObject({ found: true, insideViewport: true, reachable: true });
});

test('bare password URL saves a password (disposable admin only)', async ({ page }) => {
    await page.goto('/web/#/login', { waitUntil: 'domcontentloaded' });
    await login(page, USERNAME, PASSWORD);
    await page.goto('/web/dashboard/users/password', { waitUntil: 'domcontentloaded' });

    await expect.poll(
        () => onScreenState(page, '#txtNewPassword'),
        { message: 'expected the new-password field on screen for a bare password URL', timeout: 30_000 }
    ).toMatchObject({ found: true, insideViewport: true, reachable: true });

    // Re-submits the env user's own current password, so it round-trips the
    // save path without changing any credential. The server still revokes the
    // user's other tokens (see file header), hence disposable-admin-only.
    await page.locator('#txtCurrentPassword').click();
    await page.keyboard.type(PASSWORD);
    await page.locator('#txtNewPassword').click();
    await page.keyboard.type(PASSWORD);
    await page.locator('#txtNewPasswordConfirm').click();
    await page.keyboard.type(PASSWORD);
    await page.locator('.updatePasswordForm button[type="submit"]').click();

    await expect(page.getByText('Password saved.')).toBeVisible({ timeout: 30_000 });
});
