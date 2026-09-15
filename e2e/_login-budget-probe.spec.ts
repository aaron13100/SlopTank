// SlopTank modification notice: added or changed by SlopTank on 2026-09-15.
// Goal probe (owner-set 2026-09-15): login budget applies to the window a
// user feels -- submitting credentials to the home screen rendered -- plus a
// warm repeat visit. Cold-Chrome launch cost is logged separately and is NOT
// part of the budget (real viewers run a warm browser; the cold number
// measures this box's Avast-taxed process spawn, tracked as its own line).
// Budget is load-conditional per the goal: 1s on a quiet box, 3s under load.
import os from 'node:os';
import { test, expect } from '@playwright/test';

const QUIET_BUDGET_MS = 1_000;
const LOADED_BUDGET_MS = 3_000;
const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;

test.setTimeout(240_000);

async function timedLogin(page: import('@playwright/test').Page) {
    const marks: string[] = [];
    const base = Date.now();
    const at = () => `${Date.now() - base}ms`;
    const bind = (p: import('@playwright/test').Page) => {
        p.context().on('request', (r) => {
            if (/authenticatebyname/i.test(r.url())) marks.push(`${at()} AUTH-REQ`);
            if (!/\.(js|css|woff2?|png|ico|svg)/.test(r.url()) && !r.url().includes('/Images/')) {
                marks.push(`${at()} req ${r.method()} ${r.url().split('8096')[1]?.slice(0, 55) ?? r.url().slice(-55)}`);
            }
        });
        p.context().on('response', (r) => {
            if (/authenticatebyname/i.test(r.url())) marks.push(`${at()} AUTH-RES`);
        });
    };
    bind(page);
    await page.goto('/web/#/login');
    const manualForm = page.locator('.manualLoginForm:visible');
    const anyUserTile = page.locator('#divUsers button').first();
    await expect(anyUserTile.or(manualForm).or(
        page.getByRole('heading', { name: 'Select Server' })
    )).toBeVisible({ timeout: 60_000 });
    await (await manualForm.isVisible()
        ? Promise.resolve()
        : (anyUserTile.isVisible().then((v) => v ? anyUserTile.click() : page.getByRole('button', { name: 'Manual Login', exact: true }).click())));
    await expect(manualForm).toBeVisible();
    await manualForm.locator('#txtManualName').fill(USERNAME);
    await manualForm.locator('#txtManualPassword').fill(PASSWORD);
    marks.push(`${at()} SUBMIT`);
    const t0 = Date.now();
    await manualForm.locator('.button-submit').click();
    await page.waitForURL(/(#\/home|\/web\/home)/, { timeout: 60_000 });
    marks.push(`${at()} URL-FLIP`);
    console.log(`SUBMIT-TRACE ${marks.join(' | ')}`);
    return Date.now() - t0;
}

test('login submit-to-home timing, cold and warm', async ({ page, browser }) => {
    const load1 = os.loadavg()[0];
    const budget = load1 < 3 ? QUIET_BUDGET_MS : LOADED_BUDGET_MS;
    const timingLines: string[] = [];
    const t0base = Date.now();
    page.on('response', (r) => {
        if (/AuthenticateByName|UserViews|Branding|QuickConnect|System\/Endpoint/.test(r.url())) {
            timingLines.push(`${Date.now() - t0base}ms ${r.status()} ${r.url().split('8096')[1]?.slice(0, 60)}`);
        }
    });
    const cold = await timedLogin(page);
    console.log('SUBMIT-WINDOW-TRACE', ...timingLines);
    const warms: number[] = [];
    for (let i = 0; i < 3; i++) {
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        warms.push(await timedLogin(p));
        await ctx.close();
    }
    console.log(`LOGIN-BUDGET cold=${cold}ms warm=${warms.join(',')}ms budget=${budget}ms load1=${load1.toFixed(2)}`);
    for (const value of [cold, ...warms]) {
        expect(value, `login submit-to-home within ${budget}ms at load ${load1.toFixed(2)}`).toBeLessThan(budget);
    }
});
