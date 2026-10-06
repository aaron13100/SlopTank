// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * Up Next prompt timing (c189).
 *
 * The prompt must fire at the server-computed episode content-end boundary
 * (terminal Outro start, else MaxResumePct of runtime) when one is available:
 * that boundary is authoritative, so the fixed 30/35/40-second timing and the
 * 10-minute floor do not apply in that branch, while the 20-seconds-remaining
 * sanity guard does. When no boundary is available (legacy server, fetch
 * failure) the prompt keeps exactly the historical fixed-timing behavior.
 *
 * Driven through createUpNextControl with plain adapter object literals in
 * the style of src/components/playback/skipsegment.test.ts; userSettings and
 * the event utility run for real. The upnext dialog module is genuinely
 * loaded (statically preloaded below, the same collect-time pattern this
 * repo uses for heavy real modules), so a fired prompt is observable as the
 * 'upnext' visible-menu state; the injected playback adapter keeps
 * nextItem pending so the test never waits on (or constructs) the dialog
 * itself, which is a separate component with its own server dependency.
 *
 * The preload happens at module-collect time, outside every per-test
 * budget: a cold transform of the dialog's import graph costs tens of
 * seconds on this contended box, which would blow any in-test ceiling once
 * the whole directory runs in parallel workers. With it cached, the
 * dynamic import inside showComingUpNext resolves in microtasks, so the
 * in-test poll budgets below are generous, load-independent ceilings.
 */
import { describe, expect, it } from 'vitest';

import { TICKS_PER_MINUTE, TICKS_PER_SECOND } from 'constants/time';
import * as userSettings from 'scripts/settings/userSettings';
// Preload the real dialog module so the dynamic import in showComingUpNext
// resolves from cache; see the module comment above.
import '../../../components/upnextdialog/upnextdialog';
import { createUpNextControl } from './upNextControl';

const RUNTIME_TICKS = 45 * TICKS_PER_MINUTE;
/** Poll ceiling; the cached import settles in milliseconds, not seconds. */
const SETTLED_BUDGET_MS = 5_000;
const POLL_INTERVAL_MS = 100;

/**
 * A next item whose arrival nothing in this file waits on: showComingUpNext
 * only consumes it after the prompt state is already observable, and the
 * real UpNextDialog construction needs a live server connection.
 */
function pendingNextItem() {
    return new Promise(() => {});
}

function createUpNext({ overlayEnabled = true } = {}) {
    const nextItem = { Id: 'next-episode', Type: 'Episode', Name: 'Next Episode' };
    const visibleMenu = { current: null as string | null };
    let nextItemRequests = 0;
    const playback = {
        duration: () => RUNTIME_TICKS,
        getNextItem: () => nextItem,
        nextItem: () => {
            nextItemRequests += 1;
            return pendingNextItem();
        }
    };
    const osd = {
        getVisibleMenu: () => visibleMenu.current,
        setVisibleMenu: (menu: string | null) => {
            visibleMenu.current = menu;
        }
    };
    const view = {
        querySelector: () => null
    };
    userSettings.enableNextVideoInfoOverlay(overlayEnabled);
    const upNext = createUpNextControl({ view, playback, osd });
    return {
        upNext,
        promptShown: () => visibleMenu.current === 'upnext',
        nextItemRequests: () => nextItemRequests
    };
}

/** Polls until check() holds or the budget runs out, whichever is first. */
async function settleUntil(check: () => boolean, budgetMs: number) {
    const deadline = Date.now() + budgetMs;
    while (!check() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

const episode = { Id: 'current-episode', Type: 'Episode' };
const player = {};

describe('showComingUpNextIfNeeded content-end boundary', () => {
    it('prompts at the content-end boundary even with 100 seconds remaining', async () => {
        const boundary = RUNTIME_TICKS - 100 * TICKS_PER_SECOND;
        const { upNext, promptShown } = createUpNext();

        upNext.showComingUpNextIfNeeded(player, episode, boundary, RUNTIME_TICKS, boundary);
        await settleUntil(promptShown, SETTLED_BUDGET_MS);

        expect(promptShown()).toBe(true);
    }, 30_000);

    it('does not prompt just under the content-end boundary', async () => {
        const boundary = RUNTIME_TICKS - 100 * TICKS_PER_SECOND;
        const { upNext, promptShown, nextItemRequests } = createUpNext();

        upNext.showComingUpNextIfNeeded(player, episode, boundary - 1, RUNTIME_TICKS, boundary);
        await settleUntil(promptShown, SETTLED_BUDGET_MS);

        expect(promptShown()).toBe(false);
        expect(nextItemRequests()).toBe(0);
    }, 15_000);

    it('ignores the 10-minute floor when a boundary is present', async () => {
        const shortRuntime = 5 * TICKS_PER_MINUTE;
        const boundary = shortRuntime - 100 * TICKS_PER_SECOND;
        const { upNext, promptShown } = createUpNext();

        upNext.showComingUpNextIfNeeded(player, episode, boundary, shortRuntime, boundary);
        await settleUntil(promptShown, SETTLED_BUDGET_MS);

        expect(promptShown()).toBe(true);
    }, 15_000);

    it('does not prompt at the boundary when less than 20 seconds remain', async () => {
        const boundary = RUNTIME_TICKS - 15 * TICKS_PER_SECOND;
        const { upNext, promptShown, nextItemRequests } = createUpNext();

        upNext.showComingUpNextIfNeeded(player, episode, boundary, RUNTIME_TICKS, boundary);
        await settleUntil(promptShown, SETTLED_BUDGET_MS);

        expect(promptShown()).toBe(false);
        expect(nextItemRequests()).toBe(0);
    }, 15_000);

    it('does not prompt past the boundary when the next-video overlay is disabled', async () => {
        const boundary = RUNTIME_TICKS - 100 * TICKS_PER_SECOND;
        const { upNext, promptShown, nextItemRequests } = createUpNext({ overlayEnabled: false });

        upNext.showComingUpNextIfNeeded(player, episode, boundary, RUNTIME_TICKS, boundary);
        await settleUntil(promptShown, SETTLED_BUDGET_MS);

        expect(promptShown()).toBe(false);
        expect(nextItemRequests()).toBe(0);
    }, 15_000);
});

describe('showComingUpNextIfNeeded legacy fixed timing', () => {
    it('keeps the 35-second window for a 45-minute episode with no boundary', async () => {
        const withoutBoundary = createUpNext();

        withoutBoundary.upNext.showComingUpNextIfNeeded(
            player, episode, RUNTIME_TICKS - 100 * TICKS_PER_SECOND, RUNTIME_TICKS, undefined);
        await settleUntil(withoutBoundary.promptShown, SETTLED_BUDGET_MS);
        expect(withoutBoundary.promptShown()).toBe(false);
        expect(withoutBoundary.nextItemRequests()).toBe(0);

        const insideWindow = createUpNext();
        insideWindow.upNext.showComingUpNextIfNeeded(
            player, episode, RUNTIME_TICKS - 34 * TICKS_PER_SECOND, RUNTIME_TICKS, undefined);
        await settleUntil(insideWindow.promptShown, SETTLED_BUDGET_MS);
        expect(insideWindow.promptShown()).toBe(true);
    }, 30_000);
});
