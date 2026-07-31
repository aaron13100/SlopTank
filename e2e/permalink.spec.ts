import { expect, login, requireNoProviderItemId, submitManualLogin, test } from './fixtures';

test.setTimeout(360_000);

/**
 * Budgets for the two server round trips these tests wait on.
 *
 * Permalink evidence is a SHA-256 over the whole media file, recomputed on
 * every call (PermalinkEvidence.cs), so each operation costs roughly one full
 * read of the item. Measured on this library on an idle box: ~28s to mint and
 * ~30s to discover a 2.0 GB movie, ~5s for a short episode. Opening a link
 * therefore costs discovery plus redemption.
 *
 * These are deliberately generous rather than tight: a timeout tuned to the
 * fast case fails as "nothing was copied" or "never navigated" for an
 * operation that was simply still running, which hides real regressions behind
 * a latency budget. Tracked for repair as queue task c91; when that lands,
 * these come back down.
 */
const ENSURE_TIMEOUT_MS = 90_000;

/** Discovery plus lease redemption, each a full-file hash for a large item. */
const RESOLVE_TIMEOUT_MS = 150_000;

/**
 * A well-formed IMDb id that no item in any library carries, used to observe the
 * server's refusal for an alias it holds no evidence for.
 */
const UNMINTED_IMDB_ID = 'tt0000001';

/** A well-formed sk- id the server has never issued, used to observe the empty-candidate state. */
const UNKNOWN_SLOPTANK_ID = 'sk-00000000000000000000000000';

interface CopyRecorderWindow extends Window {
    __permalinkCopiedText?: string
    __permalinkRecorderState?: string
}

/**
 * Records every string the app hands to a clipboard API, delegating to the real
 * one so the product's own copy path still runs unchanged.
 *
 * Reading the clipboard back with `navigator.clipboard.readText()` is not usable
 * as an assertion here: it resolves empty whenever the document is not focused,
 * which is the normal state right after a context-menu click in a headless
 * browser, and it cannot see the `execCommand` textarea fallback `copy()` uses
 * when `writeText` is refused. Recording at the call site observes exactly what
 * the app published, through whichever path it took.
 *
 * @param page - Page to install the recorder on, before any navigation.
 */
async function recordPublishedLinks(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
        const recorder = window as CopyRecorderWindow;
        recorder.__permalinkRecorderState = 'started';

        try {
            const clipboard = navigator.clipboard;
            if (typeof clipboard?.writeText === 'function') {
                const writeText = clipboard.writeText.bind(clipboard);
                clipboard.writeText = (text: string) => {
                    recorder.__permalinkCopiedText = text;
                    return writeText(text);
                };
            }

            // `copy()` falls back to selecting a detached textarea and issuing
            // execCommand when writeText is unavailable or refused.
            const execCommand = document.execCommand.bind(document);
            document.execCommand = (commandId: string, showUI?: boolean, value?: string) => {
                const active = document.activeElement as HTMLTextAreaElement | null;
                if (commandId === 'copy' && typeof active?.value === 'string') {
                    recorder.__permalinkCopiedText = active.value;
                }
                return execCommand(commandId, showUI, value);
            };
            recorder.__permalinkRecorderState = 'installed';
        } catch (error) {
            recorder.__permalinkRecorderState = `failed: ${(error as Error).message}`;
        }
    });
}

/**
 * Returns the URL the app most recently published to the clipboard.
 *
 * @param page - Page the recorder was installed on.
 * @returns The published URL.
 */
async function readPublishedLink(page: import('@playwright/test').Page): Promise<string> {
    try {
        await expect
            .poll(() => page.evaluate(() => (window as CopyRecorderWindow).__permalinkCopiedText ?? ''), { timeout: ENSURE_TIMEOUT_MS })
            .not.toBe('');
    } catch (error) {
        // Report what the page was actually doing. "Nothing was copied" has
        // several very different causes (the recorder never installed, the
        // command never ran, ensure is still in flight), and they are not
        // distinguishable from the bare assertion.
        const state = await page.evaluate(() => ({
            recorder: (window as CopyRecorderWindow).__permalinkRecorderState ?? 'absent',
            toasts: Array.from(document.querySelectorAll('.toastContainer .toast')).map(el => el.textContent),
            openSheets: document.querySelectorAll('.actionSheet').length
        }));
        throw new Error(`no link was published within ${ENSURE_TIMEOUT_MS}ms: ${JSON.stringify(state)} (${(error as Error).message})`);
    }
    return page.evaluate(() => (window as CopyRecorderWindow).__permalinkCopiedText ?? '');
}

/**
 * Runs a copy command from an item's real context menu and returns the URL it published.
 *
 * @param page - Page under test.
 * @param commandId - Which copy command to invoke.
 * @param itemId - The item whose menu is opened.
 * @param serverId - The server the item belongs to.
 * @returns The URL the command copied.
 */
async function copyFromItemMenu(
    page: import('@playwright/test').Page,
    commandId: 'copy-link' | 'copy-play-link',
    itemId: string,
    serverId: string
): Promise<string> {
    await page.goto(`/web/#/details?id=${itemId}&serverId=${serverId}`);

    const moreCommands = page.locator('.btnMoreCommands');
    await expect(moreCommands).toBeVisible({ timeout: 20_000 });
    await moreCommands.click();

    const command = page.locator(`[data-id="${commandId}"]`);
    await expect(command).toBeVisible({ timeout: 10_000 });
    await command.click();

    return readPublishedLink(page);
}

/**
 * Mints durable permalink evidence for an item the way a user does -- by
 * copying its link from the item page -- and returns the published alias.
 *
 * An external alias resolves only after evidence has been initialized from an
 * authenticated item page (docs/internal/permalink-url-design.md: the server
 * answers `EvidenceRequired` until then), so every test that opens an external
 * permalink mints it through this entry point first rather than assuming a
 * provider id in library metadata is already resolvable.
 *
 * @param page - Page under test, already signed in.
 * @param context - Browser context, granted clipboard permissions here.
 * @param itemId - The item to mint an alias for.
 * @param serverId - The server the item belongs to.
 * @param kind - Which link to publish.
 * @returns The alias id from the published URL, e.g. `tt0181689`.
 */
async function mintPermalinkId(
    page: import('@playwright/test').Page,
    context: import('@playwright/test').BrowserContext,
    itemId: string,
    serverId: string,
    kind: 'copy-link' | 'copy-play-link'
): Promise<string> {
    await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);
    const copied = await copyFromItemMenu(page, kind, itemId, serverId);
    const alias = new URL(copied).pathname.split('/').pop();
    expect(alias, `expected a published alias in ${copied}`).toBeTruthy();
    return alias as string;
}

test.beforeEach(async ({ page }) => {
    await recordPublishedLinks(page);
});

test.describe('pretty permalinks (docs/internal/permalink-url-design.md)', () => {
    test('an external alias minted from the item page opens its details page through #/p/<id>', async ({ page, context, config }) => {
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, config.itemId, config.serverId, 'copy-link');

        await page.goto(`/web/#/p/${alias}`);

        await page.waitForURL(/#\/details\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        expect(new URL(page.url()).hash).toContain(`id=${config.itemId}`);
    });

    test('an external alias opens the video route and starts playback through #/w/<id>', async ({ page, context, config }) => {
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, config.itemId, config.serverId, 'copy-play-link');

        await page.goto(`/web/#/w/${alias}`);

        await page.waitForURL(/#\/video\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 20_000 });
        await expect
            .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
            .toBeGreaterThanOrEqual(2);
    });

    test('an external alias the server holds no evidence for says so, quoting the server, and never guesses an item', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/web/#/p/${UNMINTED_IMDB_ID}`);

        const message = page.locator('#permalinkMessagePage');
        await expect(message).toBeVisible({ timeout: 20_000 });
        // The distinct EvidenceRequired state, not the generic resolve error:
        // this is what a bundle that loses typed failures collapses away.
        await expect(message).toContainText('Open the item on this server and use Copy Link once');
        await expect(message).toContainText('EvidenceRequired');
        await expect(page).not.toHaveURL(/#\/details\?id=/);
    });

    test('a well-formed sk- alias the server never issued shows a not-found message, never a guess', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/web/#/p/${UNKNOWN_SLOPTANK_ID}`);

        await expect(page.locator('#permalinkMessagePage')).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('#permalinkMessagePage')).toContainText(UNKNOWN_SLOPTANK_ID);
    });

    test('a malformed permalink id shows an invalid-link message without any network lookup', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto('/web/#/p/not-a-real-permalink');

        await expect(page.locator('#permalinkMessagePage')).toBeVisible({ timeout: 20_000 });
    });

    test('a previously shared #/details?...&autoplay=1 link still starts playback (regression: autoplay was silently dropped when the video route became the durable permalink)', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}&autoplay=1`);

        await page.waitForURL(/#\/video\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 20_000 });
        await expect
            .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
            .toBeGreaterThanOrEqual(2);
    });
});

test.describe('candidate C: the bare pretty entry URL (design section 6.2)', () => {
    test('a bare /web/p/<id> URL with no hash redirects through the server middleware to the item', async ({ page, context, config }) => {
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, config.itemId, config.serverId, 'copy-link');

        // A real top-level navigation, not a hash change: this only resolves if
        // the server's redirect middleware answers with a 302 to the hash form
        // before the SPA ever loads.
        await page.goto(`/web/p/${alias}`);

        await page.waitForURL(/#\/details\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        expect(new URL(page.url()).hash).toContain(`id=${config.itemId}`);
    });

    test('a bare /web/w/<id> URL with no hash redirects through the server middleware and starts playback', async ({ page, context, config }) => {
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, config.itemId, config.serverId, 'copy-play-link');

        await page.goto(`/web/w/${alias}`);

        await page.waitForURL(/#\/video\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 20_000 });
        await expect
            .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
            .toBeGreaterThanOrEqual(2);
    });
});

test.describe('signed-out access (design section 4.3)', () => {
    test('opening a permalink while signed out redirects to login, then lands on the item after signing in', async ({ page, context, config }) => {
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, config.itemId, config.serverId, 'copy-link');

        // Drop the stored session so the next navigation is a genuinely
        // signed-out visit to a link that already resolves.
        await page.evaluate(() => window.localStorage.clear());
        await context.clearCookies();

        await page.goto(`/web/#/p/${alias}`);

        // ConnectionRequired encodes the permalink path into the login url
        // before any resolution is attempted, so a signed-out visitor never
        // sees a bare "not found" for a link they simply have not opened yet.
        await page.waitForURL(/#\/login\?/, { timeout: 20_000 });
        expect(new URL(page.url()).hash).toContain(encodeURIComponent(`/p/${alias}`));

        await submitManualLogin(page, config.username, config.password);

        await page.waitForURL(/#\/details\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        expect(new URL(page.url()).hash).toContain(`id=${config.itemId}`);
    });
});

test.describe('share and copy links (design section 5): ensure runs before any URL is built', () => {
    test.beforeEach(async ({ page }) => {
        // Copy Link and Copy Play Link must be offered and work with no native
        // Share capability present at all -- they are never gated by it.
        await page.addInitScript(() => {
            // @ts-expect-error -- deliberately removing a capability this command must not depend on
            delete navigator.share;
        });
    });

    test('Copy Link ensures the item and copies a pretty URL that resolves back to the same item', async ({ page, context, config }) => {
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-link', config.itemId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        const origin = new URL(page.url()).origin;
        expect(copiedUrl.startsWith(`${origin}/web/p/`), `expected a pretty link under ${origin}, got: ${copiedUrl}`).toBe(true);

        await page.goto(copiedUrl);
        await page.waitForURL(/#\/details\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        expect(new URL(page.url()).hash).toContain(`id=${config.itemId}`);
    });

    test('Copy Play Link ensures the item and copies a URL that starts playback', async ({ page, context, config }) => {
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-play-link', config.itemId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent play link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        const origin = new URL(page.url()).origin;
        expect(copiedUrl.startsWith(`${origin}/web/w/`), `expected a pretty link under ${origin}, got: ${copiedUrl}`).toBe(true);

        await page.goto(copiedUrl);
        await page.waitForURL(/#\/video\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 20_000 });
        await expect
            .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
            .toBeGreaterThanOrEqual(2);
    });

    test('a real item with no provider id mints and resolves an sk- alias through Copy Link', async ({ page, context, config }) => {
        const noProviderItemId = requireNoProviderItemId();
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-link', noProviderItemId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        expect(copiedUrl).toMatch(/\/web\/p\/sk-[0-9a-hjkmnp-tv-z]{26}$/);

        await page.goto(copiedUrl);
        await page.waitForURL(/#\/details\?id=/, { timeout: RESOLVE_TIMEOUT_MS });
        expect(new URL(page.url()).hash).toContain(`id=${noProviderItemId}`);
    });
});
