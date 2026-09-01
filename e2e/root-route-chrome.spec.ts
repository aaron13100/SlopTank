import { expect } from '@playwright/test';

import { test, login, onScreenState } from './fixtures';

test.setTimeout(180_000);

/**
 * Root-level pretty URLs must render the same app chrome as /web/*.
 *
 * The toolbar is not decoration: it is the only in-app navigation affordance on
 * these pages. When it is missing the user is stranded, with the browser's own
 * Back button as the only way out -- which is exactly how this was reported on
 * 2026-08-12 ("the header disappears after every page loads so the user is
 * stuck on a movie detail page or show detail page").
 *
 * The cause is structural rather than cosmetic. `apps/stable/AppLayout` renders
 * no toolbar at all; the toolbar lives in `apps/experimental/AppLayout`. Every
 * root-level route wrapped itself in the stable layout regardless of which
 * layout mode is configured, so under the experimental layout (the default)
 * they rendered with no toolbar. The canonical library routes have done this
 * since the root pretty URLs landed on 2026-08-03; detail pages joined them on
 * 2026-08-11, when canonicalization became a real router transition and started
 * actually landing on the root route instead of only rewriting the address bar.
 *
 * `toBeVisible()` is deliberately not the assertion. A fixed-position AppBar
 * laid out above the viewport satisfies it while being unreachable, so these
 * assert on-screen geometry via onScreenState.
 */

const TOOLBAR = '.MuiAppBar-root';

test('leaving home while a section is still upgrading reaches the selected page', async ({ page, config }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await login(page, config.username, config.password);

    const homeSections = page.locator('#indexPage.homePage .itemsContainer');
    const destination = homeSections.locator('a[href]').first();
    await expect(destination).toBeVisible({ timeout: 30_000 });

    // A customized built-in can be present before its prototype upgrade has
    // supplied lifecycle methods. Reproduce that browser-visible state on one
    // real home section, then leave through the same card link a user clicks.
    await homeSections.first().evaluate(section => {
        Object.defineProperty(section, 'pause', {
            configurable: true,
            value: undefined
        });
    });

    await destination.click();

    await expect.poll(() => ({
        leftHome: !/(#\/home|\/web\/home)(?:[?#]|$)/.test(page.url()),
        pageErrors
    }), {
        message: 'the selected home card should navigate without a lifecycle TypeError',
        timeout: 30_000
    }).toEqual({
        leftHome: true,
        pageErrors: []
    });
});

// @covers root_route_chrome.canonicalized_detail_page_keeps_the_toolbar
test('a detail page that canonicalizes to a root permalink keeps the app toolbar', async ({ page, config }) => {
    await login(page, config.username, config.password);

    await expect(page.locator(TOOLBAR)).toBeVisible({ timeout: 30_000 });

    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);
    await expect(page.locator('.mainDetailButtons .btnPlay:visible')).toBeVisible({ timeout: 60_000 });

    // The detail route rewrites itself to the item's canonical permalink at
    // root. That transition is the moment the chrome used to be lost.
    await page.waitForURL(/\/(?:tt\d+|(?:tm|tv)-(?:mv|tv|ep|se|co)-\d+|sk-[0-9a-hjkmnp-tv-z]{26})$/, { timeout: 90_000 });

    const toolbar = await onScreenState(page, TOOLBAR);
    expect(toolbar.found, `app toolbar missing after canonicalization: ${JSON.stringify(toolbar)}`).toBe(true);
    expect(toolbar.insideViewport, `app toolbar off-screen after canonicalization: ${JSON.stringify(toolbar)}`).toBe(true);
});

// @covers root_route_chrome.root_library_page_keeps_the_toolbar
test('a root library page keeps the app toolbar', async ({ page, config }) => {
    await login(page, config.username, config.password);

    await page.goto('/movies');
    await expect(page.locator('.mainAnimatedPage, .libraryPage').first()).toBeVisible({ timeout: 60_000 });

    const toolbar = await onScreenState(page, TOOLBAR);
    expect(toolbar.found, `app toolbar missing on the root library page: ${JSON.stringify(toolbar)}`).toBe(true);
    expect(toolbar.insideViewport, `app toolbar off-screen on the root library page: ${JSON.stringify(toolbar)}`).toBe(true);
});

// A broken link is where being stranded actually hurts: there is no content to
// interact with, so the toolbar is the only way out. Both failure states are
// rendered by the same route boundary that lost its chrome, so they are the
// cases most likely to regress together with it.

// @covers root_route_chrome.malformed_permalink_keeps_the_toolbar
test('a malformed root permalink shows the fallback page and keeps the app toolbar', async ({ page, config }) => {
    await login(page, config.username, config.password);

    await page.goto('/w/not-a-real-permalink');
    await expect(page.locator('#fallbackPage')).toBeVisible({ timeout: 30_000 });

    const toolbar = await onScreenState(page, TOOLBAR);
    expect(toolbar.found, `app toolbar missing on the fallback page: ${JSON.stringify(toolbar)}`).toBe(true);
    expect(toolbar.insideViewport, `app toolbar off-screen on the fallback page: ${JSON.stringify(toolbar)}`).toBe(true);
});

// @covers root_route_chrome.unresolvable_permalink_keeps_the_toolbar
test('a well-formed alias the server never issued keeps the app toolbar', async ({ page, config }) => {
    await login(page, config.username, config.password);

    await page.goto('/sk-00000000000000000000000000');
    await expect(page.locator('#permalinkMessagePage')).toBeVisible({ timeout: 30_000 });

    const toolbar = await onScreenState(page, TOOLBAR);
    expect(toolbar.found, `app toolbar missing on the permalink message page: ${JSON.stringify(toolbar)}`).toBe(true);
    expect(toolbar.insideViewport, `app toolbar off-screen on the permalink message page: ${JSON.stringify(toolbar)}`).toBe(true);
});
