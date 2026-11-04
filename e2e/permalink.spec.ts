// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-07-31, 2026-08-01, 2026-08-03, 2026-09-09, 2026-09-28, 2026-11-04.
import { expect, login, requireEpisodeItemId, requireNoProviderItemId, submitManualLogin, test } from './fixtures';
import { loadScaledMs } from './load-scaled-bounds';

test.setTimeout(loadScaledMs(600_000));

/**
 * Budgets for the server round trips these tests wait on.
 *
 * Link creation and item resolution use the server's authenticated item APIs.
 * Keep these bounds generous so a slow shared host is reported accurately
 * instead of as a missing link or failed navigation.
 */
const ENSURE_TIMEOUT_MS = loadScaledMs(90_000);

/** Opening an info link: one authorized permalink item query. */
const RESOLVE_TIMEOUT_MS = loadScaledMs(150_000);

/**
 * Opening a play link includes the item query and the normal player startup.
 */
const PLAYBACK_RESOLVE_TIMEOUT_MS = loadScaledMs(300_000);

/**
 * Landing on the video route only means resolution finished; the player still
 * has to fetch playback info, pick a media source and build its element. That
 * preparation is visible to the user as "Preparing video...", and on this
 * 2-core host it competes with whatever else is running.
 *
 * Measured 2026-08-01 (t_260720_015135_519): the same assertion that passes in
 * about 2 minutes with the box near idle (15-minute loadavg 4.4) exceeded a
 * 20s element wait when the suite itself had driven the 15-minute loadavg to
 * 16.9. Playback was not broken in that run -- the page was sitting on
 * "Preparing video..." with the OSD already up -- so a 20s budget was reporting
 * host contention as "the watch link never started playback", which is the
 * failure this whole file exists to detect. Sized the same way as the round
 * trip budgets above: generous enough that only a real stall trips it.
 */
const PLAYER_READY_TIMEOUT_MS = loadScaledMs(60_000);

/**
 * Waits for a permalink route to reach its target, using the Retry affordance
 * when the server reports the designed transient conflict.
 *
 * The route offers Retry for a server conflict while ordinary library
 * membership is changing, rather than guessing at the result.
 *
 * Clicking Retry is what a real user does with that screen, so driving it here
 * covers the conflict path that nothing else exercised, while still failing if
 * the link never resolves. It never masks a permanent failure: the retries are
 * bounded, and other permalink states (not found or invalid) have no Retry
 * button and fall straight through to the URL wait.
 *
 * @param page - Page under test, already navigated to the permalink route.
 * @param targetUrl - The canonical route that must remain in the address bar.
 * @param timeoutMs - Budget for the whole resolution, retries included.
 */
async function waitForPermalinkTarget(
    page: import('@playwright/test').Page,
    targetUrl: RegExp,
    timeoutMs: number
) {
    const retryButton = page.locator('#permalinkRetryButton');
    const resolvedPresentation = page.locator('.btnMoreCommands:visible, video:visible').first();

    for (let attempt = 0; attempt < 5; attempt++) {
        const landed = await resolvedPresentation.waitFor({ state: 'visible', timeout: timeoutMs / 5 })
            .then(() => true, () => false);
        if (landed) {
            await expect(page).toHaveURL(targetUrl);
            return;
        }

        if (await retryButton.isVisible().catch(() => false)) {
            await retryButton.click();
            continue;
        }

        // No Retry offered means this is not the transient state; stop
        // absorbing time and let the real wait report what the page shows.
        break;
    }

    await resolvedPresentation.waitFor({ state: 'visible', timeout: timeoutMs });
    await expect(page).toHaveURL(targetUrl);
}

/**
 * Asserts that the player actually started, not merely that the route changed.
 *
 * Every watch-link test ends this way, so the wait lives here rather than
 * repeated inline: a per-site budget is exactly what drifted out of sync with
 * the measured host and turned contention into a false regression report.
 *
 * @param page - Page under test, already on the video route.
 */
async function expectPlaybackStarted(page: import('@playwright/test').Page) {
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: PLAYER_READY_TIMEOUT_MS });
    // readyState >= HAVE_CURRENT_DATA: the element exists AND has decoded a
    // frame, so this fails if the player renders but never receives media.
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: PLAYER_READY_TIMEOUT_MS })
        .toBeGreaterThanOrEqual(2);
}

/**
 * A well-formed IMDb id that no item in any library carries, used to observe
 * the empty result.
 */
const UNMINTED_IMDB_ID = 'tt0000001';

/** A well-formed sk- id with no library item, used to observe an empty result. */
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
/**
 * Opens an item's real context menu and clicks one copy command, without
 * waiting for the resulting ensure/publish call to finish. Split out from
 * {@link copyFromItemMenu} so a caller can observe in-flight state (the
 * loading spinner) between the click and the eventual toast.
 *
 * @param page - Page under test.
 * @param commandId - Which copy command to invoke.
 * @param itemId - The item whose menu is opened.
 * @param serverId - The server the item belongs to.
 */
async function clickItemMenuCommand(
    page: import('@playwright/test').Page,
    commandId: 'copy-link' | 'copy-play-link',
    itemId: string,
    serverId: string
): Promise<void> {
    await page.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
    // Clear the previous recording explicitly rather than let a second copy in
    // one test read the first one's value.
    await page.evaluate(() => {
        delete (window as CopyRecorderWindow).__permalinkCopiedText;
    });

    const moreCommands = page.locator('.btnMoreCommands');
    await expect(moreCommands).toBeVisible({ timeout: loadScaledMs(20_000) });
    await moreCommands.click();

    const command = page.locator(`[data-id="${commandId}"]`);
    await expect(command).toBeVisible({ timeout: loadScaledMs(10_000) });
    await command.click();
}

async function copyFromItemMenu(
    page: import('@playwright/test').Page,
    commandId: 'copy-link' | 'copy-play-link',
    itemId: string,
    serverId: string
): Promise<string> {
    await clickItemMenuCommand(page, commandId, itemId, serverId);
    return readPublishedLink(page);
}

/**
 * Publishes an item's permalink the way a user does, by copying its link from
 * the item page, and returns the alias in that URL.
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
    test('a legacy #/p/<id> link canonicalizes and renders details at /<id>', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-link');

        await page.goto(`/web/#/p/${alias}`);

        await waitForPermalinkTarget(page, new RegExp(`/${alias}$`), RESOLVE_TIMEOUT_MS);
    });

    test('a legacy #/w/<id> link canonicalizes to /w/<id> and starts playback', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-play-link');

        await page.goto(`/web/#/w/${alias}`);

        await waitForPermalinkTarget(page, new RegExp(`/w/${alias}$`), PLAYBACK_RESOLVE_TIMEOUT_MS);
        await expectPlaybackStarted(page);
    });

    test('an external alias with no matching item shows not found and never guesses', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/${UNMINTED_IMDB_ID}`);

        const message = page.locator('#permalinkMessagePage');
        await expect(message).toBeVisible({ timeout: loadScaledMs(20_000) });
        await expect(message).toContainText(UNMINTED_IMDB_ID);
        await expect(page).toHaveURL(new RegExp(`/${UNMINTED_IMDB_ID}$`));
    });

    test('a well-formed sk- alias the server never issued shows a not-found message, never a guess', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/${UNKNOWN_SLOPTANK_ID}`);

        await expect(page.locator('#permalinkMessagePage')).toBeVisible({ timeout: loadScaledMs(20_000) });
        await expect(page.locator('#permalinkMessagePage')).toContainText(UNKNOWN_SLOPTANK_ID);
    });

    test('a malformed permalink id shows an invalid-link message without any network lookup', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto('/not-a-real-permalink');

        await expect(page.locator('#fallbackPage')).toBeVisible({ timeout: loadScaledMs(20_000) });
    });

    test('a previously shared #/details?...&autoplay=1 link still starts playback (regression: autoplay was silently dropped when the video route became the durable permalink)', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}&autoplay=1`);

        await waitForPermalinkTarget(page, /\/w\/(?:tt\d+|(?:tm|tv)-(?:mv|tv|ep|se|co)-\d+|sk-[0-9a-hjkmnp-tv-z]{26})$/, PLAYBACK_RESOLVE_TIMEOUT_MS);
        await expectPlaybackStarted(page);
    });
});

test.describe('browser-path compatibility (design section 6.2)', () => {
    test('/web/p/<id> replaces itself with the canonical info route', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-link');

        await page.goto(`/web/p/${alias}`);

        await waitForPermalinkTarget(page, new RegExp(`/${alias}$`), RESOLVE_TIMEOUT_MS);
    });

    test('/web/w/<id> replaces itself with the canonical watch route and starts playback', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-play-link');

        await page.goto(`/web/w/${alias}`);

        await waitForPermalinkTarget(page, new RegExp(`/w/${alias}$`), PLAYBACK_RESOLVE_TIMEOUT_MS);
        await expectPlaybackStarted(page);
    });
});

test.describe('signed-out access (design section 4.3)', () => {
    test('opening a permalink while signed out redirects to login, then lands on the item after signing in', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-link');

        // Drop the stored session, then enter through the bare pretty URL. That
        // is a real top-level navigation rather than a hash change, so the app
        // reboots and actually reads the cleared storage -- clearing it under a
        // running page leaves the in-memory session signed in.
        await page.evaluate(() => window.localStorage.clear());
        await context.clearCookies();

        await page.goto(`/${alias}`);

        // ConnectionRequired encodes the permalink path into the login url
        // before any resolution is attempted, so a signed-out visitor never
        // sees a bare "not found" for a link they simply have not opened yet.
        await page.waitForURL(/\/web\/login\?/, { timeout: loadScaledMs(20_000) });
        expect(new URL(page.url()).search).toContain(encodeURIComponent(`/${alias}`));

        await submitManualLogin(page, config.username, config.password);

        await waitForPermalinkTarget(page, new RegExp(`/${alias}$`), RESOLVE_TIMEOUT_MS);
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

    test('Copy Link shows progress immediately instead of silently freezing while ensure runs (regression: no spinner, no disabled state, no toast for ~25s)', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        // Hold the ensure response open so the in-flight state is observable.
        //
        // This is what the test is actually about, and it must not depend on
        // the server being slow. The regression it guards shipped when ensure
        // took ~25s for every call; since SlopTank-server 3fc58b5 cached the
        // content digest a warm ensure answers in ~0.13s, which is faster than
        // any assertion can sample -- so against the real server this test
        // started reporting "no spinner" for a command that had already
        // finished. Delaying the response reproduces the slow case on demand,
        // which is the only way to assert the in-flight contract for both a
        // cold multi-GB item and a warm one.
        let releaseEnsure: () => void = () => { /* replaced before the click below */ };
        const ensureHeld = new Promise<void>(resolve => {
            releaseEnsure = resolve;
        });
        await page.route(`**/Items/${episodeId}/Permalink`, async route => {
            await ensureHeld;
            await route.continue();
        });

        await clickItemMenuCommand(page, 'copy-link', episodeId, config.serverId);

        // Held mid-flight: the command must already be showing progress rather
        // than leaving the UI looking like nothing happened.
        await expect(page.locator('.docspinner.mdlSpinnerActive')).toBeVisible({ timeout: loadScaledMs(10_000) });
        // ...and it must still be showing it a beat later, not flash once.
        await expect(page.locator('.toastContainer .toast')).toHaveCount(0);

        releaseEnsure();

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        await expect(page.locator('.docspinner.mdlSpinnerActive')).toHaveCount(0);
    });

    test('Copy Link ensures the item and copies a pretty URL that resolves back to the same item', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-link', episodeId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        const origin = new URL(page.url()).origin;
        expect(copiedUrl).toMatch(new RegExp(`^${origin}/(?:tt\\d+|(?:tm|tv)-(?:mv|tv|ep|se|co)-\\d+|sk-[0-9a-hjkmnp-tv-z]{26})$`));

        await page.goto(copiedUrl);
        await waitForPermalinkTarget(page, new RegExp(`${new URL(copiedUrl).pathname}$`), RESOLVE_TIMEOUT_MS);
    });

    test('Copy Play Link ensures the item and copies a URL that starts playback', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-play-link', episodeId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent play link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        const origin = new URL(page.url()).origin;
        expect(copiedUrl).toMatch(new RegExp(`^${origin}/w/(?:tt\\d+|(?:tm|tv)-(?:mv|tv|ep|se|co)-\\d+|sk-[0-9a-hjkmnp-tv-z]{26})$`));

        await page.goto(copiedUrl);
        await waitForPermalinkTarget(page, new RegExp(`${new URL(copiedUrl).pathname}$`), PLAYBACK_RESOLVE_TIMEOUT_MS);
        await expectPlaybackStarted(page);
    });

    test('a real item with no provider id mints and resolves an sk- alias through Copy Link', async ({ page, context, config }) => {
        const noProviderItemId = requireNoProviderItemId();
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-link', noProviderItemId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        expect(copiedUrl).toMatch(/\/sk-[0-9a-hjkmnp-tv-z]{26}$/);

        await page.goto(copiedUrl);
        await waitForPermalinkTarget(page, new RegExp(`${new URL(copiedUrl).pathname}$`), RESOLVE_TIMEOUT_MS);
    });
});
