// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns per-player playback state reads: the currently playing item, media
 * source, play method and session id for a player, whether a player (or the
 * active player) is currently playing, the player's reported state object
 * for server sync, duration, current position ticks, and playback start
 * time. State is tracked per player name in a private `playerStates` map.
 *
 * Uses `context.manager` (the PlaybackManager instance, for `_currentPlayer`
 * and the other public members other modules assign onto it) and
 * `context.streams.canPlayerSeek`.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context object and passes it to every collaborator factory.
 */

import { enableLocalPlaylistManagement } from './playerRegistry';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';

/**
 * Creates the playback state module.
 * @param {object} context The shared PlaybackContext built by
 *   playbackmanager.js.
 * @returns {object} currentItem, currentMediaSource, playMethod,
 *   playSessionId, isPlaying, isPlayingMediaType, isPlayingLocally,
 *   isPlayingVideo, isPlayingAudio, getPlayerState, duration,
 *   getCurrentTicks, playbackStartTime (public members); getPlayerData
 *   (internal member used by sibling modules through context.state).
 */
export function createPlaybackState(context) {
    const { manager } = context;

    const playerStates = {};

    function getNowPlayingItemForReporting(player, item, mediaSource) {
        const nowPlayingItem = Object.assign({}, item);

        if (mediaSource) {
            nowPlayingItem.RunTimeTicks = mediaSource.RunTimeTicks;
            nowPlayingItem.MediaStreams = mediaSource.MediaStreams;

            // not needed
            nowPlayingItem.MediaSources = null;
        }

        nowPlayingItem.RunTimeTicks = nowPlayingItem.RunTimeTicks || player.duration() * 10000;

        return nowPlayingItem;
    }

    function getPlayerData(player) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }
        if (!player.name) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayerName, 'player name cannot be null');
        }
        let state = playerStates[player.name];

        if (!state) {
            playerStates[player.name] = {};
            // eslint-disable-next-line sonarjs/no-dead-store
            state = playerStates[player.name];
        }

        return player;
    }

    const currentItem = function (player) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        if (player.currentItem) {
            return player.currentItem();
        }

        const data = getPlayerData(player);
        return data.streamInfo ? data.streamInfo.item : null;
    };

    const currentMediaSource = function (player) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        if (player.currentMediaSource) {
            return player.currentMediaSource();
        }

        const data = getPlayerData(player);
        return data.streamInfo ? data.streamInfo.mediaSource : null;
    };

    const playMethod = function (player) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        if (player.playMethod) {
            return player.playMethod();
        }

        const data = getPlayerData(player);
        return data.streamInfo ? data.streamInfo.playMethod : null;
    };

    const playSessionId = function (player) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        if (player.playSessionId) {
            return player.playSessionId();
        }

        const data = getPlayerData(player);
        return data.streamInfo ? data.streamInfo.playSessionId : null;
    };

    const isPlaying = function (player) {
        player = player || manager._currentPlayer;

        if (player?.isPlaying) {
            return player.isPlaying();
        }

        return player?.currentSrc() != null;
    };

    const isPlayingMediaType = function (mediaType, player) {
        player = player || manager._currentPlayer;

        if (player?.isPlaying) {
            return player.isPlaying(mediaType);
        }

        if (manager.isPlaying(player)) {
            const playerData = getPlayerData(player);

            return playerData.streamInfo.mediaType === mediaType;
        }

        return false;
    };

    const isPlayingLocally = function (mediaTypes, player) {
        player = player || manager._currentPlayer;

        if (!player?.isLocalPlayer) {
            return false;
        }

        return mediaTypes.filter(function (mediaType) {
            return manager.isPlayingMediaType(mediaType, player);
        }).length > 0;
    };

    const isPlayingVideo = function (player) {
        return manager.isPlayingMediaType('Video', player);
    };

    const isPlayingAudio = function (player) {
        return manager.isPlayingMediaType('Audio', player);
    };

    const getPlayerState = function (player, item, mediaSource) {
        player = player || manager._currentPlayer;

        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        if (!enableLocalPlaylistManagement(player) && player.getPlayerState) {
            return player.getPlayerState();
        }

        item = item || manager.currentItem(player);
        mediaSource = mediaSource || manager.currentMediaSource(player);

        const state = {
            PlayState: {}
        };

        if (player) {
            state.PlayState.VolumeLevel = player.getVolume();
            state.PlayState.IsMuted = player.isMuted();
            state.PlayState.IsPaused = player.paused();
            state.PlayState.RepeatMode = manager.getRepeatMode(player);
            state.PlayState.ShuffleMode = manager.getQueueShuffleMode(player);
            state.PlayState.MaxStreamingBitrate = manager.getMaxStreamingBitrate(player);

            state.PlayState.PositionTicks = getCurrentTicks(player);
            state.PlayState.PlaybackStartTimeTicks = manager.playbackStartTime(player);
            state.PlayState.PlaybackRate = manager.getPlaybackRate(player);

            state.PlayState.SubtitleStreamIndex = manager.getSubtitleStreamIndex(player);
            state.PlayState.SecondarySubtitleStreamIndex = manager.getSecondarySubtitleStreamIndex(player);
            state.PlayState.AudioStreamIndex = manager.getAudioStreamIndex(player);
            state.PlayState.BufferedRanges = manager.getBufferedRanges(player);

            state.PlayState.PlayMethod = manager.playMethod(player);

            if (mediaSource) {
                state.PlayState.LiveStreamId = mediaSource.LiveStreamId;
            }
            state.PlayState.PlaySessionId = manager.playSessionId(player);
            state.PlayState.PlaylistItemId = manager.getCurrentPlaylistItemId(player);
        }

        if (mediaSource) {
            state.PlayState.MediaSourceId = mediaSource.Id;

            state.NowPlayingItem = {
                RunTimeTicks: mediaSource.RunTimeTicks
            };

            state.PlayState.CanSeek = (mediaSource.RunTimeTicks || 0) > 0 || context.streams.canPlayerSeek(player);
        }

        if (item) {
            state.NowPlayingItem = getNowPlayingItemForReporting(player, item, mediaSource);
        }

        state.MediaSource = mediaSource;

        return state;
    };

    const duration = function (player) {
        player = player || manager._currentPlayer;

        if (player && !enableLocalPlaylistManagement(player) && !player.isLocalPlayer) {
            return player.duration();
        }

        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        const mediaSource = manager.currentMediaSource(player);

        if (mediaSource?.RunTimeTicks) {
            return mediaSource.RunTimeTicks;
        }

        let playerDuration = player.duration();

        if (playerDuration) {
            playerDuration *= 10000;
        }

        return playerDuration;
    };

    function getCurrentTicks(player) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        const playerData = getPlayerData(player);
        if (playerData.isChangingStream && Number.isFinite(playerData.pendingSeekTicks)) {
            return playerData.pendingSeekTicks;
        }

        let playerTime = Math.floor(10000 * (player).currentTime());

        const streamInfo = playerData.streamInfo;
        if (streamInfo) {
            playerTime += streamInfo.transcodingOffsetTicks || 0;
        }

        return playerTime;
    }

    const playbackStartTime = function (player = manager._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player) && !player.isLocalPlayer) {
            return player.playbackStartTime();
        }

        const streamInfo = getPlayerData(player).streamInfo;
        return streamInfo ? streamInfo.playbackStartTimeTicks : null;
    };

    return {
        getPlayerData,
        currentItem,
        currentMediaSource,
        playMethod,
        playSessionId,
        isPlaying,
        isPlayingMediaType,
        isPlayingLocally,
        isPlayingVideo,
        isPlayingAudio,
        getPlayerState,
        duration,
        getCurrentTicks,
        playbackStartTime
    };
}
