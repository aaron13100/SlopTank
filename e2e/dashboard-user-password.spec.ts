// SlopTank modification notice: added or changed by SlopTank on 2026-09-30.
import { expect, test } from '@playwright/test';
import { login, onScreenState } from './fixtures';

/**
 * Standing regression spec for i265 (t_260921_204123_158): the dashboard user
 * Password page spinner-forevered on a bare /web/dashboard/users/password URL
 * because a disabled useUser query stays pending forever behind the Loading
 * gate. The page now falls back to the logged-in user. Promoted from the
 * one-off _verify spec once the fix shipped (c269).
 *
 * Render assertions only. The save path (submitting the form) is deliberately
 * NOT covered here and must never join the standing suite: the server revokes
 * every other token of the user on a password save (UserController
 * UpdateUserPassword -> RevokeUserTokens), which would sign out the real
 * account's other sessions.
 *
 * Env: E2E_USERNAME, E2E_PASSWORD, E2E_BASE_URL. Any admin account works.
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
