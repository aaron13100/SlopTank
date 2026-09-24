// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Playback reporting: reports playback start, progress and stop to the
 * Jellyfin server, and drives the periodic progress-report timer for the
 * active player.
 *
 * Uses from context: context.manager (the PlaybackManager singleton, for
 * _currentPlayer, _playQueueManager, getPlayerState, isPlaying,
 * currentMediaSource, _playNextAfterEnded), context.serverConnections
 * (the API client adapter's getApiClient), context.state (getPlayerData),
 * context.lifecycle (onPlaybackStopped, called on app close).
 *
 * The PlaybackManager facade (playbackmanager.js) creates this module and
 * passes it the shared context; the facade assigns this module's public
 * member (onAppClose) directly onto the manager singleton.
 */

import Events from '../../utils/events.ts';
import { currentTimeMs } from 'utils/clock';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';
import { enableLocalPlaylistManagement } from './playerRegistry';

/**
 * Creates the playback reporting module.
 * @param {object} context The shared PlaybackContext built by
 *   playbackmanager.js.
 * @returns {object} reportPlayback, sendProgressUpdate,
 *   startPlaybackProgressTimer, stopPlaybackProgressTimer (internal
 *   members other modules call through context.reporting), and onAppClose
 *   (public member the facade assigns onto the manager).
 */
export function createPlaybackReporting(context) {
    const { manager } = context;

    function reportPlayback(state, player, reportPlaylist, serverId, method, progressEventName) {
        if (!serverId) {
            // Not a server item
            // We can expand on this later and possibly report them
            Events.trigger(manager, 'reportplayback', [false]);
            return;
        }

        const info = Object.assign({}, state.PlayState);
        info.ItemId = state.NowPlayingItem.Id;

        if (progressEventName) {
            info.EventName = progressEventName;
        }

        if (reportPlaylist) {
            addPlaylistToPlaybackReport(info, player, serverId);
        }

        const apiClient = context.serverConnections.getApiClient(serverId);
        const reportPlaybackPromise = apiClient[method](info);
        // Notify that report has been sent
        reportPlaybackPromise.then(() => {
            Events.trigger(manager, 'reportplayback', [true]);
        });
    }

    function getPlaylistSync(player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.getPlaylistSync();
        }

        return manager._playQueueManager.getPlaylist();
    }

    function addPlaylistToPlaybackReport(info, player, serverId) {
        info.NowPlayingQueue = getPlaylistSync(player).map(function (i) {
            const itemInfo = {
                Id: i.Id,
                PlaylistItemId: i.PlaylistItemId
            };

            if (i.ServerId !== serverId) {
                itemInfo.ServerId = i.ServerId;
            }

            return itemInfo;
        });
    }

    function onPlayerProgressInterval() {
        const player = this;
        sendProgressUpdate(player, 'timeupdate');
    }

    function startPlaybackProgressTimer(player) {
        stopPlaybackProgressTimer(player);

        player._progressInterval = setInterval(onPlayerProgressInterval.bind(player), 10000);
    }

    function stopPlaybackProgressTimer(player) {
        if (player._progressInterval) {
            clearInterval(player._progressInterval);
            player._progressInterval = null;
        }
    }

    function sendProgressUpdate(player, progressEventName, reportPlaylist) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        const state = manager.getPlayerState(player);

        if (state.NowPlayingItem) {
            const serverId = state.NowPlayingItem.ServerId;

            const streamInfo = context.state.getPlayerData(player).streamInfo;

            if (streamInfo?.started && !streamInfo.ended) {
                reportPlayback(state, player, reportPlaylist, serverId, 'reportPlaybackProgress', progressEventName);
            }

            if (streamInfo?.liveStreamId
                && (currentTimeMs() - (streamInfo.lastMediaInfoQuery || 0) >= 600000)
            ) {
                getLiveStreamMediaInfo(player, streamInfo, manager.currentMediaSource(player), streamInfo.liveStreamId, serverId);
            }
        }
    }

    function getLiveStreamMediaInfo(player, streamInfo, mediaSource, liveStreamId, serverId) {
        console.debug('getLiveStreamMediaInfo');

        streamInfo.lastMediaInfoQuery = currentTimeMs();

        context.serverConnections.getApiClient(serverId).getLiveStreamMediaInfo(liveStreamId).then(function (info) {
            mediaSource.MediaStreams = info.MediaStreams;
            Events.trigger(player, 'mediastreamschange');
        }, function (error) {
            console.warn('[playbackmanager] live stream media info refresh failed:', error);
        });
    }

    function onAppClose() {
        const player = manager._currentPlayer;

        // Try to report playback stopped before the app closes
        if (player && manager.isPlaying(player)) {
            manager._playNextAfterEnded = false;
            context.lifecycle.onPlaybackStopped.call(player);
        }
    }

    return {
        reportPlayback,
        sendProgressUpdate,
        startPlaybackProgressTimer,
        stopPlaybackProgressTimer,
        onAppClose
    };
}
