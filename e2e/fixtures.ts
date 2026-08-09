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
 * Root pretty URLs (commit 6e4b9c4900) moved playback from `#/video?id=` to
 * `/web/video?id=`, which then canonicalizes in place to `/web/w/<permalink>`
 * while the player stays mounted. Six specs each carried their own copy of the
 * old hash pattern and every one of them timed out after that commit, so the
 * pattern lives here once: the next router change breaks one line, not six.
 */
export const VIDEO_ROUTE = /\/web\/(video\?id=|w\/)/;

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
