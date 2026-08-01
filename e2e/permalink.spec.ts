import { expect, login, requireEpisodeItemId, requireNoProviderItemId, submitManualLogin, test } from './fixtures';

test.setTimeout(600_000);

/**
 * Budgets for the server round trips these tests wait on.
 *
 * Permalink evidence is a SHA-256 over the whole media file. Since
 * SlopTank-server 3fc58b5 that digest is cached against a filesystem change
 * token, so only the FIRST call for an item pays the full read and every
 * repeat is effectively free. Measured against the live server on 2026-08-01
 * (t_260720_015135_519), 868 MB episode: ensure 34.1s cold then 0.147s and
 * 0.132s warm; discovery 0.54s; details redemption 2.4s.
 *
 * The budgets stay sized for the cold call rather than the warm one, because
 * which call is cold depends on what ran before -- a fresh item, a rescan or a
 * server restart puts any test back on the 34s path. They are deliberately
 * generous rather than tight: a timeout tuned to the warm case fails as
 * "nothing was copied" or "never navigated" for an operation that was simply
 * still running, which hides real regressions behind a latency budget.
 */
const ENSURE_TIMEOUT_MS = 90_000;

/** Opening an info link: discovery plus details redemption. */
const RESOLVE_TIMEOUT_MS = 150_000;

/**
 * Opening a play link, which is heavier than an info link: discovery, the
 * playback-lease exchange and the playback redemption, and the redemption
 * additionally materializes and hashes the immutable snapshot.
 */
const PLAYBACK_RESOLVE_TIMEOUT_MS = 300_000;

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
const PLAYER_READY_TIMEOUT_MS = 60_000;

/**
 * Waits for a permalink route to reach its target, using the Retry affordance
 * when the server reports the designed transient conflict.
 *
 * Ensure commits the item's durable identity mutation, and a link opened in the
 * same breath can reach discovery while that mutation is still settling. The
 * server answers 409 `identity-mutation-pending` and the route renders it with
 * a Retry button rather than guessing -- observed live on 2026-08-01
 * (t_260720_015135_519) opening `#/w/<alias>` immediately after minting it.
 *
 * Clicking Retry is what a real user does with that screen, so driving it here
 * covers the conflict path that nothing else exercised, while still failing if
 * the link never resolves. It never masks a permanent failure: the retries are
 * bounded, and any other permalink state (not found, evidence required,
 * invalid) has no Retry button and falls straight through to the URL wait.
 *
 * @param page - Page under test, already navigated to the permalink route.
 * @param targetUrl - The legacy route the permalink must land on.
 * @param timeoutMs - Budget for the whole resolution, retries included.
 */
async function waitForPermalinkTarget(
    page: import('@playwright/test').Page,
    targetUrl: RegExp,
    timeoutMs: number
) {
    const retryButton = page.locator('#permalinkRetryButton');

    for (let attempt = 0; attempt < 5; attempt++) {
        const landed = await page.waitForURL(targetUrl, { timeout: timeoutMs / 5 }).then(() => true, () => false);
        if (landed) return;

        if (await retryButton.isVisible().catch(() => false)) {
            await retryButton.click();
            continue;
        }

        // No Retry offered means this is not the transient state; stop
        // absorbing time and let the real wait report what the page shows.
        break;
    }

    await page.waitForURL(targetUrl, { timeout: timeoutMs });
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
    await page.goto(`/web/#/details?id=${itemId}&serverId=${serverId}`);
    // Navigating between two hash routes does not reload the document, so the
    // recorder is not reinstalled. Clear it explicitly rather than let a second
    // copy in one test read the first one's value.
    await page.evaluate(() => {
        delete (window as CopyRecorderWindow).__permalinkCopiedText;
    });

    const moreCommands = page.locator('.btnMoreCommands');
    await expect(moreCommands).toBeVisible({ timeout: 20_000 });
    await moreCommands.click();

    const command = page.locator(`[data-id="${commandId}"]`);
    await expect(command).toBeVisible({ timeout: 10_000 });
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
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-link');

        await page.goto(`/web/#/p/${alias}`);

        await waitForPermalinkTarget(page, /#\/details\?id=/, RESOLVE_TIMEOUT_MS);
        expect(new URL(page.url()).hash).toContain(`id=${episodeId}`);
    });

    test('an external alias opens the video route and starts playback through #/w/<id>', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-play-link');

        await page.goto(`/web/#/w/${alias}`);

        await waitForPermalinkTarget(page, /#\/video\?id=/, PLAYBACK_RESOLVE_TIMEOUT_MS);
        await expectPlaybackStarted(page);
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

        await waitForPermalinkTarget(page, /#\/video\?id=/, PLAYBACK_RESOLVE_TIMEOUT_MS);
        await expectPlaybackStarted(page);
    });
});

test.describe('candidate C: the bare pretty entry URL (design section 6.2)', () => {
    test('a bare /web/p/<id> URL with no hash redirects through the server middleware to the item', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-link');

        // A real top-level navigation, not a hash change: this only resolves if
        // the server's redirect middleware answers with a 302 to the hash form
        // before the SPA ever loads.
        await page.goto(`/web/p/${alias}`);

        await waitForPermalinkTarget(page, /#\/details\?id=/, RESOLVE_TIMEOUT_MS);
        expect(new URL(page.url()).hash).toContain(`id=${episodeId}`);
    });

    test('a bare /web/w/<id> URL with no hash redirects through the server middleware and starts playback', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        const alias = await mintPermalinkId(page, context, episodeId, config.serverId, 'copy-play-link');

        await page.goto(`/web/w/${alias}`);

        await waitForPermalinkTarget(page, /#\/video\?id=/, PLAYBACK_RESOLVE_TIMEOUT_MS);
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

        await page.goto(`/web/p/${alias}`);

        // ConnectionRequired encodes the permalink path into the login url
        // before any resolution is attempted, so a signed-out visitor never
        // sees a bare "not found" for a link they simply have not opened yet.
        await page.waitForURL(/#\/login\?/, { timeout: 20_000 });
        expect(new URL(page.url()).hash).toContain(encodeURIComponent(`/p/${alias}`));

        await submitManualLogin(page, config.username, config.password);

        await waitForPermalinkTarget(page, /#\/details\?id=/, RESOLVE_TIMEOUT_MS);
        expect(new URL(page.url()).hash).toContain(`id=${episodeId}`);
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
        await expect(page.locator('.docspinner.mdlSpinnerActive')).toBeVisible({ timeout: 10_000 });
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
        expect(copiedUrl.startsWith(`${origin}/web/p/`), `expected a pretty link under ${origin}, got: ${copiedUrl}`).toBe(true);

        await page.goto(copiedUrl);
        await waitForPermalinkTarget(page, /#\/details\?id=/, RESOLVE_TIMEOUT_MS);
        expect(new URL(page.url()).hash).toContain(`id=${episodeId}`);
    });

    test('Copy Play Link ensures the item and copies a URL that starts playback', async ({ page, context, config }) => {
        const episodeId = requireEpisodeItemId();
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-play-link', episodeId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent play link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        const origin = new URL(page.url()).origin;
        expect(copiedUrl.startsWith(`${origin}/web/w/`), `expected a pretty link under ${origin}, got: ${copiedUrl}`).toBe(true);

        await page.goto(copiedUrl);
        await waitForPermalinkTarget(page, /#\/video\?id=/, PLAYBACK_RESOLVE_TIMEOUT_MS);
        await expectPlaybackStarted(page);
    });

    test('a real item with no provider id mints and resolves an sk- alias through Copy Link', async ({ page, context, config }) => {
        const noProviderItemId = requireNoProviderItemId();
        await login(page, config.username, config.password);
        await context.grantPermissions([ 'clipboard-read', 'clipboard-write' ]);

        const copiedUrl = await copyFromItemMenu(page, 'copy-link', noProviderItemId, config.serverId);

        await expect(page.locator('.toastContainer .toast')).toContainText('Permanent link copied successfully.', { timeout: ENSURE_TIMEOUT_MS });
        expect(copiedUrl).toMatch(/\/web\/p\/sk-[0-9a-hjkmnp-tv-z]{26}$/);

        await page.goto(copiedUrl);
        await waitForPermalinkTarget(page, /#\/details\?id=/, RESOLVE_TIMEOUT_MS);
        expect(new URL(page.url()).hash).toContain(`id=${noProviderItemId}`);
    });
});
