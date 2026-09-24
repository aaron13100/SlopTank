/**
 * Wires the reload-resume snapshot (see playbackReloadSnapshot.js) into the
 * app's playback lifecycle.
 *
 * A pure side-effect module with no exports, matching the existing
 * convention of components/playback/playbackorientation.js in this same
 * directory: it is imported for its effect via `loadDynamicModule` in
 * index.jsx, never for anything it returns. Kept separate from
 * playbackReloadSnapshot.js (which exports pure read/write functions and
 * does no work at import time) so the "a module that exports something
 * must not do work at top level" rule and the "this module's whole job is
 * to do work at top level" pattern never collide in the same file.
 *
 * Refreshes the snapshot on a short local interval and on every pause/
 * unpause, rather than capturing only at unload. Queue task c273's own
 * diagnosis (instrumenting `beforeunload`/`pagehide` event order directly)
 * found that by the time EITHER of those events reaches a listener
 * registered here, `playbackManager.getCurrentPlayer()` already returns
 * null: playbackmanager.js registers its own `beforeunload` listener
 * earlier in the module graph, and that listener's `onAppClose()` ->
 * `onPlaybackStopped()` synchronously tears the player down
 * (`removeCurrentPlayer`) before this module's listener, registered later
 * via a dynamic import, ever runs. A capture that depends on running at
 * that exact moment is therefore not reliable at all; continuously keeping
 * the snapshot fresh while playback is active sidesteps the ordering
 * question entirely.
 */
import { playbackManager } from './playbackmanager';
import { saveReloadResumeSnapshot } from './playbackReloadSnapshot';
import Events from '../../utils/events.ts';

/**
 * How often to refresh the local snapshot while local video plays.
 *
 * This is a synchronous storage write with no network step, so it can run
 * far more often than the server's own 10s progress-report timer; it only
 * has to beat the "resume within a few seconds" tolerance a reload needs.
 */
const REFRESH_INTERVAL_MS = 2000;

let refreshTimer = null;
let boundPlayer = null;

/**
 * Save the current position and paused state, if a local video is playing.
 */
function captureSnapshot() {
    const player = playbackManager.getCurrentPlayer();
    if (!player?.isLocalPlayer || !playbackManager.isPlayingVideo(player)) {
        return;
    }

    const item = playbackManager.currentItem(player);
    if (!item?.Id || !item?.ServerId) {
        return;
    }

    saveReloadResumeSnapshot({
        itemId: item.Id,
        serverId: item.ServerId,
        positionTicks: playbackManager.getCurrentTicks(player),
        paused: playbackManager.paused(player)
    });
}

function unbindPlayer() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
    if (boundPlayer) {
        Events.off(boundPlayer, 'pause', captureSnapshot);
        Events.off(boundPlayer, 'unpause', captureSnapshot);
        boundPlayer = null;
    }
}

/**
 * Start refreshing the snapshot for the given player, if it is local video
 * playback (the scope of this bug fix); otherwise just stop refreshing.
 *
 * @param {object} [player] The now-current player, or null/undefined when
 *   playback has stopped.
 */
function bindPlayer(player) {
    unbindPlayer();
    if (!player?.isLocalPlayer || !playbackManager.isPlayingVideo(player)) {
        return;
    }

    boundPlayer = player;
    Events.on(player, 'pause', captureSnapshot);
    Events.on(player, 'unpause', captureSnapshot);
    captureSnapshot();
    refreshTimer = setInterval(captureSnapshot, REFRESH_INTERVAL_MS);
}

Events.on(playbackManager, 'playerchange', () => bindPlayer(playbackManager.getCurrentPlayer()));
Events.on(playbackManager, 'playbackstart', (e, player) => bindPlayer(player));
Events.on(playbackManager, 'playbackstop', unbindPlayer);

// A last, best-effort capture on unload: harmless, and it catches the rare
// case where the interval above has not ticked yet. Not load-bearing (see
// the module comment): the periodic refresh and the pause/unpause listeners
// are what make the snapshot reliable.
window.addEventListener('pagehide', captureSnapshot);
window.addEventListener('beforeunload', captureSnapshot);
