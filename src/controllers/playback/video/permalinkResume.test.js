// SlopTank modification notice: added by SlopTank on 2026-09-24.
import { afterEach, describe, expect, it } from 'vitest';

import { ServerConnections } from 'lib/jellyfin-apiclient';

import { setRouteSearchOverride } from '../../../utils/url.ts';
import { saveReloadResumeSnapshot } from '../../../components/playback/playbackReloadSnapshot';
import { createPermalinkResume } from './permalinkResume';

/**
 * Regression coverage for queue task c273 (t_260922_231151_281), continuation
 * fault-injection pass: does a hard reload's documented double `viewshow`
 * dispatch (video/index.js's own comment: "A hard reload can dispatch
 * viewshow twice while the router falls back from restoring this legacy
 * view to loading it") ever start playback twice for the same item?
 *
 * Each dispatch instantiates its own controller and so its own
 * createPermalinkResume() closure, with its own `permalinkResumePromise`.
 * Before this fix, the only guard shared across both was
 * `playbackManager.getCurrentPlayer()`, which stays null until deep into
 * the first dispatch's own async chain (item fetch, then
 * playbackManager.play() resolving the underlying player.play() before
 * onPlaybackStarted() ever calls setCurrentPlayerInternal()). A second
 * dispatch landing in that window saw a null current player and proceeded
 * independently, racing a second playbackManager.play() call for the same
 * item against the first.
 *
 * The Jellyfin server is unavailable under vitest, so the one genuinely
 * external boundary (item fetch) is faked through the real
 * ServerConnections.addApiClient() production seam (same pattern as
 * playbackmanager.test.js's createOfflineApiClient()), not a module mock.
 * playbackManager itself is injected via createPermalinkResume's own `deps`
 * seam with a real-but-test-configured implementation of the small surface
 * this module actually calls, rather than exercising the full singleton
 * (already covered end to end in playbackmanager.test.js) -- driving that
 * singleton's real play() here would require a real HTMLMediaElement.play(),
 * which jsdom does not implement.
 */
const SERVER_ID = 'permalink-resume-test-server';

function deferred() {
    let resolve;
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

/** A real-but-test-configured implementation of the playbackManager surface this module calls. */
function fakePlaybackManager({ playResult } = {}) {
    const calls = { play: [], pause: 0, unpause: 0 };
    let currentPlayer = null;
    return {
        calls,
        setCurrentPlayer(player) {
            currentPlayer = player;
        },
        getCurrentPlayer: () => currentPlayer,
        canPlay: () => true,
        play: (options) => {
            calls.play.push(options);
            return playResult ?? new Promise(() => undefined);
        },
        pause: () => {
            calls.pause += 1;
        },
        unpause: () => {
            calls.unpause += 1;
        },
        paused: () => false
    };
}

/** Offline apiClient implementing only the surface permalinkResume.js touches. */
function offlineApiClient(itemFetchPromise) {
    return {
        serverAddress: () => 'https://jellyfin.test.invalid',
        serverInfo: () => ({ Id: SERVER_ID }),
        serverId: () => SERVER_ID,
        getCurrentUserId: () => 'user-1',
        getItem: () => itemFetchPromise
    };
}

function newResumeInstance(playbackManager) {
    return createPermalinkResume({
        setPermalinkPreparing: () => undefined,
        canonicalizeVideoRoute: () => undefined,
        playbackManager
    });
}

describe('permalinkResume: double viewshow dispatch on a hard reload', () => {
    afterEach(() => {
        setRouteSearchOverride(null);
        sessionStorage.clear();
    });

    // @covers video.reload.double_dispatch.single_playback_attempt
    it('does not start a second playback attempt when a second controller instance resumes before the first registers a current player', async () => {
        const itemId = 'item-double-dispatch';
        setRouteSearchOverride(`?id=${itemId}&serverId=${SERVER_ID}`);
        saveReloadResumeSnapshot({ itemId, serverId: SERVER_ID, positionTicks: 200_000_000 /* 20s */, paused: false });

        const itemFetch = deferred();
        ServerConnections.addApiClient(offlineApiClient(itemFetch.promise));

        // Never resolves within this test: onPlaybackStarted() (what
        // finally sets getCurrentPlayer() in the real playbackManager) lives
        // inside this promise's resolution in the real player.play() chain,
        // so leaving it pending is exactly the async window the second
        // dispatch races into.
        const playbackManager = fakePlaybackManager();

        const firstDispatch = newResumeInstance(playbackManager);
        const secondDispatch = newResumeInstance(playbackManager);

        firstDispatch.resume();
        secondDispatch.resume();

        itemFetch.resolve({ Id: itemId, ServerId: SERVER_ID, UserData: {} });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(playbackManager.calls.play).toHaveLength(1);
        expect(playbackManager.calls.play[0].startPositionTicks).toBe(200_000_000);
    });

    // @covers video.reload.double_dispatch.joins_in_flight_attempt
    it('a second dispatch for a different item is not blocked by an in-flight resume for another item', async () => {
        const firstItemId = 'item-a';
        const secondItemId = 'item-b';

        const firstFetch = deferred();
        ServerConnections.addApiClient(offlineApiClient(firstFetch.promise));

        const playbackManagerA = fakePlaybackManager();
        setRouteSearchOverride(`?id=${firstItemId}&serverId=${SERVER_ID}`);
        newResumeInstance(playbackManagerA).resume();

        // A second, unrelated resume (different item) must still proceed
        // independently; the guard is keyed by item, not global.
        const secondFetch = deferred();
        ServerConnections.addApiClient(offlineApiClient(secondFetch.promise));
        const playbackManagerB = fakePlaybackManager();
        setRouteSearchOverride(`?id=${secondItemId}&serverId=${SERVER_ID}`);
        newResumeInstance(playbackManagerB).resume();

        secondFetch.resolve({ Id: secondItemId, ServerId: SERVER_ID, UserData: {} });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(playbackManagerB.calls.play).toHaveLength(1);

        // Clean up the still-pending first fetch so it does not leak
        // module-scoped guard state into a later test using the same item id.
        firstFetch.resolve({ Id: firstItemId, ServerId: SERVER_ID, UserData: {} });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });

    // @covers video.reload.double_dispatch.releases_guard_after_completion
    it('allows a fresh resume for the same item once the prior attempt has finished', async () => {
        const itemId = 'item-sequential';
        setRouteSearchOverride(`?id=${itemId}&serverId=${SERVER_ID}`);

        const firstFetch = deferred();
        ServerConnections.addApiClient(offlineApiClient(firstFetch.promise));
        const playbackManager = fakePlaybackManager({ playResult: Promise.resolve() });

        await newResumeInstance(playbackManager).resume();
        firstFetch.resolve({ Id: itemId, ServerId: SERVER_ID, UserData: {} });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // First attempt fully settled (its .finally() ran) and released the
        // guard; a later, genuinely new resume (e.g. Continue Watching
        // clicked again) must not be permanently blocked.
        const secondFetch = deferred();
        ServerConnections.addApiClient(offlineApiClient(secondFetch.promise));
        newResumeInstance(playbackManager).resume();
        secondFetch.resolve({ Id: itemId, ServerId: SERVER_ID, UserData: {} });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(playbackManager.calls.play).toHaveLength(2);
    });
});
