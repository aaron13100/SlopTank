import { test as base, expect } from '@playwright/test';

import permalinkGrammar from '../src/components/router/permalink-grammar-v1.json';

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

/**
 * Read the dedicated dual-audio, chaptered player-controls fixture id.
 *
 * This stays opt-in instead of joining E2eConfig because unrelated specs must
 * remain runnable against servers that only provide the baseline media item.
 *
 * @returns The configured library item id.
 */
export function requireControlsItemId(): string {
    const value = process.env.E2E_CONTROLS_ITEM_ID; // allow-direct-env: this module is the e2e config adapter
    if (!value) {
        throw new Error( // allow-raw-error: test setup fast-fail, not user-facing production code
            'Missing required env var E2E_CONTROLS_ITEM_ID. Set it to a library item with '
            + 'at least two audio tracks and at least three chapters.'
        );
    }
    return value;
}

/**
 * Read the chaptered direct-play fixture id used by playback timeline specs.
 *
 * @returns The configured library item id.
 */
export function requireDirectPlayChapterItemId(): string {
    return requireEnv('E2E_DIRECT_PLAY_CHAPTER_ITEM_ID');
}

/**
 * Read the chaptered progressive-transcode fixture id used by playback
 * timeline specs.
 *
 * @returns The configured library item id.
 */
export function requireTranscodeChapterItemId(): string {
    return requireEnv('E2E_TRANSCODE_CHAPTER_ITEM_ID');
}

/**
 * Read the ASS-subtitled media fixture id used by subtitle offset specs.
 *
 * @returns The configured library item id.
 */
export function requireAssSubtitleItemId(): string {
    return requireEnv('E2E_ASS_SUBTITLE_ITEM_ID');
}

/**
 * Read the fixture id for a real TV episode that carries external provider ids.
 *
 * Permalink specs use this instead of `config.itemId` wherever a test has to
 * complete several permalink round trips, because permalink evidence hashes the
 * whole media file on every call: an episode-sized file keeps that cost from
 * dominating what the test is actually measuring, while still exercising the
 * external-id path for real.
 *
 * @returns The configured episode item id.
 */
export function requireEpisodeItemId(): string {
    return requireEnv('E2E_EPISODE_ITEM_ID');
}

/**
 * Read the fixture id for a real, eligible library item that carries no
 * external provider id (docs/internal/permalink-url-design.md section 3.6):
 * the case the `sk-` fallback identity exists for. Used by permalink specs to
 * mint and resolve a real `sk-` alias end to end, rather than only through a
 * mocked transport.
 *
 * @returns The configured library item id.
 */
export function requireNoProviderItemId(): string {
    return requireEnv('E2E_NO_PROVIDER_ITEM_ID');
}

/**
 * Every spelling the player route currently takes.
 *
 * Playback starts on `/web/video?id=<guid>` and then canonicalizes in place to
 * root `/w/<permalink>` while the player stays mounted. Root `/<permalink>` is
 * the item information route and must not satisfy a playback wait.
 *
 * The permalink alternatives come from the versioned web copy of the server
 * integration-test contract, so E2E route waits cannot drift into a third
 * handwritten grammar.
 */
const permalinkIdPattern = Object.entries(permalinkGrammar.patterns)
    .filter(([ namespace ]) => namespace !== 'reserved')
    .map(([, pattern ]) => pattern.slice(1, -1))
    .join('|');

/** A canonical root watch permalink, excluding legacy and information routes. */
export const WATCH_PERMALINK_ROUTE = new RegExp(`/w/(?:${permalinkIdPattern})(?:[?#]|$)`);

export const VIDEO_ROUTE = new RegExp(`/web/video\\?id=|${WATCH_PERMALINK_ROUTE.source}`);

/**
 * Move the pointer so the player treats the user as active and shows the OSD.
 *
 * Two moves, not one: the OSD wakes on movement, and a move to the coordinate
 * the pointer already occupies is not movement.
 *
 * @param page - Page with the player mounted.
 */
export async function wakeOsd(page: import('@playwright/test').Page): Promise<void> {
    await page.mouse.move(20, 20);
    await page.mouse.move(100, 100);
}

/**
 * Wait for an OSD control to be usable, holding the OSD awake the whole time.
 *
 * The OSD hides itself after ~3s of inactivity and its container ends up
 * `display: none`, so a control whose data arrives later than that window is
 * invisible to `toBeVisible()` even though the app is behaving correctly.
 * Waking once before asserting is a race against server latency: the Episodes
 * button (enabled only after the series query returns) held on an idle box and
 * failed the moment the box was busy, which reads as a player regression that
 * is not there. Waking on every poll removes the race rather than widening a
 * timeout until the race usually loses.
 *
 * @param page - Page with the player mounted.
 * @param selector - CSS selector for the OSD control the user must be able to press.
 * @param timeout - How long the control may take to become usable.
 * @returns The control, awake and visible.
 */
export async function revealOsdControl(
    page: import('@playwright/test').Page,
    selector: string,
    timeout = 20_000
): Promise<import('@playwright/test').Locator> {
    // Legacy views stay mounted but hidden for fast back navigation. Match the
    // control a user can actually reach; strict mode still catches two active
    // controls because `isVisible()` rejects a multi-match locator.
    const control = page.locator(`${selector}:visible`);
    await expect
        .poll(async () => {
            await wakeOsd(page);
            return control.isVisible();
        }, { timeout, message: `expected the OSD control ${selector} to become usable` })
        .toBe(true);
    return control;
}

/**
 * How long one click attempt may wait for the OSD control to accept it.
 *
 * Under the ~3s auto-hide window on purpose: an attempt that runs longer than
 * the hide timer spends the rest of its budget waiting on an element the OSD
 * has already taken away, and the pointer is only woken between attempts.
 */
const OSD_CLICK_ATTEMPT_MS = 2_000;

/** A page-side record of presses that actually reached an OSD control. */
interface DeliveredPresses {
    presses: number;
    stop: () => void;
}

/**
 * Start counting, inside the page, presses that actually reach a control.
 *
 * A timed-out `locator.click()` does NOT mean the press was never delivered.
 * `click()` dispatches the press and then waits for scheduled navigations, and
 * that second phase can outlast the attempt budget by itself: opening a
 * Document Picture-in-Picture window took 2.0s on its own, so the call threw
 * `Timeout 2000ms exceeded` on a press the button had already received. The
 * return value of `click()` therefore cannot decide whether a retry is safe,
 * and most OSD controls toggle -- Picture in picture, Subtitles, Pause -- so a
 * repeated press undoes the first one.
 *
 * The listener runs in the capture phase on the document, so a press the app
 * stops from propagating still registers.
 *
 * @param page - Page with the player mounted.
 * @param selector - CSS selector for the control being pressed. Plain CSS: it
 *   is matched with `Element.closest`, so Playwright pseudo-classes are out.
 * @returns A page-side handle counting delivered presses.
 */
async function countDeliveredPresses(
    page: import('@playwright/test').Page,
    selector: string
): Promise<import('@playwright/test').JSHandle<DeliveredPresses>> {
    return page.evaluateHandle((controlSelector) => {
        const record: DeliveredPresses = { presses: 0, stop: () => { /* replaced below */ } };
        const onClick = (event: Event) => {
            const target = event.target as Element | null;
            if (target?.closest?.(controlSelector)) {
                record.presses += 1;
            }
        };
        document.addEventListener('click', onClick, true);
        record.stop = () => document.removeEventListener('click', onClick, true);
        return record;
    }, selector);
}

/**
 * Read the delivered-press count, treating a destroyed page as a delivery.
 *
 * The handle only dies with its execution context, which in these specs means
 * the press navigated the document or closed the window. Both are downstream of
 * a press that landed, so reporting "not delivered" there would license exactly
 * the repeat this counter exists to prevent.
 *
 * @param delivered - Handle from countDeliveredPresses.
 * @returns Whether at least one press reached the control.
 */
async function pressWasDelivered(
    delivered: import('@playwright/test').JSHandle<DeliveredPresses>
): Promise<boolean> {
    try {
        return await delivered.evaluate(record => record.presses > 0);
    } catch (contextGone) {
        // The reason a press is assumed delivered must stay in the run log.
        console.warn(`[osd] treating the press as delivered: ${(contextGone as Error).message}`);
        return true;
    }
}

/**
 * Press an OSD control, holding the OSD awake across the click itself.
 *
 * `revealOsdControl` keeps the OSD up until the control is visible and then
 * hands the locator back, which leaves the press outside the loop that made it
 * reachable. The OSD hides itself after ~3s of inactivity, so on a busy host
 * the container reaches `display: none` between the last poll and the click,
 * and Playwright then retries actionability forever against a control nothing
 * is waking any more -- observed as
 * "element is visible, enabled and stable / scrolling into view if needed /
 * element is not visible" repeating until the test timeout.
 *
 * Retrying the click with a fresh wake each attempt removes the race instead of
 * widening a timeout until it usually loses: every attempt re-establishes the
 * precondition it depends on. The retry is gated on the press not having been
 * DELIVERED rather than on `click()` having thrown, so a control whose press is
 * slow to settle is never pressed twice; see countDeliveredPresses.
 *
 * @param page - Page with the player mounted.
 * @param selector - CSS selector for the OSD control the user must be able to press.
 * @param timeout - How long the control may take to accept a press.
 */
export async function clickOsdControl(
    page: import('@playwright/test').Page,
    selector: string,
    timeout = 20_000
): Promise<void> {
    const control = page.locator(`${selector}:visible`);
    const delivered = await countDeliveredPresses(page, selector);
    let lastFailure: Error | undefined;
    try {
        await expect
            .poll(async () => {
                if (await pressWasDelivered(delivered)) return true;
                await wakeOsd(page);
                try {
                    await control.click({ timeout: OSD_CLICK_ATTEMPT_MS });
                    return true;
                } catch (cause) {
                    // Keep the actionability detail. expect.poll only reports
                    // that the value never became true, and why the control
                    // refused the press is the entire diagnosis.
                    lastFailure = cause as Error;
                    return pressWasDelivered(delivered);
                }
            }, { timeout, message: `expected the OSD control ${selector} to accept a click` })
            .toBe(true);
    } catch (pollExpired) {
        throw new Error( // allow-raw-error: test setup fast-fail, not user-facing production code
            `OSD control ${selector} never accepted a click within ${timeout}ms. `
                + `Last attempt: ${lastFailure?.message ?? '(the control never became visible)'}`,
            { cause: lastFailure ?? pollExpired }
        );
    } finally {
        // Leave no listener behind: a spec presses OSD controls a dozen times,
        // and a counter for a press that already happened would answer for the
        // next one.
        try {
            await delivered.evaluate(record => record.stop());
        } catch (contextGone) {
            // A failed teardown must be visible, not swallowed.
            console.warn(`[osd] press counter for ${selector} outlived its page: ${(contextGone as Error).message}`);
        }
        await delivered.dispose();
    }
}

/** Playback position, in seconds, known to sit inside spoken dialogue. */
export const DIALOGUE_TIME = 95;

/** Seconds after DIALOGUE_TIME still expected to contain dialogue. */
export const DIALOGUE_WINDOW = 20;

/**
 * Park playback on a rendered subtitle cue and hold it there, paused.
 *
 * Three races have to be beaten, and all three produce the same misleading
 * symptom -- the cue element present but empty or `hide`, so `toBeVisible()`
 * reports hidden:
 *   1. a `currentTime` write issued while the player is still starting up is
 *      silently discarded, leaving the playhead at 0 where nothing is spoken;
 *   2. pausing immediately after a seek that DID land freezes the player before
 *      it has decoded the new position or run the subtitle renderer for it, so
 *      the cue text never arrives and never will -- the renderer updates on
 *      timeupdate, which a paused element stops firing;
 *   3. the cue the loop accepted expires before the pause lands. Text content
 *      survives on the hidden element, so a predicate that only reads
 *      `textContent()` passes on a cue the renderer has already taken off
 *      screen, and the caller's `toBeVisible()` fails on state that really was
 *      correct a moment earlier.
 *
 * So the freeze happens INSIDE the loop and the loop judges what the caller
 * asserts -- visible, non-empty, and paused -- rather than a weaker proxy for
 * it. An attempt that lands on an expired cue resumes and tries again.
 *
 * @param video - The player's video element.
 * @param subtitleLine - The rendered (non-preview) subtitle text element.
 */
export async function parkOnCue(
    video: import('@playwright/test').Locator,
    subtitleLine: import('@playwright/test').Locator
): Promise<void> {
    await expect
        .poll(async () => {
            const position = await video.evaluate(async (el: HTMLVideoElement, [target, window]) => {
                // Re-seek only when outside the window, so normal playback
                // through the dialogue is not yanked back to the start of it.
                if (el.currentTime < target - 1 || el.currentTime > target + window) {
                    el.currentTime = target;
                }
                if (el.paused) await el.play();
                return el.currentTime;
            }, [ DIALOGUE_TIME, DIALOGUE_WINDOW ]);
            if (position < DIALOGUE_TIME - 1) return false;
            // Freeze first, then judge: checking the cue and pausing afterwards
            // lets the playhead leave the dialogue window in between, and the
            // renderer hides the very line the check just accepted.
            await video.evaluate((el: HTMLVideoElement) => el.pause());
            const [ visible, text ] = await Promise.all([
                subtitleLine.isVisible(),
                subtitleLine.textContent()
            ]);
            return visible && (text ?? '').trim().length > 0;
        }, { timeout: 60_000, message: 'expected playback to park, paused, on a visible subtitle cue' })
        .toBe(true);
    await expect(subtitleLine).toBeVisible({ timeout: 10_000 });
    await expect(subtitleLine).not.toBeEmpty();
}

export const test = base.extend<{ config: E2eConfig }>({
    page: async ({ page }, use) => {
        await page.addInitScript(() => {
            const removeWebpackOverlay = () => {
                document.querySelector('#webpack-dev-server-client-overlay')?.remove();
            };
            new MutationObserver(removeWebpackOverlay).observe(document, {
                childList: true,
                subtree: true
            });
            removeWebpackOverlay();
        });
        await use(page);
    },
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

/**
 * Distinguish "the app never got there" from "the server never answered" the
 * instant a login step stalls, by timing an unauthenticated health check.
 *
 * A concurrent real playback session (or any other heavy job) on a
 * resource-constrained host can starve every response the app is waiting on,
 * including this one. Left alone, that reads as an anonymous Playwright
 * timeout indistinguishable from a genuine login/routing regression -- see
 * the `workers: 1` comment in playwright.config.ts for the host measurement
 * that motivated this.
 *
 * @param page - Page under test, still on the stalled login flow.
 * @param cause - The timeout being explained.
 * @returns An error whose message states which side the evidence points to.
 */
async function describeLoginFailure(
    page: import('@playwright/test').Page,
    cause: Error
): Promise<Error> {
    // Fetch from inside the page (not page.request, which is a separate
    // out-of-process HTTP client that bypasses page.route() and shares none
    // of the browser's connection state) so the check reflects what the app
    // itself is experiencing, and stays mockable the same way every other
    // spec in this suite fakes server behavior.
    const healthCheckStart = Date.now(); // allow-direct-time: e2e diagnostic timing for a failure message only, not production logic, never asserted on for determinism
    let verdict: string;
    try {
        const result = await page.evaluate(async () => {
            const controller = new AbortController();
            const abortTimer = setTimeout(() => controller.abort(), 5_000);
            try {
                const response = await fetch('/System/Info/Public', { signal: controller.signal }); // allow-direct-network: e2e diagnostic-only browser-context probe, not a production API client
                return { ok: response.ok, status: response.status };
            } finally {
                clearTimeout(abortTimer);
            }
        });
        const elapsedMs = Date.now() - healthCheckStart; // allow-direct-time: e2e diagnostic timing for a failure message only, not production logic, never asserted on for determinism
        verdict = result.ok && elapsedMs < 3_000 ?
            'an unauthenticated health check answered in '
                + `${elapsedMs}ms, so the server looks healthy -- this is likely a real `
                + 'login/navigation regression, not host contention' :
            `an unauthenticated health check answered in ${elapsedMs}ms `
                + `(HTTP ${result.status}) -- this looks like the Jellyfin host is `
                + 'overloaded (e.g. a concurrent local e2e worker or another playback '
                + 'session), not a UI regression';
    } catch (healthCheckError) {
        verdict = 'an unauthenticated health check itself failed '
            + `(${healthCheckError instanceof Error ? healthCheckError.message : String(healthCheckError)}) -- `
            + 'this looks like the Jellyfin host is overloaded or unreachable, not a UI regression';
    }

    return new Error( // allow-raw-error: test setup fast-fail, not user-facing production code
        `Login did not complete: ${verdict}. Original error: ${cause.message}`,
        { cause }
    );
}

/**
 * Fills and submits the manual login form for whatever page is currently
 * displayed, without asserting where the app lands afterward -- callers whose
 * post-login destination isn't `#/home` (e.g. a permalink's return url) need
 * this without the assertion `login()` bakes in.
 *
 * @param page - Page under test, already navigated to a page that renders the login form.
 * @param username - The account name to authenticate.
 * @param password - The account password to authenticate.
 */
export async function submitManualLogin(page: import('@playwright/test').Page, username: string, password: string) {
    try {
        // Wait for the public-user request to finish before changing forms. Clicking
        // Manual Login earlier races loadUserList(), which switches back to the
        // visual form and leaves Playwright targeting a hidden submit button.
        const userButton = page.getByRole('button', { name: username, exact: true });
        const selectServerHeading = page.getByRole('heading', { name: 'Select Server' });
        await expect(userButton.or(selectServerHeading)).toBeVisible({ timeout: 30_000 });

        // A clean production build has no server baked into config.json. Connect
        // through the same UI a first-time user sees, using the origin under test.
        if (await selectServerHeading.isVisible()) {
            await page.getByText('Add Server', { exact: true }).click();
            await page.getByLabel('Host').fill(new URL(page.url()).origin);
            await page.getByText('Connect', { exact: true }).click();
            await expect(userButton).toBeVisible({ timeout: 30_000 });
        }

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
    } catch (cause) {
        throw await describeLoginFailure(page, cause as Error);
    }
}

/**
 * Both spellings of the post-login home route.
 *
 * Root pretty URLs (commit 6e4b9c4900) moved the app from `#/home` to
 * `/web/home`, and this fixture was not updated with it, so every spec in the
 * suite failed at login from that commit onward. Matching both keeps the
 * assertion honest during the migration: what login has to prove is that the
 * app reached home, and which scheme it spells that in is permalink.spec.ts's
 * job to pin, not this helper's.
 */
const HOME_ROUTE = /(#\/home|\/web\/home)/;

export async function login(page: import('@playwright/test').Page, username: string, password: string) {
    await page.goto('/web/#/login');
    await submitManualLogin(page, username, password);
    try {
        await page.waitForURL(HOME_ROUTE, { timeout: 30_000 });
    } catch (cause) {
        throw await describeLoginFailure(page, cause as Error);
    }
}

export { expect };
