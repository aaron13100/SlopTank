/**
 * Resume-from-permalink playback: opening (or reloading) a video page URL
 * that carries `?id=&serverId=` re-fetches the item and resumes playback at
 * the right position and paused/playing state.
 *
 * Extracted from video/index.js (queue task c273, t_260922_231151_281) so
 * the position-source priority this fix added -- an explicit permalink
 * `t=` seconds param, then a same-tab reload snapshot
 * (../../../components/playback/playbackReloadSnapshot.js), then server
 * `UserData` -- has a home that is not itself the 1000-line file the
 * original bug's fix could not grow. Mirrors this directory's existing
 * collaborator modules (TransportControl.js, VolumeControl.js,
 * trickplayDiscovery.ts): a real, independently meaningful unit, not a
 * `*.helpers`/`*.utils` split of video/index.js.
 */
import { playbackManager as defaultPlaybackManager } from '../../../components/playback/playbackmanager';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { appRouter } from '../../../components/router/appRouter';
import { getParameterByName } from '../../../utils/url.ts';
import { permalinkStartSecondsToTicks } from '../../../components/router/permalinkId.ts';
import { readReloadResumeSnapshot } from '../../../components/playback/playbackReloadSnapshot';

/**
 * Module-scoped (not per-createPermalinkResume-instance) in-flight guard,
 * keyed by `${serverId}:${id}`.
 *
 * Continuation of queue task c273 (t_260922_231151_281): video/index.js's
 * own comment documents that a hard reload can dispatch `viewshow` on two
 * separate controller instantiations for the same navigation (the router
 * restoring a cached view, then loading a fresh one). Each instantiation
 * calls createPermalinkResume() fresh, which gives each its own
 * `permalinkResumePromise` closure variable, so a per-instance guard alone
 * lets both instances race past `playbackManager.getCurrentPlayer()`: that
 * check stays falsy until deep into the first dispatch's own async chain
 * (item fetch, media source/bitrate detection, then the underlying
 * player.play() resolving) -- see onPlaybackStarted() in playbackmanager.js,
 * which is the only place that sets it, and which runs after player.play()
 * already succeeded. A second dispatch landing in that window saw a null
 * current player and started ITS OWN independent playbackManager.play()
 * call for the same item, racing two HtmlVideoPlayer.play() invocations
 * against the shared singleton's private fields (#mediaElement,
 * #initialMediaPrepared): whichever finishes createMediaElement() last wins
 * that state, and the other's <video> element is orphaned with its own
 * canplay/playing handlers silently no-op'ing on the
 * `elem !== this.#mediaElement` guard in prepareInitialMedia() -- so its
 * resume seek is never applied, no error is ever logged, and if that
 * orphaned element is the one left on screen, playback sits at position 0
 * with no application-level trace at all. This module is a singleton for
 * the lifetime of one page load (exactly the scope of "a single real
 * reload"), so a guard living here, rather than in the per-instance
 * closure, is what actually spans the race. See
 * permalinkResume.test.js for the reproduction.
 */
let activeResumeKey = null;
let activeResumePromise = null;

/**
 * Build a resume-from-permalink controller bound to one video page instance.
 *
 * @param {object} deps
 * @param {(isPreparing: boolean) => void} deps.setPermalinkPreparing Toggle the "Preparing video" OSD state.
 * @param {(item: object) => void} deps.canonicalizeVideoRoute Rewrite the address bar to the item's canonical permalink, in place.
 * @param {object} [deps.playbackManager] Injectable seam for tests (see
 *   permalinkResume.test.js); production always gets the real singleton.
 * @returns {{ resume: () => (Promise<void> | undefined) }} `resume` re-enters or starts permalink-driven playback; safe to call on every `viewshow`.
 */
export function createPermalinkResume({ setPermalinkPreparing, canonicalizeVideoRoute, playbackManager = defaultPlaybackManager }) {
    let permalinkResumePromise;

    function resume() {
        if (playbackManager.getCurrentPlayer() || permalinkResumePromise) {
            return permalinkResumePromise;
        }

        const id = getParameterByName('id');
        const serverId = getParameterByName('serverId');
        const isPermalinkPlayback = getParameterByName('permalinkPlayback') === '1';

        if (!id || !serverId) {
            return;
        }

        // See the module comment above: a second controller instantiation
        // for the SAME item, still in flight, must join that attempt rather
        // than start a duplicate playbackManager.play().
        const resumeKey = `${serverId}:${id}`;
        if (activeResumeKey === resumeKey) {
            return activeResumePromise;
        }

        // A permalink watch link (/web/w/<id>?t=<seconds>, see
        // permalinkId.permalinkStartSecondsToTicks) resolves to this same
        // /web/video route with a 't' query param appended; it always wins
        // over any saved resume position when present and valid. Next is a
        // same-tab reload snapshot: it captures the exact position and
        // paused state a network progress report can miss at unload (see
        // playbackReloadSnapshot.js). Server UserData is the last resort --
        // a fresh visit, cross-device Continue Watching, or an
        // expired/mismatched snapshot. The snapshot read is non-destructive:
        // this app can dispatch `viewshow` (and so this resume path) more
        // than once for a single real reload, and every dispatch must see
        // the same answer -- see readReloadResumeSnapshot's own comment.
        const requestedStartTicks = permalinkStartSecondsToTicks(getParameterByName('t'));
        const reloadSnapshot = requestedStartTicks === null ?
            readReloadResumeSnapshot({ itemId: id, serverId }) :
            null;

        const apiClient = ServerConnections.getApiClient(serverId);
        setPermalinkPreparing(true);

        permalinkResumePromise = apiClient.getItem(apiClient.getCurrentUserId(), id).then((item) => {
            canonicalizeVideoRoute(item);

            if (playbackManager.getCurrentPlayer() || !playbackManager.canPlay(item)) {
                setPermalinkPreparing(false);
                return;
            }

            return playbackManager.play({
                items: [item],
                startPositionTicks: requestedStartTicks ?? reloadSnapshot?.positionTicks ?? (item.UserData?.PlaybackPositionTicks || 0),
                fullscreen: true,
                alreadyOnVideoOsd: true,
                skipAutomaticBitrateDetection: isPermalinkPlayback
            });
        }).then(() => {
            // The first play() can be interrupted while the resume seek is
            // applied. Retry automatically once preparation has completed so
            // a direct link never depends on a click made during startup --
            // unless the reload snapshot says the item was paused, which is
            // the only place that intent lives (UserData has no such flag).
            const player = playbackManager.getCurrentPlayer();
            if (!player) {
                return;
            }
            if (reloadSnapshot?.paused) {
                return playbackManager.pause(player);
            }
            if (playbackManager.paused(player)) {
                return playbackManager.unpause(player);
            }
        }).catch((error) => {
            setPermalinkPreparing(false);
            console.error('failed to resume item from permalink: ', error);
            appRouter.goHome();
        }).finally(() => {
            permalinkResumePromise = null;
            if (activeResumeKey === resumeKey) {
                activeResumeKey = null;
                activeResumePromise = null;
            }
        });

        activeResumeKey = resumeKey;
        activeResumePromise = permalinkResumePromise;

        return permalinkResumePromise;
    }

    return { resume };
}
