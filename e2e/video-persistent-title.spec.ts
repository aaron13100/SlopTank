// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
import { expect, type Page } from '@playwright/test';

import {
    clickOsdControl,
    login,
    onScreenState,
    requireEpisodeItemId,
    test,
    VIDEO_ROUTE,
    type OnScreenState
} from './fixtures';

test.setTimeout(240_000);

/**
 * The always-visible now-playing label on the video player.
 *
 * The viewer asked (2026-09-12, t_260912_190014_995) for the title, season and
 * episode number to stay on screen the whole time, Netflix style, instead of
 * vanishing with the OSD. The label is decoration: `pointer-events: none`,
 * never focusable, `aria-hidden`, hidden while the OSD is up (the OSD already
 * shows the same title, and two titles on screen is the defect).
 */

// Scoped to the view that is on screen: a next-track transition routes
// through a fresh video view while the old one stays mounted but hidden
// (viewManager adds .hide to it), and the hidden copy's label must never be
// mistaken for the one the viewer is looking at.
const PERSISTENT_TITLE = '.page:not(.hide) .persistentVideoTitle';

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
 * after ~3 idle seconds, so no OSD waking is needed here.
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

async function persistentTitleState(page: Page): Promise<PersistentTitleState> {
    return page.evaluate((selector: string) => {
        const element = document.querySelector(selector);
        if (!element) {
            return {
                exists: false, text: '', hiddenByClass: false, display: '',
                visibility: '', pointerEvents: '', ariaHidden: null
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
            ariaHidden: element.getAttribute('aria-hidden')
        };
    }, PERSISTENT_TITLE);
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
            let node: Element | null = document.querySelector('.videoOsdBottom-maincontrols');
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

/**
 * Expect the label on screen with exactly the expected string, and placed at
 * the bottom-left where it cannot sit under the centered subtitle column.
 *
 * One atomic predicate, retried as a whole: the app can fire a stray,
 * input-free showOsd seconds after a control press (observed ~2s after a
 * next-track press), and the label hides instantly inside that dispatch
 * while the OSD controls fade over 300ms. Splitting "state looks right"
 * from "on screen" into two reads lets a re-show slip between them.
 *
 * onScreenState() rather than toBeVisible(): USER reachability (the brief's
 * placement decision), not DOM presence.
 */
async function expectPersistentTitleOnScreen(page: Page, expected: string) {
    let last: { state: PersistentTitleState; screen: OnScreenState; video: { paused: boolean; currentTime: number } } | undefined;
    try {
        await expect
            .poll(async () => {
                const [state, screen, video] = await Promise.all([
                    persistentTitleState(page),
                    onScreenState(page, PERSISTENT_TITLE),
                    page.evaluate(() => {
                        const el = document.querySelector('video');
                        return { paused: el ? el.paused : true, currentTime: el ? el.currentTime : -1 };
                    })
                ]);
                last = { state, screen, video };
                return state.exists && !state.hiddenByClass && state.text === expected
                    && state.display === 'block' && state.visibility === 'visible'
                    && state.pointerEvents === 'none' && state.ariaHidden === 'true'
                    && screen.insideViewport
                    && screen.rect !== null
                    && screen.rect.y + screen.rect.height >= screen.viewport.height * 0.9
                    && screen.rect.x < screen.viewport.width * 0.15;
            }, {
                timeout: 30_000,
                message: 'expected the persistent title on screen, bottom-left, with the composed title, once the OSD is hidden'
            })
            .toBe(true);
    } catch (timeout) {
        // The poll message alone cannot say WHY the label never showed: the
        // captured last sample distinguishes a label defect (state/screen)
        // from the app holding the OSD up or playback sitting paused.
        throw new Error( // allow-raw-error: test assertion failure detail, not production code
            'persistent title never reached the on-screen steady state; last sample:'
            + ` state=${JSON.stringify(last?.state)}`
            + ` screen=${JSON.stringify(last?.screen)}`
            + ` video=${JSON.stringify(last?.video)}`,
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

async function expectPersistentTitleHidden(page: Page, why: string) {
    await expect
        .poll(() => persistentTitleState(page), { timeout: 15_000, message: why })
        .toMatchObject({ exists: true, hiddenByClass: true });
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
            };
        }).ApiClient;
        return api.getItem(api.getCurrentUserId(), id) as unknown as ItemDetails;
    }, itemId);
}

// @covers video.persistent_title.visible_while_the_osd_is_hidden
// @covers video.persistent_title.osd_visible_suppresses_duplicate
test('movie title stays on screen after the OSD fades and hides again when the OSD returns', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await startPlayback(page, config.itemId, config.serverId);

    const item = await fetchItem(page, config.itemId);
    const title = await readHeaderTitle(page);
    // The composed string must still name the movie, year included (the
    // existing composer appends it, and the owner kept that).
    expect(title).toContain(item.Name || '');
    expect(title).toContain(`(${item.ProductionYear})`);

    await waitUntilOsdHidden(page);
    await expectPersistentTitleOnScreen(page, title);
    await page.screenshot({ path: test.info().outputPath('movie-persistent-title.png') });

    // Bringing the OSD back must take the label away: the OSD shows the same
    // title, and two of them on screen is the defect.
    await page.mouse.move(20, 20);
    await page.mouse.move(120, 120);
    await expect
        .poll(async () => page.locator('.videoOsdBottom-maincontrols').isVisible(), {
            timeout: 15_000,
            message: 'expected the OSD controls to come back after the pointer moves'
        })
        .toBe(true);
    await expectPersistentTitleHidden(page, 'expected the persistent title to hide while the OSD is up');

    await page.goBack();
    await expect(page.locator('video')).toHaveCount(0);
    await expect
        .poll(() => onScreenState(page, PERSISTENT_TITLE), {
            timeout: 20_000,
            message: 'expected the persistent title off screen after leaving the player'
        })
        .toMatchObject({ insideViewport: false });
});

// @covers video.persistent_title.episode_string_and_episode_transition
test('episode label names series, season/episode and title, and follows the next episode', async ({ page, config }) => {
    const episodeId = requireEpisodeItemId();
    await login(page, config.username, config.password);
    await startPlayback(page, episodeId, config.serverId);

    const episode = await fetchItem(page, episodeId);
    const firstTitle = await readHeaderTitle(page);
    // The full wanted shape: "Series - S1:E1 - Episode" (the composer may
    // append a year; equality with the OSD title covers that tail).
    expect(firstTitle).toContain(episode.SeriesName || '');
    expect(firstTitle).toContain(`S${episode.ParentIndexNumber}:E${episode.IndexNumber}`);
    expect(firstTitle).toContain(episode.Name || '');

    await waitUntilOsdHidden(page);
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

    // Pressing the button legitimately brings the OSD back up, so the label
    // is judged in the steady state: wait for the controls to idle-hide
    // again, the same contract the movie test asserts on first appearance.
    await waitUntilOsdHidden(page);
    await expectPersistentTitleOnScreen(page, nextTitle);
    await page.screenshot({ path: test.info().outputPath('episode-persistent-title.png') });

    await page.goBack();
    await expect(page.locator('video')).toHaveCount(0);
    await expect
        .poll(() => onScreenState(page, PERSISTENT_TITLE), {
            timeout: 20_000,
            message: 'expected the persistent title off screen after leaving the player'
        })
        .toMatchObject({ insideViewport: false });
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
        .not.toMatch(VIDEO_ROUTE);
    await expect
        .poll(() => onScreenState(page, PERSISTENT_TITLE), {
            timeout: 20_000,
            message: 'expected the persistent title off screen after playback ended'
        })
        .toMatchObject({ insideViewport: false });
});
