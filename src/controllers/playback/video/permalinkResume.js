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
import { playbackManager } from '../../../components/playback/playbackmanager';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { appRouter } from '../../../components/router/appRouter';
import { getParameterByName } from '../../../utils/url.ts';
import { permalinkStartSecondsToTicks } from '../../../components/router/permalinkId.ts';
import { readReloadResumeSnapshot } from '../../../components/playback/playbackReloadSnapshot';

/**
 * Build a resume-from-permalink controller bound to one video page instance.
 *
 * @param {object} deps
 * @param {(isPreparing: boolean) => void} deps.setPermalinkPreparing Toggle the "Preparing video" OSD state.
 * @param {(item: object) => void} deps.canonicalizeVideoRoute Rewrite the address bar to the item's canonical permalink, in place.
 * @returns {{ resume: () => (Promise<void> | undefined) }} `resume` re-enters or starts permalink-driven playback; safe to call on every `viewshow`.
 */
export function createPermalinkResume({ setPermalinkPreparing, canonicalizeVideoRoute }) {
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
        });

        return permalinkResumePromise;
    }

    return { resume };
}
