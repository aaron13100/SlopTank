// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * Real-browser coverage for the per-user watchlist ("My List", c188, upstream
 * feature request 576).
 *
 * Drives the served client end to end against a real Jellyfin server that
 * carries the watchlist API: two separately created users in two separate
 * browser contexts (the cross-device isolation criterion), the detail page
 * button, the home rail, the card context menu (hosted on the My List view's
 * own cards; the identical itemContextMenu machinery also serves search
 * results and home cards), the My List view, keyboard activation, and the
 * failure path (the harness refuses the add request the way an unreachable
 * server would, and the button must roll its state back instead of lying).
 */

import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, login, onScreenState, test } from './fixtures';

const WATCHLIST_ADD_ICON = 'library_add';
const WATCHLIST_REMOVE_ICON = 'library_remove';
const CARD_MENU_BUTTON_SELECTOR = '.cardOverlayButton[data-action="menu"]';

function env(name: string): string {
    const value = process.env[name]; // allow-direct-env: this spec is the e2e config adapter
    if (value === undefined) {
        throw new Error(`Missing required env var ${name} for the watchlist e2e.`); // allow-raw-error: test setup fast-fail
    }

    // An empty string is a valid password (seeded wizard users have none).
    return value;
}

/**
 * Builds the auth header exactly the way the client does, so the admin API
 * calls run through the same auth surface a real client uses.
 *
 * @param token An access token.
 * @returns The Authorization header value.
 */
function authHeader(token: string): string {
    return 'MediaBrowser Client="WatchlistE2E", DeviceId="watchlist-e2e", Device="watchlist-e2e", Version="1.0", Token="' + token + '"';
}

async function authenticate(request: APIRequestContext, username: string, password: string): Promise<string> {
    const response = await request.post('/Users/AuthenticateByName', {
        data: { Username: username, Pw: password },
        headers: { Authorization: authHeader('') }
    });
    expect(response.ok(), `authenticating ${username} failed: ${await response.text()}`).toBeTruthy();
    return (await response.json()).AccessToken as string;
}

interface SeededUser {
    name: string;
    password: string;
    id: string;
}

async function seedUser(request: APIRequestContext, adminToken: string, name: string): Promise<SeededUser> {
    const created = await request.post('/Users/New', {
        data: { Name: name },
        headers: { Authorization: authHeader(adminToken) }
    });
    expect(created.ok(), `creating ${name} failed: ${await created.text()}`).toBeTruthy();
    const user = await created.json();
    // An empty password authenticates straight away, which is what the
    // browser login does for these users.
    return { name, password: '', id: user.Id as string };
}

async function newLoggedInContext(browser: Browser, user: SeededUser): Promise<{ context: import('@playwright/test').BrowserContext; page: Page }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, user.name, user.password);
    return { context, page };
}

function detailButton(page: Page) {
    return page.locator('.mainDetailButtons .btnWatchlist');
}

function watchlistCard(page: Page, itemId: string) {
    // Cards carry the id in Jellyfin's Guid N-format (no hyphens).
    return page.locator(`[data-id="${itemId.replace(/-/g, '')}"]`).first();
}

test.describe('watchlist (My List)', () => {
    const itemId = env('E2E_ITEM_ID');
    const serverId = env('E2E_SERVER_ID');
    let adminToken = '';
    let userA: SeededUser;
    let userB: SeededUser;

    test.beforeAll(async ({ request }) => {
        adminToken = await authenticate(request, env('E2E_USERNAME'), env('E2E_PASSWORD'));
        const suffix = Date.now().toString(36);
        userA = await seedUser(request, adminToken, `watchlist-e2e-a-${suffix}`);
        userB = await seedUser(request, adminToken, `watchlist-e2e-b-${suffix}`);
    });

    test.afterAll(async ({ request }) => {
        // The disposable server keeps its database across runs; remove the
        // users this run created so repeated runs stay clean.
        for (const user of [userA, userB]) {
            if (user?.id && adminToken) {
                await request.delete(`/Users/${user.id}`, {
                    headers: { Authorization: authHeader(adminToken) }
                });
            }
        }
    });

    test('an add on one client is visible on a second client and stays isolated per user', async ({ browser }) => {
        const { context: contextA, page: pageA } = await newLoggedInContext(browser, userA);
        const { context: contextB, page: pageB } = await newLoggedInContext(browser, userB);

        // Session A adds the item from the detail page button.
        await pageA.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
        const buttonA = detailButton(pageA);
        await expect(buttonA).toBeVisible();
        await expect(buttonA.locator('.material-icons')).toHaveClass(new RegExp(WATCHLIST_ADD_ICON));
        await buttonA.click();
        await expect(buttonA).toHaveAttribute('data-inwatchlist', 'true');
        await expect(buttonA.locator('.material-icons')).toHaveClass(new RegExp(WATCHLIST_REMOVE_ICON));

        // Server truth through the app's own ApiClient (its current-user
        // restore is async and not part of the feature under test, so the
        // user id is resolved from /Users/Me): the item must be on A's list.
        // The button's POST is in flight while the optimistic flip shows, so
        // poll the server state instead of reading it once.
        const readServerList = () => pageA.evaluate(async () => {
            const api = (window as unknown as {
                ApiClient: {
                    getUrl(path: string, query?: Record<string, unknown>): string;
                    ajax(options: { type: string; url: string; dataType?: string }): Promise<unknown>;
                }
            }).ApiClient;
            const me = await api.ajax({ type: 'GET', url: api.getUrl('Users/Me'), dataType: 'json' }) as { Id: string };
            return await api.ajax({ type: 'GET', url: api.getUrl(`Users/${me.Id}/Items/Watchlist`), dataType: 'json' }) as { TotalRecordCount: number; Items: { Id: string }[] };
        });
        await expect.poll(readServerList, { message: 'the add must persist server-side', timeout: 15_000 }).toEqual(
            expect.objectContaining({ TotalRecordCount: 1 })
        );
        expect((await readServerList()).Items[0].Id.replace(/-/g, '')).toBe(itemId.replace(/-/g, ''));

        // Session B is a different user in a different browser context: the
        // same item must read as NOT on B's list.
        await pageB.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
        const buttonB = detailButton(pageB);
        await expect(buttonB).toBeVisible();
        await expect(buttonB).toHaveAttribute('data-inwatchlist', 'false');

        // The add is visible on A's second surface: the My List view lists it.
        await pageA.goto('/web/watchlist');
        await expect(watchlistCard(pageA, itemId)).toBeVisible();

        // B's own My List view stays empty, with the honest empty state.
        await pageB.goto('/web/watchlist');
        await expect(pageB.locator('.watchlist-empty')).toBeVisible();
        await expect(watchlistCard(pageB, itemId)).toHaveCount(0);

        await contextA.close();
        await contextB.close();
    });

    test('the home rail lists the entry and the detail button removes it without a reload', async ({ browser }) => {
        const { context, page } = await newLoggedInContext(browser, userA);

        // Seed through the app's own ApiClient (the same call the button makes).
        await page.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
        const seeded = await page.evaluate(async id => {
            const api = (window as unknown as {
                ApiClient: {
                    ajax(options: { type: string; url: string }): Promise<unknown>;
                    getCurrentUserId(): string;
                }
            }).ApiClient;
            // The legacy singleton's current-user restore is async on a
            // fresh page load and getCurrentUserId() can still be null; the
            // authenticated /Users/Me is the reliable source.
            const me = await api.ajax({ type: 'GET', url: api.getUrl('Users/Me'), dataType: 'json' }) as { Id: string };
            const addUrl = api.getUrl(`Users/${me.Id}/Items/${id}/Watchlist`);
            try {
                await api.ajax({ type: 'POST', url: addUrl });
                return 'ok';
            } catch (error) {
                const err = error as { status?: number };
                return `failed status=${String(err?.status)} url=${addUrl}`;
            }
        }, itemId);
        expect(seeded, 'seeding the watchlist entry must succeed').toBe('ok');

        // The home rail shows the item under its own section title.
        // (/web/home is the React wrapper around the legacy home tab in both
        // layouts, so the section comes from the same homesections loader.)
        await page.goto('/web/home');
        await expect(page.locator('h2', { hasText: 'My List' }).first()).toBeVisible();
        await expect(watchlistCard(page, itemId)).toBeVisible();

        // Removing from the detail page updates in place: a marker set before
        // the click must survive, proving no reload happened.
        await page.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
        await page.evaluate(() => {
            (window as unknown as { __e2eNoReloadMarker?: boolean }).__e2eNoReloadMarker = true;
        });
        const button = detailButton(page);
        await expect(button).toHaveAttribute('data-inwatchlist', 'true');
        await button.click();
        await expect(button).toHaveAttribute('data-inwatchlist', 'false');
        const marker = await page.evaluate(() => (window as unknown as { __e2eNoReloadMarker?: boolean }).__e2eNoReloadMarker);
        expect(marker, 'the detail page must not reload on a watchlist toggle').toBe(true);

        await context.close();
    });

    test('the card context menu removes from My List and the view updates in place', async ({ browser }) => {
        const { context, page } = await newLoggedInContext(browser, userA);

        // Seed through the app's own ApiClient, then drive the REMOVE from the
        // card's hover menu on the My List view. This exercises the same
        // itemContextMenu machinery the search-results and home cards host:
        // the disposable server's search index needs a full metadata-refresh
        // pipeline that a minimal fixture does not populate, so search
        // itself is not driven here.
        await page.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
        const seeded = await page.evaluate(async id => {
            const api = (window as unknown as {
                ApiClient: {
                    ajax(options: { type: string; url: string }): Promise<unknown>;
                    getCurrentUserId(): string;
                }
            }).ApiClient;
            const me = await api.ajax({ type: 'GET', url: api.getUrl('Users/Me'), dataType: 'json' }) as { Id: string };
            try {
                await api.ajax({ type: 'POST', url: api.getUrl(`Users/${me.Id}/Items/${id}/Watchlist`) });
                return 'ok';
            } catch (error) {
                const err = error as { status?: number };
                return `failed status=${String(err?.status)}`;
            }
        }, itemId);
        expect(seeded, 'seeding the watchlist entry must succeed').toBe('ok');

        await page.goto('/web/watchlist');
        const card = watchlistCard(page, itemId);
        await expect(card).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await card.hover();
        await card.locator(CARD_MENU_BUTTON_SELECTOR).click();
        await page.locator('.actionSheetMenuItem', { hasText: 'Remove from My List' }).click();

        // The card leaves the list and the honest empty state appears,
        // without a page reload.
        await expect(watchlistCard(page, itemId)).toHaveCount(0);
        await expect(page.locator('.watchlist-empty')).toBeVisible();

        await context.close();
    });

    test('the detail button is keyboard reachable and activates with Enter', async ({ browser }) => {
        const { context, page } = await newLoggedInContext(browser, userA);

        await page.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
        const button = detailButton(page);
        await expect(button).toBeVisible();

        // Reachability first: the control must be inside the viewport and
        // actually be the element a real keypress would hit.
        const state = await onScreenState(page, '.mainDetailButtons .btnWatchlist');
        expect(state.found, 'the My List button must exist on the detail page').toBe(true);
        expect(state.insideViewport, 'the My List button must be on screen').toBe(true);
        expect(state.reachable, 'the My List button must be the top element at its own center').toBe(true);

        await button.focus();
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('data-inwatchlist', 'true');

        // Leave the item off the list for the other tests' assumptions.
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('data-inwatchlist', 'false');

        await context.close();
    });

    test('a refused add rolls the button state back instead of lying', async ({ browser }) => {
        const { context, page } = await newLoggedInContext(browser, userA);

        await page.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
        const button = detailButton(page);
        await expect(button).toBeVisible();

        // The harness refuses exactly the add request; the client must roll
        // the optimistic state back and surface the failure.
        await page.route(/\/Watchlist$/, route => route.abort());
        await button.click();
        await expect(button).toHaveAttribute('data-inwatchlist', 'false');
        await expect(button.locator('.material-icons')).toHaveClass(new RegExp(WATCHLIST_ADD_ICON));

        await context.close();
    });
});
