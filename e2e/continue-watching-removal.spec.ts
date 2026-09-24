// SlopTank modification notice: added or changed by SlopTank on 2026-09-21, 2026-09-24.
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
        getItem(userId: string, itemId: string): Promise<{ UserData?: UserDataSnapshot; RunTimeTicks?: number }>;
        getCurrentUserId(): string;
    };
    __e2eNoReloadMarker?: boolean;
}

// A fixed tick count does not work here: the server's own resume-tracking
// (UserDataManager.UpdatePlayState) ignores any position under MinResumePct
// of the item's actual runtime (server default 5%) as "still at the
// beginning" and resets it straight back to 0. E2E_ITEM_ID has been
// repointed before (Minority Report -> Rental Family, 2026-09-15) to items of
// very different length, so seed a percentage of the item's own RunTimeTicks
// instead of an absolute duration. 20% clears MinResumePct (5%) and stays
// well under MaxResumePct (90%, past which the server marks it played and
// clears the position instead of resuming) regardless of which fixture item
// is configured.
const RESUME_POSITION_FRACTION = 0.2;

let resumePositionTicks = 0;

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

async function computeResumePositionTicks(page: Page, itemId: string): Promise<number> {
    const runtimeTicks = await page.evaluate(async (id) => {
        const api = (window as unknown as ContinueWatchingTestWindow).ApiClient;
        const item = await api.getItem(api.getCurrentUserId(), id);
        return item.RunTimeTicks ?? 0;
    }, itemId);
    expect(runtimeTicks, `${itemId} must report a positive RunTimeTicks to seed a valid resume position`).toBeGreaterThan(0);
    return Math.round(runtimeTicks * RESUME_POSITION_FRACTION);
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

// The card's "more" trigger has two markups depending on layoutManager.mobile
// (cardBuilder.js): a `.btnCardOptions` footer button on mobile, and a
// `.cardOverlayButton[data-action="menu"]` hover overlay button on desktop.
// Playwright's default chromium project runs at a desktop viewport (no
// touch/mobile emulation), so it always gets the overlay markup; `.btnCardOptions`
// is never present in that DOM (observed 2026-09-21: onScreenState reported
// found:false, not just off-screen, confirming the element never existed).
const CARD_MENU_BUTTON_SELECTOR = '.cardOverlayButton[data-action="menu"]';

async function openCardMenu(page: Page, itemId: string): Promise<void> {
    const card = continueWatchingCard(page, itemId);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    const state = await onScreenState(page, `[data-id="${itemId}"] ${CARD_MENU_BUTTON_SELECTOR}`);
    expect(state.reachable, `card options button should be reachable: ${JSON.stringify(state)}`).toBe(true);
    await card.locator(CARD_MENU_BUTTON_SELECTOR).click();
    await expect(page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]')).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page, config }) => {
    // Start every case from a known state: a real resume position exists, and
    // nothing else about the item's history is disturbed.
    await login(page, config.username, config.password);
    resumePositionTicks = await computeResumePositionTicks(page, config.itemId);
    await setResumePosition(page, config.itemId, resumePositionTicks);
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

    // login() already lands on home (HOME_ROUTE), and page.goto() to the
    // identical hash URL is a browser-level no-op that never refetches the
    // Continue Watching section (observed 2026-09-21: the API's own
    // /Items/Resume confirmed the seeded position was saved and ranked
    // first, but the rendered rail kept showing pre-seed data). Force an
    // actual reload so the rail's data fetch re-runs against current state.
    await page.reload();
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
    await setResumePosition(page, itemId, resumePositionTicks);
    // login() already lands on home (HOME_ROUTE), and page.goto() to the
    // identical hash URL is a browser-level no-op that never refetches the
    // Continue Watching section (observed 2026-09-21: the API's own
    // /Items/Resume confirmed the seeded position was saved and ranked
    // first, but the rendered rail kept showing pre-seed data). Force an
    // actual reload so the rail's data fetch re-runs against current state.
    await page.reload();
    await expect(continueWatchingCard(page, itemId)).toBeVisible({ timeout: 15_000 });
});

// @covers continue_watching.removal.keyboard_reachable
test('the removal action is reachable and operable from the keyboard alone', async ({ page, config }) => {
    const itemId = config.itemId;

    // login() already lands on home (HOME_ROUTE), and page.goto() to the
    // identical hash URL is a browser-level no-op that never refetches the
    // Continue Watching section (observed 2026-09-21: the API's own
    // /Items/Resume confirmed the seeded position was saved and ranked
    // first, but the rendered rail kept showing pre-seed data). Force an
    // actual reload so the rail's data fetch re-runs against current state.
    await page.reload();
    const card = continueWatchingCard(page, itemId);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();

    // Reach the card's own options button through a real focus, then operate
    // the whole rest of the flow (open the sheet, pick the item, activate it)
    // with keys only.
    await card.locator(CARD_MENU_BUTTON_SELECTOR).focus();
    await expect.poll(() => page.evaluate(
        (selector) => document.activeElement?.matches(selector) ?? false,
        CARD_MENU_BUTTON_SELECTOR
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

// @covers continue_watching.removal.keyboard_focus_returns_on_close
test('a keyboard-opened card menu takes focus and hands it back to its trigger on Escape', async ({ page, config }) => {
    await page.reload();
    const card = continueWatchingCard(page, config.itemId);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();

    const trigger = card.locator(CARD_MENU_BUTTON_SELECTOR);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]')).toBeVisible({ timeout: 10_000 });

    await expect.poll(() => page.evaluate(
        () => Boolean(document.activeElement?.closest('.actionSheet'))
    ), { message: 'opening the menu from the keyboard should move focus into it, not drop it on <body>' }).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.actionSheet')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => trigger.evaluate((el) => el === document.activeElement), {
        message: 'closing a keyboard-opened menu should return focus to the button that opened it'
    }).toBe(true);
});

// @covers continue_watching.removal.pointer_open_does_not_steal_focus
test('a pointer-opened card menu leaves focus alone (desktop mouse behavior unchanged)', async ({ page, config }) => {
    await page.reload();
    await openCardMenu(page, config.itemId);
    // Chromium focuses a clicked button, and the dialog's open-finish step
    // (dialogHelper animateDialogOpen) is where focus is either moved into the
    // sheet or blurred away from the page. Wait for that step to have run --
    // focus has left the trigger -- then check where it went.
    await expect.poll(() => page.evaluate((triggerSelector) => {
        const active = document.activeElement;
        if (active?.closest('.actionSheet')) return 'sheet';
        return active?.matches(triggerSelector) ? 'trigger' : 'elsewhere';
    }, CARD_MENU_BUTTON_SELECTOR), { message: 'a mouse click must not pull focus into the action sheet' }).toBe('elsewhere');
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

    // login() already lands on home (HOME_ROUTE), and page.goto() to the
    // identical hash URL is a browser-level no-op that never refetches the
    // Continue Watching section (observed 2026-09-21: the API's own
    // /Items/Resume confirmed the seeded position was saved and ranked
    // first, but the rendered rail kept showing pre-seed data). Force an
    // actual reload so the rail's data fetch re-runs against current state.
    await page.reload();
    await expect(continueWatchingCard(page, itemId)).toBeVisible({ timeout: 15_000 });

    await openCardMenu(page, itemId);
    await page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]').click();

    await expect(page.locator('.toast')).toContainText('forced-e2e-failure', { timeout: 10_000 });

    // The card must still be there: the failed DELETE must not have been
    // treated as a success.
    await expect(continueWatchingCard(page, itemId)).toBeVisible();

    const afterFailure = await getUserData(page, itemId);
    expect(afterFailure.PlaybackPositionTicks).toBe(resumePositionTicks);

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

    // login() already lands on home (HOME_ROUTE), and page.goto() to the
    // identical hash URL is a browser-level no-op that never refetches the
    // Continue Watching section (observed 2026-09-21: the API's own
    // /Items/Resume confirmed the seeded position was saved and ranked
    // first, but the rendered rail kept showing pre-seed data). Force an
    // actual reload so the rail's data fetch re-runs against current state.
    await page.reload();
    await expect(continueWatchingCard(page, itemId)).toBeVisible({ timeout: 15_000 });

    await openCardMenu(page, itemId);
    await page.locator('.actionSheetMenuItem[data-id="removefromcontinue"]').click();

    await expect(page.locator('.toast')).toContainText('HTTP 503', { timeout: 10_000 });

    // Same fail-safe contract as the structured-error case: card stays, and
    // nothing about the item's resume state was touched.
    await expect(continueWatchingCard(page, itemId)).toBeVisible();

    const afterFailure = await getUserData(page, itemId);
    expect(afterFailure.PlaybackPositionTicks).toBe(resumePositionTicks);

    await page.unroute('**/UserResumeItems/**');
});
