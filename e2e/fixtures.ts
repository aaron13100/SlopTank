import { test as base, expect } from '@playwright/test';

export interface E2eConfig {
    username: string;
    password: string;
    itemId: string;
    serverId: string;
}

function requireEnv(name: string): string {
    const value = process.env[name]; // allow-direct-env: this IS the e2e config adapter, the single place that reads these vars
    if (!value) {
        throw new Error( // allow-raw-error: test setup fast-fail, not user-facing production code
            `Missing required env var ${name}. Set E2E_USERNAME, E2E_PASSWORD, `
            + 'E2E_ITEM_ID, and E2E_SERVER_ID (a real login and a real, already-playable '
            + 'library item id/server id on the target Jellyfin instance) before running '
            + 'the e2e suite.'
        );
    }
    return value;
}

export const test = base.extend<{ config: E2eConfig }>({
    // eslint-disable-next-line no-empty-pattern
    config: async ({}, use) => {
        await use({
            username: requireEnv('E2E_USERNAME'),
            password: requireEnv('E2E_PASSWORD'),
            itemId: requireEnv('E2E_ITEM_ID'),
            serverId: requireEnv('E2E_SERVER_ID')
        });
    }
});

export interface OnScreenState {
    found: boolean;
    insideViewport: boolean;
    reachable: boolean;
    rect: { x: number, y: number, width: number, height: number } | null;
    viewport: { width: number, height: number };
    topElementAtCenter: string | null;
}

/**
 * Report whether an element is really on screen for a user: fully inside the
 * viewport AND the element the browser actually hits at its own center.
 *
 * Playwright's toBeVisible() only requires a non-empty box, so it passes for an
 * overlay rendered below the fold or buried under another layer. That gap
 * shipped a subtitle-size slider the user could never see or click (it was laid
 * out at y = viewport height). Assert with this for anything the user must be
 * able to both see and press.
 *
 * @param page - Page under test.
 * @param selector - CSS selector for the element the user must be able to use.
 * @returns Placement facts, including diagnostics for a failure message.
 */
export async function onScreenState(page: import('@playwright/test').Page, selector: string): Promise<OnScreenState> {
    return page.evaluate((sel: string) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const el = document.querySelector(sel);
        if (!el) {
            return { found: false, insideViewport: false, reachable: false, rect: null, viewport, topElementAtCenter: null };
        }

        const box = el.getBoundingClientRect();
        const rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
        const insideViewport = box.width > 0 && box.height > 0
            && box.top >= 0 && box.left >= 0
            && box.bottom <= viewport.height && box.right <= viewport.width;

        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const hit = insideViewport ? document.elementFromPoint(centerX, centerY) : null;
        const hitClasses = hit ? (hit.className || '').toString().trim().replace(/\s+/g, '.') : '';
        const topElementAtCenter = hit ? `${hit.tagName.toLowerCase()}.${hitClasses}` : null;

        return {
            found: true,
            insideViewport,
            reachable: !!hit && (hit === el || el.contains(hit)),
            rect,
            viewport,
            topElementAtCenter
        };
    }, selector);
}

export async function login(page: import('@playwright/test').Page, username: string, password: string) {
    await page.goto('/web/#/login');

    // Wait for the public-user request to finish before changing forms. Clicking
    // Manual Login earlier races loadUserList(), which switches back to the
    // visual form and leaves Playwright targeting a hidden submit button.
    const userButton = page.getByRole('button', { name: username, exact: true });
    await userButton.click();

    const manualForm = page.locator('.manualLoginForm:visible');
    await expect(manualForm).toBeVisible();
    await manualForm.locator('#txtManualName').fill(username);
    await manualForm.locator('#txtManualPassword').fill(password);

    // The app's global loading spinner is a full-page overlay (see
    // components/loading/loading.ts) that can still cover the submit button
    // even after the form itself is visible and fillable.
    const spinner = page.locator('.docspinner.mdlSpinnerActive');
    if (await spinner.count() > 0) {
        await spinner.waitFor({ state: 'hidden', timeout: 15_000 });
    }

    await manualForm.locator('.button-submit').click();

    await page.waitForURL(/#\/home/, { timeout: 30_000 });
}

export { expect };
