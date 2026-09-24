// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import Events from '../../utils/events.ts';
import Screenfull from 'screenfull';

import { enableLocalPlaylistManagement } from './playerRegistry';

/**
 * Owns subscribing each registered media player's events to the playback
 * lifecycle transitions (start/stop/error) and to server progress reports.
 *
 * Uses from the shared context:
 * - context.registry.registerPlayer(player) to add a newly initialized
 *   player to the registry's sorted player list.
 * - context.lifecycle.onPlaybackError, context.lifecycle.onPlaybackStopped,
 *   context.lifecycle.onPlaybackStartedFromSelfManagingPlayer and
 *   context.lifecycle.onPlaybackStoppedFromSelfManagingPlayer as the
 *   lifecycle event handlers bound to (and unbound from) each player.
 * - context.reporting.sendProgressUpdate(player, eventName, ...) to report
 *   time, pause, volume and playlist-edit events to the server.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context and stores this factory's return value as
 * context.events.
 *
 * @param {object} context The shared PlaybackContext built by
 * playbackmanager.js.
 * @returns {object} initMediaPlayer, bindStopped and unbindStopped.
 */
export function createPlayerEvents(context) {
    function bindToFullscreenChange(player) {
        if (Screenfull.isEnabled) {
            Screenfull.on('change', function () {
                Events.trigger(player, 'fullscreenchange');
            });
        } else {
            // iOS Safari
            document.addEventListener('webkitfullscreenchange', function () {
                Events.trigger(player, 'fullscreenchange');
            }, false);
        }
    }

    function bindStopped(player) {
        if (enableLocalPlaylistManagement(player)) {
            Events.off(player, 'stopped', context.lifecycle.onPlaybackStopped);
            Events.on(player, 'stopped', context.lifecycle.onPlaybackStopped);
        }
    }

    function onPlaybackTimeUpdate() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'timeupdate');
    }

    function onPlaybackPause() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'pause');
    }

    function onPlaybackUnpause() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'unpause');
    }

    function onPlaybackVolumeChange() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'volumechange');
    }

    function onRepeatModeChange() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'repeatmodechange');
    }

    function onShuffleQueueModeChange() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'shufflequeuemodechange');
    }

    function onPlaylistItemMove() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'playlistitemmove', true);
    }

    function onPlaylistItemRemove() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'playlistitemremove', true);
    }

    function onPlaylistItemAdd() {
        const player = this;
        context.reporting.sendProgressUpdate(player, 'playlistitemadd', true);
    }

    function unbindStopped(player) {
        Events.off(player, 'stopped', context.lifecycle.onPlaybackStopped);
    }

    function initLegacyVolumeMethods(player) {
        player.getVolume = function () {
            return player.volume();
        };
        player.setVolume = function (val) {
            return player.volume(val);
        };
    }

    function initMediaPlayer(player) {
        context.registry.registerPlayer(player);

        if (player.isLocalPlayer !== false) {
            player.isLocalPlayer = true;
        }

        player.currentState = {};

        if (!player.getVolume || !player.setVolume) {
            initLegacyVolumeMethods(player);
        }

        if (enableLocalPlaylistManagement(player)) {
            Events.on(player, 'error', context.lifecycle.onPlaybackError);
            Events.on(player, 'timeupdate', onPlaybackTimeUpdate);
            Events.on(player, 'pause', onPlaybackPause);
            Events.on(player, 'unpause', onPlaybackUnpause);
            Events.on(player, 'volumechange', onPlaybackVolumeChange);
            Events.on(player, 'repeatmodechange', onRepeatModeChange);
            Events.on(player, 'shufflequeuemodechange', onShuffleQueueModeChange);
            Events.on(player, 'playlistitemmove', onPlaylistItemMove);
            Events.on(player, 'playlistitemremove', onPlaylistItemRemove);
            Events.on(player, 'playlistitemadd', onPlaylistItemAdd);
        } else if (player.isLocalPlayer) {
            Events.on(player, 'itemstarted', context.lifecycle.onPlaybackStartedFromSelfManagingPlayer);
            Events.on(player, 'itemstopped', context.lifecycle.onPlaybackStoppedFromSelfManagingPlayer);
            Events.on(player, 'timeupdate', onPlaybackTimeUpdate);
            Events.on(player, 'pause', onPlaybackPause);
            Events.on(player, 'unpause', onPlaybackUnpause);
            Events.on(player, 'volumechange', onPlaybackVolumeChange);
            Events.on(player, 'repeatmodechange', onRepeatModeChange);
            Events.on(player, 'shufflequeuemodechange', onShuffleQueueModeChange);
            Events.on(player, 'playlistitemmove', onPlaylistItemMove);
            Events.on(player, 'playlistitemremove', onPlaylistItemRemove);
            Events.on(player, 'playlistitemadd', onPlaylistItemAdd);
        }

        if (player.isLocalPlayer) {
            bindToFullscreenChange(player);
        }
        bindStopped(player);
    }

    return {
        initMediaPlayer,
        bindStopped,
        unbindStopped
    };
}
