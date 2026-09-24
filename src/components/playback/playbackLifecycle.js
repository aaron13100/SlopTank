// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns playback start, stop, error and player-handoff transitions and the
 * events they fire: reporting playback start/stop to the server, starting
 * and stopping the per-player progress timer, retrying a failed stream with
 * transcoding when possible, and tearing down or swapping the active player
 * once playback stops or changes to a new item.
 *
 * Uses `context.manager` (the PlaybackManager instance, for `_currentPlayer`,
 * `_playNextAfterEnded`, `_playQueueManager` and the other public members
 * other modules assign onto it), `context.registry` (setCurrentPlayerInternal,
 * removeCurrentPlayer, getPlayer), `context.state` (getPlayerData,
 * getCurrentTicks), `context.session` (getDefaultPlayOptions, destroyPlayer),
 * `context.streams` (changeStream), `context.reporting` (reportPlayback,
 * startPlaybackProgressTimer, stopPlaybackProgressTimer), `context.events`
 * (bindStopped, unbindStopped), `context.showPlaybackError` and
 * `context.serverConnections` (getApiClient).
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context object and passes it to every collaborator factory.
 */

import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';

import Events from '../../utils/events.ts';
import { currentTimeMs } from 'utils/clock';
import { isServerItem } from './playbackMediaSource';
import { enableLocalPlaylistManagement } from './playerRegistry';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';

/**
 * Creates the playback lifecycle module.
 * @param {object} context The shared PlaybackContext built by
 *   playbackmanager.js.
 * @returns {object} onPlaybackStarted, onPlaybackStartedFromSelfManagingPlayer,
 *   onPlaybackStoppedFromSelfManagingPlayer, onPlaybackError,
 *   onPlaybackStopped, onPlaybackChanging (internal members used by sibling
 *   modules and by the facade, which registers/unregisters some of them as
 *   player event handlers through context.lifecycle).
 */
export function createPlaybackLifecycle(context) {
    const { manager } = context;

    /**
     * @param {object} streamInfo
     * @param {MediaError} errorType
     * @param {boolean} currentlyPreventsVideoStreamCopy
     * @param {boolean} currentlyPreventsAudioStreamCopy
     * @returns {boolean} Returns true if the stream should be retried by transcoding.
     */
    function enablePlaybackRetryWithTranscoding(streamInfo, errorType, currentlyPreventsVideoStreamCopy, currentlyPreventsAudioStreamCopy) {
        return streamInfo.mediaSource.SupportsTranscoding
            && (!currentlyPreventsVideoStreamCopy || !currentlyPreventsAudioStreamCopy);
    }

    function onPlaybackStarted(player, playOptions, streamInfo, mediaSource) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        context.registry.setCurrentPlayerInternal(player);

        const playerData = context.state.getPlayerData(player);

        playerData.streamInfo = streamInfo;

        streamInfo.playbackStartTimeTicks = currentTimeMs() * 10000;

        if (mediaSource) {
            playerData.audioStreamIndex = mediaSource.DefaultAudioStreamIndex;
            playerData.subtitleStreamIndex = mediaSource.DefaultSubtitleStreamIndex;
            playerData.secondarySubtitleStreamIndex = mediaSource.DefaultSecondarySubtitleStreamIndex;
        } else {
            playerData.audioStreamIndex = null;
            playerData.subtitleStreamIndex = null;
            playerData.secondarySubtitleStreamIndex = null;
        }

        manager._playNextAfterEnded = true;
        const isFirstItem = playOptions.isFirstItem;
        const fullscreen = playOptions.fullscreen;

        const state = manager.getPlayerState(player, streamInfo.item, streamInfo.mediaSource);

        context.reporting.reportPlayback(state, player, true, state.NowPlayingItem.ServerId, 'reportPlaybackStart');

        state.IsFirstItem = isFirstItem;
        state.IsFullscreen = fullscreen;
        Events.trigger(player, 'playbackstart', [state]);
        Events.trigger(manager, 'playbackstart', [player, state]);

        // only used internally as a safeguard to avoid reporting other events to the server before playback start
        streamInfo.started = true;

        context.reporting.startPlaybackProgressTimer(player);
    }

    function onPlaybackStartedFromSelfManagingPlayer(e, item, mediaSource) {
        const player = this;
        context.registry.setCurrentPlayerInternal(player);

        const playOptions = item.playOptions || context.session.getDefaultPlayOptions();
        const isFirstItem = playOptions.isFirstItem;
        const fullscreen = playOptions.fullscreen;

        playOptions.isFirstItem = false;

        const playerData = context.state.getPlayerData(player);
        playerData.streamInfo = {};

        const streamInfo = playerData.streamInfo;
        streamInfo.playbackStartTimeTicks = currentTimeMs() * 10000;

        const state = manager.getPlayerState(player, item, mediaSource);

        context.reporting.reportPlayback(state, player, true, state.NowPlayingItem.ServerId, 'reportPlaybackStart');

        state.IsFirstItem = isFirstItem;
        state.IsFullscreen = fullscreen;
        Events.trigger(player, 'playbackstart', [state]);
        Events.trigger(manager, 'playbackstart', [player, state]);

        // only used internally as a safeguard to avoid reporting other events to the server before playback start
        streamInfo.started = true;

        context.reporting.startPlaybackProgressTimer(player);
    }

    function onPlaybackStoppedFromSelfManagingPlayer(e, playerStopInfo) {
        const player = this;

        context.reporting.stopPlaybackProgressTimer(player);
        const state = manager.getPlayerState(player, playerStopInfo.item, playerStopInfo.mediaSource);

        const nextItem = playerStopInfo.nextItem;
        const nextMediaType = playerStopInfo.nextMediaType;

        const playbackStopInfo = {
            player: player,
            state: state,
            nextItem: (nextItem ? nextItem.item : null),
            nextMediaType: nextMediaType
        };

        state.NextMediaType = nextMediaType;

        const streamInfo = context.state.getPlayerData(player).streamInfo;

        // only used internally as a safeguard to avoid reporting other events to the server after playback stopped
        streamInfo.ended = true;

        if (isServerItem(playerStopInfo.item)) {
            state.PlayState.PositionTicks = (playerStopInfo.positionMs || 0) * 10000;

            context.reporting.reportPlayback(state, player, true, playerStopInfo.item.ServerId, 'reportPlaybackStopped');
        }

        state.NextItem = playbackStopInfo.nextItem;

        Events.trigger(player, 'playbackstop', [state]);
        Events.trigger(manager, 'playbackstop', [playbackStopInfo]);

        const nextItemPlayOptions = nextItem ? (nextItem.item.playOptions || context.session.getDefaultPlayOptions()) : context.session.getDefaultPlayOptions();
        const newPlayer = nextItem ? context.registry.getPlayer(nextItem.item, nextItemPlayOptions) : null;

        if (newPlayer !== player) {
            context.session.destroyPlayer(player);
            context.registry.removeCurrentPlayer(player);
        }
    }

    /**
     * Playback error handler.
     * @param {Error} e
     * @param {object} error
     * @param {object} error.streamInfo
     * @param {MediaError} error.type
     */
    function onPlaybackError(e, error) {
        const player = this;
        error = error || {};

        const errorType = error.type;

        console.warn('[playbackmanager] onPlaybackError:', e, error);

        const streamInfo = error.streamInfo || context.state.getPlayerData(player).streamInfo;

        if (streamInfo?.url) {
            const isAlreadyFallbacking = streamInfo.url.toLowerCase().includes('transcodereasons');
            const currentlyPreventsVideoStreamCopy = streamInfo.url.toLowerCase().indexOf('allowvideostreamcopy=false') !== -1;
            const currentlyPreventsAudioStreamCopy = streamInfo.url.toLowerCase().indexOf('allowaudiostreamcopy=false') !== -1;

            // Auto switch to transcoding
            if (enablePlaybackRetryWithTranscoding(streamInfo, errorType, currentlyPreventsVideoStreamCopy, currentlyPreventsAudioStreamCopy)) {
                const startTime = context.state.getCurrentTicks(player) || streamInfo.playerStartPositionTicks;
                const isRemoteSource = streamInfo.item.LocationType === 'Remote';
                // force transcoding and only allow remuxing for remote source like liveTV, but only for initial trial
                const tryVideoStreamCopy = isRemoteSource && !isAlreadyFallbacking;

                context.streams.changeStream(player, startTime, {
                    EnableDirectPlay: false,
                    EnableDirectStream: tryVideoStreamCopy,
                    AllowVideoStreamCopy: tryVideoStreamCopy,
                    AllowAudioStreamCopy: currentlyPreventsAudioStreamCopy || currentlyPreventsVideoStreamCopy ? false : null
                });

                return;
            }
        }

        Events.trigger(manager, 'playbackerror', [errorType]);

        onPlaybackStopped.call(player, e, `.${errorType}`);
    }

    function onPlaybackStopped(e, displayErrorCode) {
        const player = this;

        if (context.state.getPlayerData(player).isChangingStream) {
            return;
        }

        context.reporting.stopPlaybackProgressTimer(player);

        // User clicked stop or content ended
        const state = manager.getPlayerState(player);
        const data = context.state.getPlayerData(player);
        const streamInfo = data.streamInfo;

        const errorOccurred = displayErrorCode && typeof (displayErrorCode) === 'string';

        const nextItem = manager._playNextAfterEnded && !errorOccurred ? manager._playQueueManager.getNextItemInfo() : null;

        const nextMediaType = (nextItem ? nextItem.item.MediaType : null);

        const playbackStopInfo = {
            player: player,
            state: state,
            nextItem: (nextItem ? nextItem.item : null),
            nextMediaType: nextMediaType
        };

        state.NextMediaType = nextMediaType;

        if (streamInfo && isServerItem(streamInfo.item)) {
            if (player.supportsProgress === false && state.PlayState && !state.PlayState.PositionTicks) {
                state.PlayState.PositionTicks = streamInfo.item.RunTimeTicks;
            }

            // only used internally as a safeguard to avoid reporting other events to the server after playback stopped
            streamInfo.ended = true;

            context.reporting.reportPlayback(state, player, true, streamInfo.item.ServerId, 'reportPlaybackStopped');
        }

        state.NextItem = playbackStopInfo.nextItem;

        if (!nextItem) {
            manager._playQueueManager.reset();
        }

        Events.trigger(player, 'playbackstop', [state]);
        Events.trigger(manager, 'playbackstop', [playbackStopInfo]);

        const nextItemPlayOptions = nextItem ? (nextItem.item.playOptions || context.session.getDefaultPlayOptions()) : context.session.getDefaultPlayOptions();
        const newPlayer = nextItem ? context.registry.getPlayer(nextItem.item, nextItemPlayOptions) : null;

        if (!newPlayer) {
            data.streamInfo = null;
            context.session.destroyPlayer(player);
            context.registry.removeCurrentPlayer(player);
        }

        if (errorOccurred) {
            context.showPlaybackError('PlaybackError' + displayErrorCode);
        } else if (newPlayer) {
            const apiClient = context.serverConnections.getApiClient(nextItem.item.ServerId);

            apiClient.getCurrentUser().then(function (user) {
                if (user.Configuration.EnableNextEpisodeAutoPlay || nextMediaType !== MediaType.Video) {
                    manager.nextTrack();

                    if (newPlayer !== player) {
                        Events.trigger(manager, 'playbackstop', [{
                            player,
                            state,
                            nextItem,
                            nextMediaType
                        }]);
                    }
                }
            });
        }
    }

    function onPlaybackChanging(activePlayer, newPlayer, newItem) {
        const state = manager.getPlayerState(activePlayer);

        // The active player can have no current item when its last play
        // attempt failed before starting (e.g. a dead trailer URL);
        // reportPlayback below already no-ops without a serverId.
        const serverId = manager.currentItem(activePlayer)?.ServerId;

        // User started playing something new while existing content is playing
        let promise;

        context.reporting.stopPlaybackProgressTimer(activePlayer);
        context.events.unbindStopped(activePlayer);

        if (activePlayer === newPlayer) {
            // If we're staying with the same player, stop it
            promise = activePlayer.stop(false);
        } else {
            // If we're switching players, tear down the current one
            promise = activePlayer.stop(true);
        }

        return promise.then(function () {
            // Clear the data since we were not listening 'stopped'
            context.state.getPlayerData(activePlayer).streamInfo = null;

            context.events.bindStopped(activePlayer);

            if (enableLocalPlaylistManagement(activePlayer)) {
                context.reporting.reportPlayback(state, activePlayer, true, serverId, 'reportPlaybackStopped');
            }

            Events.trigger(manager, 'playbackstop', [{
                player: activePlayer,
                state: state,
                nextItem: newItem,
                nextMediaType: newItem.MediaType
            }]);
        });
    }

    return {
        onPlaybackStarted,
        onPlaybackStartedFromSelfManagingPlayer,
        onPlaybackStoppedFromSelfManagingPlayer,
        onPlaybackError,
        onPlaybackStopped,
        onPlaybackChanging
    };
}
