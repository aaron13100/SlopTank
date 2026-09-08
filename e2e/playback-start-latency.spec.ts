import { VIDEO_ROUTE, WATCH_PERMALINK_ROUTE, expect, login, test } from './fixtures';

test.setTimeout(300_000);

/**
 * Real-browser latency coverage for the two ways a video actually gets played:
 * pressing Play on a details page, and opening a watch link someone was sent.
 *
 * Every other spec in this directory asks whether playback STARTS. This one
 * asks how long it takes, because "it works, eventually" is the failure the
 * owner actually hit: watch links that resolved correctly and still never
 * became watchable inside any patience a person has. A correctness suite
 * cannot catch that, since its budgets are deliberately generous enough to
 * absorb host contention rather than report it as a broken link.
 *
 * The budget below is therefore a product statement, not a tuned threshold,
 * and it is asserted on rather than merely reported, so a regression fails a
 * promotion instead of appearing in a log nobody reads.
 */

/**
 * How long a person will wait for a video to start before deciding it is
 * broken. Stated by the owner on 2026-09-02 as the acceptance criterion for
 * the permalink playback promotion: playback has to start in a reasonable
 * amount of time, for example under 10 seconds.
 *
 * Measured from the user's action (the Play click, or the navigation to a
 * watch link) to the first decoded frame actually playing, so it includes
 * permalink minting, redemption, playback-info negotiation and player setup.
 * It deliberately does NOT include logging in or loading the details page,
 * which are separate interactions the user has already paid for.
 */
const PLAYBACK_START_BUDGET_MS = 10_000;

/*
 * The budget assertions below are SOFT on purpose.
 *
 * A hard assertion ends the test at the first item over budget, so the items
 * after it are never measured at all. That matters because the promotion tool
 * compares each measurement against a baseline taken minutes earlier on the
 * same host, and a number that was never produced cannot be compared: one slow
 * item would hide a real regression in every other one. Soft assertions
 * measure everything and still fail the test.
 */

/**
 * Ceiling for the wait itself, kept far above the budget on purpose.
 *
 * A wait that expires at the budget can only ever report "10s elapsed", which
 * loses the difference between 11 seconds and four minutes. That distance is
 * the whole diagnosis: a small overrun is host contention, a large one is a
 * full media scan on the play path. So the wait is generous and the ASSERTION
 * is strict, and a failure gets to name the real number.
 */
const PLAYBACK_START_CEILING_MS = 240_000;

/**
 * How long minting a watch link may take before the test gives up on it.
 *
 * Not a budget, and deliberately not compared against one. Minting proves the
 * media's identity with a full-content hash the first time it runs, which on a
 * multi-GB film is minutes; the server precomputes those digests nightly so a
 * real click does not pay it. This ceiling only stops the test hanging forever
 * on a library that has never been precomputed.
 */
const MINT_TIMEOUT_MS = 900_000;

interface PlaybackReport {
    ItemId: string;
    PlaySessionId: string;
    [key: string]: unknown;
}

interface CapturedPlayback {
    authorizationHeaders: Record<string, string>;
    report: PlaybackReport;
    stoppedUrl: string;
}

/**
 * Chooses which items to measure, worst case first.
 *
 * Defaults to the configured e2e item so the spec is runnable on its own. The
 * promotion tool overrides it with the largest media files in the library,
 * because size is the axis this regressed on: a play path that reads the file
 * is fast on a 170 MB episode and unusable on a 10 GB film, so a gate that
 * only ever measured the small one would have passed throughout the outage.
 *
 * @param configuredItemId - The e2e config's item, used when no override is set.
 * @returns Item ids to measure, in the order given.
 */
function latencyItemIds(configuredItemId: string): string[] {
    const override = process.env.E2E_LATENCY_ITEM_IDS; // allow-direct-env: e2e spec selecting its own fixture data, and this test process has no config layer to route it through
    const ids = (override ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    return ids.length > 0 ? ids : [configuredItemId];
}

/** Wall-clock reading, used only to time the interaction under observation. */
function nowMs(): number {
    return Date.now(); // allow-direct-time: this spec's subject IS elapsed wall-clock time as a user experiences it, so an injected clock would measure nothing
}

/**
 * Waits until the player is genuinely playing decoded media.
 *
 * `!paused && readyState >= 2` is the same condition the rest of the suite
 * treats as "playback started", so the number this spec reports stays
 * comparable with those specs instead of inventing a second definition.
 *
 * @param page - Page under test, already on or heading to the video route.
 * @returns Resolves once playback is real; rejects at the ceiling, not the budget.
 */
async function waitUntilPlaying(page: import('@playwright/test').Page): Promise<void> {
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: PLAYBACK_START_CEILING_MS });
    await expect
        .poll(
            async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2),
            { timeout: PLAYBACK_START_CEILING_MS, intervals: [100] }
        )
        .toBe(true);
}

/**
 * Runs one playback interaction and always releases a started session on the
 * server, even when navigation or an assertion rejects midway through it.
 *
 * The stop report is cloned from the real client's latest start/progress
 * request. That retains the actual item, play-session, media-source and
 * position state instead of fabricating a second session model in the test.
 */
async function withServerPlayback<T>(
    page: import('@playwright/test').Page,
    itemId: string,
    action: () => Promise<T>
): Promise<T> {
    let playback: CapturedPlayback | undefined;
    let actionCompleted = false;
    const capturePlaybackReport = (request: import('@playwright/test').Request) => {
        const url = new URL(request.url());
        if (
            request.method() !== 'POST'
            || !/\/Sessions\/Playing(?:\/Progress)?$/.test(url.pathname)
        ) {
            return;
        }

        const report = request.postDataJSON() as Partial<PlaybackReport> | null;
        if (
            !report
            || report.ItemId !== itemId
            || typeof report.PlaySessionId !== 'string'
            || !report.PlaySessionId
        ) {
            return;
        }

        url.pathname = url.pathname.replace(
            /\/Sessions\/Playing(?:\/Progress)?$/,
            '/Sessions/Playing/Stopped'
        );
        url.search = '';
        const requestHeaders = request.headers();
        const authorizationHeaders: Record<string, string> = {};
        for (const name of [ 'authorization', 'x-emby-authorization', 'x-emby-token' ]) {
            const value = requestHeaders[name];
            if (value) {
                authorizationHeaders[name] = value;
            }
        }
        playback = {
            authorizationHeaders,
            report: report as PlaybackReport,
            stoppedUrl: url.toString()
        };
    };

    page.on('request', capturePlaybackReport);
    let actionResult: T | undefined;
    let actionFailure: unknown;
    let actionFailed = false;
    try {
        actionResult = await action();
        actionCompleted = true;
    } catch (error) {
        actionFailed = true;
        actionFailure = error;
    } finally {
        page.off('request', capturePlaybackReport);
    }

    let cleanupFailure: unknown;
    try {
        if (playback) {
            const response = await page.context().request.post(playback.stoppedUrl, {
                data: playback.report,
                headers: playback.authorizationHeaders,
                timeout: 30_000
            });
            if (!response.ok()) {
                throw new Error(
                    `server playback cleanup failed with HTTP ${response.status()} `
                    + `for item ${playback.report.ItemId} session ${playback.report.PlaySessionId}`
                );
            }
        } else if (actionCompleted) {
            throw new Error(
                `playback completed for item ${itemId} without a real play-session report to stop`
            );
        }
    } catch (error) {
        cleanupFailure = error;
    }

    if (actionFailed && cleanupFailure) {
        throw new AggregateError(
            [ actionFailure, cleanupFailure ],
            `playback action and server cleanup both failed for item ${itemId}`
        );
    }
    if (actionFailed) {
        throw actionFailure;
    }
    if (cleanupFailure) {
        throw cleanupFailure;
    }
    return actionResult as T;
}

/**
 * Reports one measurement into the test output, so a passing run is still
 * evidence rather than just a green tick.
 *
 * A latency gate whose passing runs record nothing cannot show a trend, and
 * the first question after any regression is what the number used to be.
 *
 * @param label - Which of the two paths was measured.
 * @param itemId - The item the measurement was taken against.
 * @param elapsedMs - Observed time from the user's action to a playing frame.
 */
function reportMeasurement(label: string, itemId: string, elapsedMs: number): void {
    const verdict = elapsedMs <= PLAYBACK_START_BUDGET_MS ? 'within' : 'OVER';
    console.log(
        `[playback-start-latency] ${label} item=${itemId} elapsed=${(elapsedMs / 1000).toFixed(2)}s `
        + `budget=${(PLAYBACK_START_BUDGET_MS / 1000).toFixed(0)}s ${verdict}`
    );
}

test.describe('playback start latency', () => {
    test('pressing Play starts the video within the budget', async ({ page, config }) => {
        await login(page, config.username, config.password);

        for (const itemId of latencyItemIds(config.itemId)) {
            await page.goto(`/web/details?id=${itemId}&serverId=${config.serverId}`);
            await page.waitForURL((url) => url.pathname !== '/web/details', { timeout: 90_000 });

            const playButton = page.locator('.mainDetailButtons .btnPlay:visible');
            await expect(playButton).toBeVisible({ timeout: 60_000 });

            const elapsedMs = await withServerPlayback(page, itemId, async () => {
                const started = nowMs();
                await playButton.click();
                await waitUntilPlaying(page);
                await expect(page).toHaveURL(VIDEO_ROUTE);
                return nowMs() - started;
            });

            reportMeasurement('play-button', itemId, elapsedMs);
            expect.soft(
                elapsedMs,
                `pressing Play on item ${itemId} took ${(elapsedMs / 1000).toFixed(2)}s to reach a playing `
                + `frame, over the ${PLAYBACK_START_BUDGET_MS / 1000}s a person will wait`
            ).toBeLessThanOrEqual(PLAYBACK_START_BUDGET_MS);
        }
    });

    test('opening a watch link starts the video within the budget', async ({ page, config }) => {
        await login(page, config.username, config.password);

        for (const itemId of latencyItemIds(config.itemId)) {
            // Mint the link the way a user does, by playing once. The URL left
            // in the address bar IS the link they would share, so reopening
            // exactly that string is the shared-link path rather than a
            // reconstruction of it.
            await page.goto(`/web/details?id=${itemId}&serverId=${config.serverId}`);
            await page.waitForURL((url) => url.pathname !== '/web/details', { timeout: 90_000 });

            // Minting is a request the page issues while playback starts, and
            // it must be allowed to finish. Navigating away cancels it and
            // leaves the alias mid-mutation, after which reopening the link
            // waits on that mutation to settle: measured 143.63s against 7.29s
            // when the mint was allowed to complete. A person who shares a link
            // does not close the tab the instant the video appears, so timing
            // the abandoned case would be measuring the test, not the product.
            const minted = page.waitForResponse(
                (response) => response.request().method() === 'POST'
                    && /^\/Items\/[^/]+\/Permalink$/.test(new URL(response.url()).pathname),
                { timeout: MINT_TIMEOUT_MS }
            );
            const watchUrl = await withServerPlayback(page, itemId, async () => {
                await page.locator('.mainDetailButtons .btnPlay:visible').click();
                await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 180_000 });
                await waitUntilPlaying(page);
                await minted;
                return page.url();
            });

            // The link is opened in a NEW tab of the same browser, which is
            // both what a person does with a link they were sent and the only
            // way to keep the session: loading /web/index.html directly drops
            // it and lands on "Please sign in", so navigating this page there
            // would measure a login screen rather than a watch link.
            const shared = await page.context().newPage();
            const permalinkRequests: string[] = [];
            const capturePermalinkRequest = (request: import('@playwright/test').Request) => {
                const path = new URL(request.url()).pathname;
                if (/^\/Permalinks\/[^/]+\/Items$/.test(path)) {
                    permalinkRequests.push(`${request.method()} /Permalinks/:id/Items`);
                } else if (/^\/Permalinks\/Candidates\/[^/]+\/PlaybackReadyV1$/.test(path)) {
                    permalinkRequests.push(
                        `${request.method()} /Permalinks/Candidates/:handle/PlaybackReadyV1`
                    );
                } else if (path.startsWith('/Permalinks/')) {
                    permalinkRequests.push(`${request.method()} ${path}`);
                }
            };
            shared.on('request', capturePermalinkRequest);
            try {
                const elapsedMs = await withServerPlayback(shared, itemId, async () => {
                    const started = nowMs();
                    await shared.goto(watchUrl);
                    await waitUntilPlaying(shared);
                    await expect(shared).toHaveURL(VIDEO_ROUTE);
                    return nowMs() - started;
                });

                reportMeasurement('watch-link', itemId, elapsedMs);
                expect.soft(
                    elapsedMs,
                    `opening watch link ${watchUrl} took ${(elapsedMs / 1000).toFixed(2)}s to reach a playing `
                    + `frame, over the ${PLAYBACK_START_BUDGET_MS / 1000}s a person will wait`
                ).toBeLessThanOrEqual(PLAYBACK_START_BUDGET_MS);
                expect(permalinkRequests).toEqual([
                    'GET /Permalinks/:id/Items',
                    'POST /Permalinks/Candidates/:handle/PlaybackReadyV1'
                ]);
            } finally {
                shared.off('request', capturePermalinkRequest);
                await shared.close();
            }
        }
    });
});
