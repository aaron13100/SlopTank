import { createMemoryHistory } from 'history';
import { afterEach, describe, expect, it } from 'vitest';

import { AppRouter } from './appRouter';
import { clearRememberedPermalinkAliases } from './permalinkSession';
import { trackVideoOsdMount } from '../playback/videoOsdPresence';

/**
 * These tests drive AppRouter over a real history implementation (the same
 * `history` package whose History interface the router history wrapper
 * implements), injected via AppRouter's constructor seam. The assertions are
 * about the shape of the back stack: the video-permalink feature must never
 * let episode transitions pile up player entries.
 */

function createHarness(initialEntries) {
    const memoryHistory = createMemoryHistory({ initialEntries });
    const appRouter = new AppRouter(memoryHistory);
    return { memoryHistory, appRouter };
}

/**
 * appRouter defers the history mutation with setTimeout(0) and resolves its
 * promise on the next 'viewshow' event (normally fired by the viewManager
 * once the route's view mounts). Flush both here.
 */
async function settleNavigation(promise) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new CustomEvent('viewshow'));
    await promise;
}

function fullPath(memoryHistory) {
    return memoryHistory.location.pathname + memoryHistory.location.search;
}

describe('appRouter video OSD navigation', () => {
    afterEach(() => {
        clearRememberedPermalinkAliases();
        // Settle any trailing setTimeout(0) navigation before the next test.
        return new Promise((resolve) => setTimeout(resolve, 0));
    });

    // @covers video.next_episode_back.enter_player.pushes_history_entry
    it('pushes a history entry when entering the player from another page', async () => {
        const { memoryHistory, appRouter } = createHarness(['/web/details?id=show1&serverId=s1']);

        await settleNavigation(appRouter.showVideoOsd({ Id: 'ep1', ServerId: 's1' }));
        expect(fullPath(memoryHistory)).toBe('/web/video?id=ep1&serverId=s1');
        expect(memoryHistory.index).toBe(1);

        // Back exits the player toward the page that launched it.
        memoryHistory.back();
        expect(fullPath(memoryHistory)).toBe('/web/details?id=show1&serverId=s1');
    });

    // @covers video.next_episode_back.next_episode.replaces_history_entry
    it('replaces the player entry on an in-player item change so Back exits the player', async () => {
        const { memoryHistory, appRouter } = createHarness([
            '/web/details?id=show1&serverId=s1',
            '/web/video?id=ep1&serverId=s1'
        ]);

        // "While the OSD is already showing" is now asked of the mounted view
        // rather than of the address (the player has two addresses once its
        // link canonicalizes), so the precondition has to be declared through
        // the same seam the mounted view uses. Without this the harness holds
        // a player URL that nothing is mounted on, which is the state of a
        // fresh tab, and a push is the correct answer to it.
        const releaseOsd = trackVideoOsdMount();
        try {
            // Next episode starts while the OSD is already showing.
            await settleNavigation(appRouter.showVideoOsd({ Id: 'ep2', ServerId: 's1' }));
            expect(fullPath(memoryHistory)).toBe('/web/video?id=ep2&serverId=s1');
            expect(memoryHistory.index).toBe(1);
        } finally {
            releaseOsd();
        }

        // Back must leave the player, not step to the previous episode.
        memoryHistory.back();
        expect(fullPath(memoryHistory)).toBe('/web/details?id=show1&serverId=s1');
    });

    // @covers video.next_episode_back.same_item_reshow.no_op
    it('does not navigate at all when the same item is shown again', async () => {
        const { memoryHistory, appRouter } = createHarness([
            '/web/details?id=show1&serverId=s1',
            '/web/video?id=ep1&serverId=s1'
        ]);

        await appRouter.showVideoOsd({ Id: 'ep1', ServerId: 's1' });
        expect(fullPath(memoryHistory)).toBe('/web/video?id=ep1&serverId=s1');
        expect(memoryHistory.index).toBe(1);
    });

    // @covers video.permalink.fresh_tab.no_history_falls_back_home
    it('back() routes home instead of hanging when there is no session history behind the page', async () => {
        const { memoryHistory, appRouter } = createHarness(['/web/video?id=ep1&serverId=s1']);

        // A permalink opened in a fresh tab: the session history holds only
        // this page, so a pop would be a silent no-op and the router's
        // pending promise would never settle.
        expect(window.history.length).toBe(1);

        await settleNavigation(appRouter.back());
        expect(fullPath(memoryHistory)).toBe('/web/home');
    });
});

describe('appRouter never mints a permalink itself', () => {
    // Regression guard for docs/internal/permalink-url-design.md section 5: a
    // permalink may only be the alias the server persisted evidence for, and
    // getRouteUrl is synchronous, so it can never be the thing that chooses
    // one. Share and copy do their own `POST /Items/{id}/Permalink` first
    // (itemContextMenu.js); an item DTO that happens to carry an external
    // provider id must not shortcut that.
    it('getRouteUrl returns the GUID route even when the item carries a mintable external id', () => {
        const { appRouter } = createHarness(['/web/home']);
        const item = { Id: 'item1', ServerId: 's1', Type: 'Movie', ProviderIds: { Imdb: 'tt0062622' } };

        expect(appRouter.getRouteUrl(item)).toBe('/web/details?id=item1&serverId=s1');
        expect(appRouter.getRouteUrl(item, { permalink: true })).toBe('/web/details?id=item1&serverId=s1');
    });
});

describe('appRouter canonical library navigation', () => {
    it.each([
        [ 'movies', '/movies' ],
        [ 'tvshows', '/tv' ],
        [ 'music', '/music' ]
    ])('keeps the %s collection id out of the URL', (collectionType, expected) => {
        const { appRouter } = createHarness(['/web/home']);
        const view = {
            Id: 'd4f1aeb3b8343a7c04f02bd596d038f3',
            Name: 'Library',
            Type: 'CollectionFolder',
            CollectionType: collectionType,
            ServerId: 's1'
        };

        expect(appRouter.getRouteUrl(view, { context: collectionType })).toBe(expected);
        expect(appRouter.getRouteUrl(view, { context: collectionType, section: 'latest' }))
            .toBe(`${expected}?tab=1`);
    });
});

describe('appRouter canonicalizeAddressBar preserves the entry it re-spells', () => {
    // A canonicalization re-spells the history entry already on screen, so
    // everything that entry was carrying is still true afterwards. It used to
    // hand history.replace() a state object built from scratch, which silently
    // destroyed every key another feature had put there.
    //
    // dialogHelper is the load-bearing victim: it records open dialogs in
    // `state.dialogs` and closes any dialog whose hash disappears from a
    // history update. So a permalink canonicalization landing while a menu was
    // open ripped that menu out of the DOM mid-click. Observed against the live
    // server 2026-09-03: the "More" menu on an item page vanished under the
    // pointer whenever the alias was minted after the menu opened, which is the
    // normal ordering whenever the mint round trip is slow.
    //
    // @covers video.permalink.canonicalization_preserves_open_dialog
    it('merges its state over the current entry rather than replacing it', () => {
        const { memoryHistory, appRouter } = createHarness(['/web/details?id=item1&serverId=s1']);
        memoryHistory.replace('/web/details?id=item1&serverId=s1', { dialogs: [ 'dlg-1' ] });

        const rewritten = appRouter.canonicalizeAddressBar('/sk-3n5ragpyv3ys689v2m9bty98fd', {
            canonicalizedFrom: '/web/details'
        });

        expect(rewritten).toBe(true);
        expect(memoryHistory.location.state).toMatchObject({
            dialogs: [ 'dlg-1' ],
            canonicalizedFrom: '/web/details'
        });
    });

    it('lets the canonicalization win when a key collides', () => {
        const { memoryHistory, appRouter } = createHarness(['/web/details?id=item1&serverId=s1']);
        memoryHistory.replace('/web/details?id=item1&serverId=s1', {
            dialogs: [ 'dlg-1' ],
            canonicalizedFrom: '/web/stale'
        });

        appRouter.canonicalizeAddressBar('/sk-3n5ragpyv3ys689v2m9bty98fd', {
            canonicalizedFrom: '/web/details'
        });

        expect(memoryHistory.location.state.canonicalizedFrom).toBe('/web/details');
        expect(memoryHistory.location.state.dialogs).toEqual([ 'dlg-1' ]);
    });

    it('carries the existing state through when the caller adds nothing', () => {
        const { memoryHistory, appRouter } = createHarness(['/web/details?id=item1&serverId=s1']);
        memoryHistory.replace('/web/details?id=item1&serverId=s1', { dialogs: [ 'dlg-1' ] });

        appRouter.canonicalizeAddressBar('/sk-3n5ragpyv3ys689v2m9bty98fd');

        expect(memoryHistory.location.state).toMatchObject({ dialogs: [ 'dlg-1' ] });
    });
});
