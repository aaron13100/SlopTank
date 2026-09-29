// SlopTank modification notice: added or changed by SlopTank on 2026-09-23, 2026-09-29.
import { expect, type Page } from '@playwright/test';

import {
    clickOsdControl,
    login,
    onScreenState,
    requireEpisodeItemId,
    test,
    VIDEO_ROUTE,
    wakeOsd,
    type OnScreenState
} from './fixtures';

test.setTimeout(240_000);

/**
 * The now-playing title label on the video player.
 *
 * The owner asked (2026-09-28, t_260928_225116_193), reversing the earlier
 * 2026-09-12 "Netflix style" always-on request: the label must be visible
 * ONLY while the player controls (OSD) are visible. When the controls
 * auto-hide, windowed or in full screen, the label hides with them, and a
 * mouse move brings both back together. Reported symptom: the episode name
 * stayed on screen in full screen after the controls faded.
 *
 * The label is decoration: `pointer-events: none`, never focusable,
 * `aria-hidden`. Its visibility is driven by the same SHOW_VIDEO_OSD event
 * the OSD chrome itself fires (osdVisibility.js), so it cannot drift from
 * the controls again.
 */

/**
 * The scope every player-DOM read in this spec uses: a next-track transition
 * routes through a fresh video view while the old one stays mounted but
 * hidden (viewManager adds .hide to it), and reads scoped any wider match
 * both copies -- a strict-mode violation on locators and a wrong answer from
 * querySelector.
 */
const ACTIVE_PAGE = '.page:not(.hide)';

// Scoped to the view that is on screen: a next-track transition routes
// through a fresh video view while the old one stays mounted but hidden
// (viewManager adds .hide to it), and the hidden copy's label must never be
// mistaken for the one the viewer is looking at.
const PERSISTENT_TITLE = `${ACTIVE_PAGE} .persistentVideoTitle`;

/** Everything the assertions need about the label's rendered state. */
interface PersistentTitleState {
    exists: boolean;
    text: string;
    hiddenByClass: boolean;
    display: string;
    visibility: string;
    pointerEvents: string;
    ariaHidden: string | null;
}

async function startPlayback(page: Page, itemId: string, serverId: string) {
    await page.goto(`/web/details?id=${itemId}&serverId=${serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate((element: HTMLVideoElement) => !element.paused && element.readyState >= 2), {
            timeout: 60_000,
            message: 'expected the selected item to start playing'
        })
        .toBe(true);

    return video;
}

/**
 * Read the title the playback header shows.
 *
 * The composed title reaches the screen through LibraryMenu.setTitle(), which
 * writes the skinHeader's .pageTitle (the template's .osdTitle has no writer
 * and stays empty at HEAD, observed 2026-09-22). setTitle() feeds both that
 * header and the VIDEO_TITLE_CHANGE event the persistent label consumes, so
 * equality between the two proves the label did not grow a second composer.
 * textContent works while the header is faded, and it fades with the OSD
 * after ~3 idle seconds, so the OSD is woken here to read it.
 */
async function readHeaderTitle(page: Page): Promise<string> {
    await expect
        .poll(async () => (await page.locator('.skinHeader .pageTitle').textContent())?.trim() || '', {
            timeout: 60_000,
            message: 'expected the playback header to receive the composed title'
        })
        .not
        .toBe('');

    return (await page.locator('.skinHeader .pageTitle').textContent())?.trim() || '';
}

/** Wait until the playback header carries a title different from `previous`. */
async function waitForHeaderTitleChange(page: Page, previous: string): Promise<string> {
    await expect
        .poll(async () => (await page.locator('.skinHeader .pageTitle').textContent())?.trim() || '', {
            timeout: 60_000,
            message: 'expected the playback header to change for the next episode'
        })
        .not
        .toBe(previous);

    return (await page.locator('.skinHeader .pageTitle').textContent())?.trim() || '';
}

async function persistentTitleState(page: Page): Promise<PersistentTitleState & { osdVisible: boolean }> {
    return page.evaluate((selectors: [ string, string ]) => {
        const [ titleSelector, pageScope ] = selectors;
        // The controls are judged by the same state osdVisibility sets: the
        // 'hide' class (added after the fade-out transition) and computed
        // display. Read in-page and scoped, because an unscoped selector
        // matches the hidden previous-episode view too.
        const osdBottom = document.querySelector(`${pageScope} .videoOsdBottom-maincontrols`);
        const osdVisible = !!osdBottom
            && !osdBottom.classList.contains('hide')
            && window.getComputedStyle(osdBottom).display !== 'none';

        const element = document.querySelector(titleSelector);
        if (!element) {
            return {
                exists: false, text: '', hiddenByClass: false, display: '',
                visibility: '', pointerEvents: '', ariaHidden: null, osdVisible
            };
        }

        const style = window.getComputedStyle(element);
        return {
            exists: true,
            text: (element.textContent || '').trim(),
            hiddenByClass: element.classList.contains('hide'),
            display: style.display,
            visibility: style.visibility,
            pointerEvents: style.pointerEvents,
            ariaHidden: element.getAttribute('aria-hidden'),
            osdVisible
        };
    }, [ PERSISTENT_TITLE, ACTIVE_PAGE ]);
}

/**
 * Sit still until the OSD auto-hides, then keep sitting still.
 *
 * The viewer watching a movie does not move the pointer; the OSD hides itself
 * after ~3 idle seconds. Measured through the ancestor opacity chain (the
 * pattern of e2e/video-osd-chrome.spec.ts) because the hide is a transition,
 * and a mid-fade poll would read an element that is neither up nor away.
 */
async function waitUntilOsdHidden(page: Page): Promise<void> {
    await expect
        .poll(async () => page.evaluate(() => {
            let opacity = 1;
            // Scoped to the on-screen view: after a next-track transition the
            // previous episode's view stays mounted hidden, and the first
            // unscoped match can be that stale copy.
            let node: Element | null = document.querySelector('.page:not(.hide) .videoOsdBottom-maincontrols');
            while (node) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return 0;
                opacity *= Number.parseFloat(style.opacity) || 0;
                node = node.parentElement;
            }
            return opacity;
        }), {
            timeout: 30_000,
            message: 'expected the OSD controls to auto-hide while playback continues'
        })
        .toBeLessThan(0.05);
}

/** Wait until the bottom OSD controls of the on-screen view are up again. */
async function waitUntilOsdShown(page: Page): Promise<void> {
    await expect
        .poll(() => persistentTitleState(page).then(state => state.osdVisible), {
            timeout: 15_000,
            message: 'expected the OSD controls to come back after the pointer moves'
        })
        .toBe(true);
}

/** Wait until the document is (or is no longer) in element fullscreen. */
async function waitForFullscreen(page: Page, fullscreen: boolean): Promise<void> {
    await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null), {
            timeout: 20_000,
            message: `expected the document to ${fullscreen ? 'enter' : 'leave'} fullscreen`
        })
        .toBe(fullscreen);
}

/**
 * Expect the label on screen with exactly the expected string, and placed at
 * the bottom-left where it cannot sit under the centered subtitle column,
 * while the OSD controls are up beside it.
 *
 * One atomic predicate, retried as a whole: the label's visibility now
 * follows the OSD, so the OSD is held awake inside the poll (the
 * revealOsdControl pattern) -- a poll that let the 3s idle timer hide the
 * controls mid-read would fail on correct behavior. Splitting "state looks
 * right" from "on screen" into two reads lets a hide slip between them.
 *
 * onScreenState() rather than toBeVisible(): USER reachability (the brief's
 * placement decision), not DOM presence.
 */
async function expectPersistentTitleOnScreen(page: Page, expected: string) {
    let last: { state: PersistentTitleState & { osdVisible: boolean }; screen: OnScreenState } | undefined;
    try {
        await expect
            .poll(async () => {
                await wakeOsd(page);
                const [state, screen] = await Promise.all([
                    persistentTitleState(page),
                    onScreenState(page, PERSISTENT_TITLE)
                ]);
                last = { state, screen };
                return state.exists && !state.hiddenByClass && state.text === expected
                    && state.display === 'block' && state.visibility === 'visible'
                    && state.pointerEvents === 'none' && state.ariaHidden === 'true'
                    && state.osdVisible
                    && screen.insideViewport
                    && screen.rect !== null
                    && screen.rect.y + screen.rect.height >= screen.viewport.height * 0.9
                    && screen.rect.x < screen.viewport.width * 0.15;
            }, {
                timeout: 30_000,
                message: 'expected the persistent title on screen, bottom-left, with the composed title, while the OSD controls are visible'
            })
            .toBe(true);
    } catch (timeout) {
        // The poll message alone cannot say WHY the label never showed: the
        // captured last sample distinguishes a label defect (state/screen)
        // from the app holding the OSD down or hiding it.
        throw new Error( // allow-raw-error: test assertion failure detail, not production code
            'persistent title never reached the on-screen steady state; last sample:'
            + ` state=${JSON.stringify(last?.state)}`
            + ` screen=${JSON.stringify(last?.screen)}`,
            { cause: timeout as Error }
        );
    }

    const { state, screen } = last!;
    expect(state, `persistent title state: ${JSON.stringify(state)}`)
        .toMatchObject({ exists: true, hiddenByClass: false });
    expect(state.text).toBe(expected);
    expect(state).toMatchObject({ display: 'block', visibility: 'visible', pointerEvents: 'none', ariaHidden: 'true' });
    expect(screen.insideViewport, `on-screen: ${JSON.stringify(screen)}`).toBe(true);
    expect(screen.rect!.y + screen.rect!.height).toBeGreaterThanOrEqual(screen.viewport.height * 0.9);
    expect(screen.rect!.x).toBeLessThan(screen.viewport.width * 0.15);
}

/**
 * Expect the label hidden from the viewer: the control class AND off screen.
 *
 * The class alone is an implementation detail; the second read proves the
 * viewer cannot see it (a 0x0 box from display:none fails insideViewport).
 */
async function expectPersistentTitleHidden(page: Page, why: string) {
    let last: { state: PersistentTitleState; screen: OnScreenState } | undefined;
    await expect
        .poll(async () => {
            const [state, screen] = await Promise.all([
                persistentTitleState(page),
                onScreenState(page, PERSISTENT_TITLE)
            ]);
            last = { state, screen };
            return state.exists && state.hiddenByClass && !screen.insideViewport;
        }, { timeout: 15_000, message: why })
        .toBe(true);
    expect(last!.screen.insideViewport, `on-screen while hidden: ${JSON.stringify(last!.screen)}`).toBe(false);
}

interface ItemDetails {
    Name?: string;
    SeriesName?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    ProductionYear?: number;
}

async function fetchItem(page: Page, itemId: string): Promise<ItemDetails> {
    return page.evaluate(async (id) => {
        const api = (window as unknown as {
            ApiClient: {
                getCurrentUserId(): string;
                getItem(userId: string, itemId: string): Promise<Record<string, unknown>>;
            }
        }).ApiClient;
        return api.getItem(api.getCurrentUserId(), id) as unknown as ItemDetails;
    }, itemId);
}

async function leavePlayer(page: Page) {
    await page.goBack();
    await expect(page.locator('video')).toHaveCount(0);
    await expect
        .poll(() => onScreenState(page, PERSISTENT_TITLE), {
            timeout: 20_000,
            message: 'expected the persistent title off screen after leaving the player'
        })
        .toMatchObject({ insideViewport: false });
}

// @covers video.persistent_title.tracks_osd_visibility
// @covers video.persistent_title.episode_string_and_episode_transition
// @covers video.persistent_title.outlives_controls
test('episode label shows with the controls, hides when they auto-hide, returns with a mouse move', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();
    await login(page, config.username, config.password);
    await startPlayback(page, episodeId, config.serverId);

    const episode = await fetchItem(page, episodeId);
    const title = await readHeaderTitle(page);
    // The full wanted shape: "Series - S1:E1 - Episode" (the composer may
    // append a year; equality with the header title covers that tail).
    expect(title).toContain(episode.SeriesName || '');
    expect(title).toContain(`S${episode.ParentIndexNumber}:E${episode.IndexNumber}`);
    expect(title).toContain(episode.Name || '');

    // Controls up (a mouse move just woke them): the label is up with them.
    await wakeOsd(page);
    await waitUntilOsdShown(page);
    await expectPersistentTitleOnScreen(page, title);
    await page.screenshot({ path: test.info().outputPath('windowed-controls-shown.png') });

    // Controls auto-hide while the viewer sits still: the label must go with
    // them -- this is the 2026-09-28 owner report, windowed variant.
    await waitUntilOsdHidden(page);
    await expectPersistentTitleHidden(page, 'expected the persistent title to hide when the OSD auto-hides');
    await page.screenshot({ path: test.info().outputPath('windowed-controls-hidden.png') });

    // A mouse move brings the controls back; the label comes back with them.
    await page.mouse.move(20, 20);
    await page.mouse.move(120, 120);
    await waitUntilOsdShown(page);
    await expectPersistentTitleOnScreen(page, title);

    await leavePlayer(page);
});

// @covers video.persistent_title.tracks_osd_visibility_fullscreen
// @covers video.persistent_title.outlives_controls
test('in full screen the label hides with the controls and returns with them', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();
    await login(page, config.username, config.password);
    await startPlayback(page, episodeId, config.serverId);

    const title = await readHeaderTitle(page);

    // Enter real fullscreen through the control a viewer presses. The player
    // fullscreens the document root (Screenfull.toggle()), which is why the
    // fixed-position label stays rendered in fullscreen at all.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnFullscreen');
    await waitForFullscreen(page, true);

    // Controls up in fullscreen: the label is up with them.
    await wakeOsd(page);
    await waitUntilOsdShown(page);
    await expectPersistentTitleOnScreen(page, title);

    // The owner-reported case: controls auto-hide in fullscreen, and the
    // name must leave the screen with them, not stay over the movie.
    await waitUntilOsdHidden(page);
    await expectPersistentTitleHidden(page, 'expected the persistent title hidden in full screen once the controls hide');
    await page.screenshot({ path: test.info().outputPath('fullscreen-controls-hidden.png') });

    // A mouse move in fullscreen brings the controls back, and the label
    // comes back with them.
    await page.mouse.move(20, 20);
    await page.mouse.move(120, 120);
    await waitUntilOsdShown(page);
    await expectPersistentTitleOnScreen(page, title);

    // Leave fullscreen the way a viewer does: the same button, now the exit
    // control (a bare Escape keypress is not mapped to exiting fullscreen
    // by this player, observed 2026-09-29). Then leave the player.
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnFullscreen');
    await waitForFullscreen(page, false);
    await leavePlayer(page);
});

// @covers video.persistent_title.episode_string_and_episode_transition
// @covers video.persistent_title.transition_clears_previous_title
test('the label follows the next episode and never shows the previous episode over the new one', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();
    await login(page, config.username, config.password);
    await startPlayback(page, episodeId, config.serverId);

    const episode = await fetchItem(page, episodeId);
    const firstTitle = await readHeaderTitle(page);
    expect(firstTitle).toContain(episode.SeriesName || '');
    expect(firstTitle).toContain(`S${episode.ParentIndexNumber}:E${episode.IndexNumber}`);

    await wakeOsd(page);
    await waitUntilOsdShown(page);
    await expectPersistentTitleOnScreen(page, firstTitle);

    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnNextTrack');

    // The transition must move the label off the previous episode first
    // (constraint: never show the previous episode over the new one). The
    // header is the readable surface for the composed title: the template's
    // .osdTitle has no writer at HEAD, so the header text changing proves
    // setTitle() ran for the new episode.
    const nextTitle = await waitForHeaderTitleChange(page, firstTitle);
    expect(nextTitle).toContain(episode.SeriesName || '');
    expect(nextTitle).not.toContain(episode.Name || '');

    // Pressing the button legitimately keeps the OSD up, so the label is
    // judged with the controls visible: it must carry the NEW episode's
    // composed title and nothing of the old one.
    await expectPersistentTitleOnScreen(page, nextTitle);
    await page.screenshot({ path: test.info().outputPath('next-episode-controls-shown.png') });

    // And when the controls idle-hide again, the label goes with them.
    await waitUntilOsdHidden(page);
    await expectPersistentTitleHidden(page, 'expected the persistent title to hide when the OSD auto-hides after the episode transition');

    await leavePlayer(page);
});

// @covers video.persistent_title.gone_when_playback_ends
test('the label is gone when playback ends on its own', async ({ page, config }) => {
    test.info().annotations.push({
        type: 'note',
        description: 'Ends playback by reaching the end of the file, the natural path a viewer hits.'
    });

    await login(page, config.username, config.password);
    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate((element: HTMLVideoElement) => !element.paused && element.readyState >= 2), {
            timeout: 60_000
        })
        .toBe(true);

    // The movie keeps its composed shape (name plus year) and the same
    // controls-coupled visibility before the ending is reached.
    const movie = await fetchItem(page, config.itemId);
    const title = await readHeaderTitle(page);
    expect(title).toContain(movie.Name || '');
    expect(title).toContain(`(${movie.ProductionYear})`);
    await wakeOsd(page);
    await waitUntilOsdShown(page);
    await expectPersistentTitleOnScreen(page, title);

    await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), {
            timeout: 20_000,
            message: 'expected the playing file to report a duration'
        })
        .toBeGreaterThan(0);
    await video.evaluate((element: HTMLVideoElement) => {
        element.currentTime = Math.max(0, element.duration - 1);
    });

    // The app leaves the player when playback ends (appRouter.back()), and the
    // label must not survive it: "gone" is judged the way the viewer sees it,
    // nothing of the label left on screen.
    await expect
        .poll(() => page.url(), { timeout: 60_000, message: 'expected the app to leave the player when playback ends' })
        .not
        .toMatch(VIDEO_ROUTE);
    await expect
        .poll(() => onScreenState(page, PERSISTENT_TITLE), {
            timeout: 20_000,
            message: 'expected the persistent title off screen after playback ended'
        })
        .toMatchObject({ insideViewport: false });
});
