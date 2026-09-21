// SlopTank modification notice: added or changed by SlopTank on 2026-09-21.
/**
 * Regression coverage for "Remove from Continue Watching" (queue task
 * t_260913_214241_633, owner request 2026-09-13, upstream feature request
 * jellyfin/jellyfin-web#517).
 *
 * The menu action ("Clear watch progress") used to call markUnplayedItem,
 * which destroyed watched state, play count and last-played date just to
 * remove one card from the Continue Watching rail. The fix
 * (a905fd5165) instead DELETEs UserResumeItems/{itemId} (server commit
 * a53a110c32), a new endpoint that clears only the requesting user's own
 * resume position; watched state, play count and other users are untouched,
 * and a later real playback checkpoint puts the item right back.
 *
 * This spec drives the real served client end to end: login -> seed a resume
 * position through the app's own ApiClient (the same call a real player
 * makes on stop) -> the actual Home page's Continue Watching rail -> the
 * card's own "more" menu -> "Clear watch progress" -> assert the card leaves
 * the rail without a page reload, and that watched state/play count survive.
 */
import type { Page } from '@playwright/test';
import { expect, login, onScreenState, test } from './fixtures';

interface UserDataSnapshot {
    PlaybackPositionTicks: number;
    Played: boolean;
    PlayCount: number;
}

interface ContinueWatchingTestWindow extends Window {
    ApiClient: {
        ajax(options: { type: string; url: string; data?: string; contentType?: string }): Promise<unknown>;
        getUrl(path: string, params?: Record<string, unknown>): string;
        getItem(userId: string, itemId: string): Promise<{ UserData?: UserDataSnapshot }>;
        getCurrentUserId(): string;
    };
    __e2eNoReloadMarker?: boolean;
}

// 5 minutes in: real progress, nowhere near the server's own auto-mark-played
// threshold, and short of the item's own runtime for every fixture item this
// suite uses.
const RESUME_POSITION_TICKS = 3_000_000_000;

function continueWatchingCard(page: Page, itemId: string) {
    return page.locator(`h2:has-text("Continue Watching") ~ * [data-id="${itemId}"]`).first();
}

async function getUserData(page: Page, itemId: string): Promise<UserDataSnapshot> {
    return page.evaluate(async (id) => {
        const api = (window as unknown as ContinueWatchingTestWindow).ApiClient;
        const item = await api.getItem(api.getCurrentUserId(), id);
        return {
            PlaybackPositionTicks: item.UserData?.PlaybackPositionTicks ?? 0,
            Played: item.UserData?.Played ?? false,
            PlayCount: item.UserData?.PlayCount ?? 0
        };
    }, itemId);
}

async function setResumePosition(page: Page, itemId: string, ticks: number): Promise<void> {
    await page.evaluate(async ({ id, positionTicks }) => {
        const api = (window as unknown as ContinueWatchingTestWindow).ApiClient;
        await api.ajax({
            type: 'POST',
            url: api.getUrl('Sessions/Playing/Stopped'),
            data: JSON.stringify({ ItemId: id, PositionTicks: positionTicks }),
            contentType: 'application/json'
        });
    }, { id: itemId, positionTicks: ticks });
}

async function clearResumePositionDirect(page: Page, itemId: string): Promise<void> {
    await page.evaluate(async (id) => {
        const api = (window as unknown as ContinueWatchingTestWindow).ApiClient;
        await api.ajax({
            type: 'DELETE',
            url: api.getUrl(`UserResumeItems/${id}`, { userId: api.getCurrentUserId() })
        });
    }, itemId);
}

async function openCardMenu(page: Page, itemId: string): Promise<void> {
    const card = continueWatchingCard(page, itemId);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    const state = await onScreenState(page, `[data-id="${itemId}"] .btnCardOptions`);
    expect(state.reachable, `card options button should be reachable: ${JSON.stringify(state)}`).toBe(true);
    await card.locator('.btnCardOptions').click();
    await expect(page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]')).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page, config }) => {
    // Start every case from a known state: a real resume position exists, and
    // nothing else about the item's history is disturbed.
    await login(page, config.username, config.password);
    await setResumePosition(page, config.itemId, RESUME_POSITION_TICKS);
});

test.afterEach(async ({ page, config }) => {
    // Leave the shared fixture item the way other specs expect to find it
    // (no residual resume position), regardless of how the test above ended.
    await clearResumePositionDirect(page, config.itemId);
});

// @covers continue_watching.removal.clears_resume_only
test('removing an item from Continue Watching drops the card without a reload and preserves watched state', async ({ page, config }) => {
    const itemId = config.itemId;

    const before = await getUserData(page, itemId);
    expect(before.PlaybackPositionTicks).toBeGreaterThan(0);

    await page.goto('/web/#/home');
    await expect(continueWatchingCard(page, itemId)).toBeVisible({ timeout: 15_000 });

    // A real page reload would reset any window-level state; surviving this
    // marker after the removal proves the card left via the SPA refresh path
    // (itemsContainer.notifyRefreshNeeded), not a navigation.
    await page.evaluate(() => {
        (window as unknown as ContinueWatchingTestWindow).__e2eNoReloadMarker = true;
    });

    await openCardMenu(page, itemId);
    await page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]').click();

    await expect(continueWatchingCard(page, itemId)).toHaveCount(0, { timeout: 15_000 });

    const noReloadMarkerSurvived = await page.evaluate(
        () => (window as unknown as ContinueWatchingTestWindow).__e2eNoReloadMarker === true
    );
    expect(noReloadMarkerSurvived, 'removal must not navigate/reload the page').toBe(true);

    const afterRemoval = await getUserData(page, itemId);
    expect(afterRemoval.PlaybackPositionTicks).toBe(0);
    expect(afterRemoval.Played).toBe(before.Played);
    expect(afterRemoval.PlayCount).toBe(before.PlayCount);

    // A later real playback checkpoint (the same call a player makes on
    // stop) must be able to put the item right back in Continue Watching.
    await setResumePosition(page, itemId, RESUME_POSITION_TICKS);
    await page.goto('/web/#/home');
    await expect(continueWatchingCard(page, itemId)).toBeVisible({ timeout: 15_000 });
});

// @covers continue_watching.removal.keyboard_reachable
test('the removal action is reachable and operable from the keyboard alone', async ({ page, config }) => {
    const itemId = config.itemId;

    await page.goto('/web/#/home');
    const card = continueWatchingCard(page, itemId);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();

    // Reach the card's own options button through a real focus, then operate
    // the whole rest of the flow (open the sheet, pick the item, activate it)
    // with keys only.
    await card.locator('.btnCardOptions').focus();
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.classList.contains('btnCardOptions')
    ), { message: 'the card options button should be keyboard-focusable' }).toBe(true);

    await page.keyboard.press('Enter');
    await expect(page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]')).toBeVisible({ timeout: 10_000 });

    let reachedTarget = false;
    for (let press = 0; press < 15; press++) {
        const focusedId = await page.evaluate(
            () => (document.activeElement as HTMLElement | null)?.getAttribute('data-id')
        );
        if (focusedId === 'removefromcontinue') {
            reachedTarget = true;
            break;
        }
        await page.keyboard.press('Tab');
    }
    expect(reachedTarget, 'Tab order inside the open menu should reach the removal action').toBe(true);

    await page.keyboard.press('Enter');
    await expect(continueWatchingCard(page, itemId)).toHaveCount(0, { timeout: 15_000 });

    const afterRemoval = await getUserData(page, itemId);
    expect(afterRemoval.PlaybackPositionTicks).toBe(0);
});

// @covers continue_watching.removal.failure_shows_real_error_and_keeps_card
test('a failed removal keeps the card and surfaces the real server error', async ({ page, config }) => {
    const itemId = config.itemId;

    await page.route('**/UserResumeItems/**', (route) => {
        if (route.request().method() !== 'DELETE') {
            return route.continue();
        }
        return route.fulfill({
            status: 500,
            contentType: 'application/problem+json',
            body: JSON.stringify({ title: 'forced-e2e-failure', detail: 'Injected by continue-watching-removal.spec.ts' })
        });
    });

    await page.goto('/web/#/home');
    await expect(continueWatchingCard(page, itemId)).toBeVisible({ timeout: 15_000 });

    await openCardMenu(page, itemId);
    await page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]').click();

    await expect(page.locator('.toast')).toContainText('forced-e2e-failure', { timeout: 10_000 });

    // The card must still be there: the failed DELETE must not have been
    // treated as a success.
    await expect(continueWatchingCard(page, itemId)).toBeVisible();

    const afterFailure = await getUserData(page, itemId);
    expect(afterFailure.PlaybackPositionTicks).toBe(RESUME_POSITION_TICKS);

    // Let the afterEach cleanup's own DELETE through for real; otherwise this
    // route would also fail it, leaving the shared fixture item's resume
    // position set for whatever spec runs next.
    await page.unroute('**/UserResumeItems/**');
});

// @covers continue_watching.removal.failure_without_json_body_still_shows_http_status
test('a failure with an unparseable error body still surfaces the HTTP status, not a blank toast', async ({ page, config }) => {
    const itemId = config.itemId;

    // A real server always answers with a ProblemDetails JSON body, but the
    // error-surfacing code path must not depend on that: a proxy timeout, a
    // stripped body, or an upstream outage can hand the client plain text or
    // nothing at all. deleteErrorSuffix falls back to the raw text and then
    // to "(HTTP <status>)" when even that is empty; this proves the fallback
    // chain actually reaches the toast instead of leaving it blank.
    await page.route('**/UserResumeItems/**', (route) => {
        if (route.request().method() !== 'DELETE') {
            return route.continue();
        }
        return route.fulfill({
            status: 503,
            contentType: 'text/plain',
            body: ''
        });
    });

    await page.goto('/web/#/home');
    await expect(continueWatchingCard(page, itemId)).toBeVisible({ timeout: 15_000 });

    await openCardMenu(page, itemId);
    await page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]').click();

    await expect(page.locator('.toast')).toContainText('HTTP 503', { timeout: 10_000 });

    // Same fail-safe contract as the structured-error case: card stays, and
    // nothing about the item's resume state was touched.
    await expect(continueWatchingCard(page, itemId)).toBeVisible();

    const afterFailure = await getUserData(page, itemId);
    expect(afterFailure.PlaybackPositionTicks).toBe(RESUME_POSITION_TICKS);

    await page.unroute('**/UserResumeItems/**');
});
