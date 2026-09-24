// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns the stream a player is fed: bitrate caps (saved, automatic-detection,
 * user-set), seeking, and re-requesting a stream mid-playback when the
 * bitrate, audio/subtitle track, or position changes in a way the player
 * cannot handle natively.
 *
 * Uses context.manager (the PlaybackManager instance, for _currentPlayer and
 * the other public members other modules assign onto it),
 * context.state.getPlayerData / getCurrentTicks, context.session
 * (getDefaultPlayOptions, cancelPlayback), context.mediaSource
 * (fetchPlaybackInfo, validatePlaybackInfoResult), context.streamInfo
 * (createStreamInfo), context.reporting.sendProgressUpdate,
 * context.lifecycle.onPlaybackError, context.serverConnections,
 * context.showPlaybackError, and context.isLocalItem.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context object and passes it to every collaborator factory.
 */

import appSettings from '../../scripts/settings/appSettings';
import { MediaError } from 'types/mediaError';
import { getMediaError } from 'utils/mediaError';
import { isServerItem } from './playbackMediaSource';
import { enableLocalPlaylistManagement } from './playerRegistry';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';

/**
 * Creates the playback stream controller module.
 * @param {object} context The shared PlaybackContext built by
 *   playbackmanager.js.
 * @returns {object} getMaxStreamingBitrate, enableAutomaticBitrateDetection,
 *   setMaxStreamingBitrate, seek, seekRelative (public members);
 *   getSavedMaxStreamingBitrate, detectBitrate, canPlayerSeek, changeStream
 *   (internal members used by sibling modules through context.streams).
 */
export function createPlaybackStreamController(context) {
    const { manager } = context;

    function clearPendingStreamChange(playerData, streamChangeId) {
        if (playerData.streamChangeId === streamChangeId) {
            playerData.isChangingStream = false;
            playerData.pendingSeekTicks = null;
        }
    }

    function changeStreamToUrl(apiClient, player, playSessionId, streamInfo, streamChangeId) {
        const playerData = context.state.getPlayerData(player);

        playerData.isChangingStream = true;

        if (playerData.streamInfo && playSessionId) {
            return apiClient.stopActiveEncodings(playSessionId).then(function () {
                if (playerData.streamChangeId !== streamChangeId) {
                    return;
                }

                // Stop the first transcoding afterwards because the player may still send requests to the original url
                const afterSetSrc = function () {
                    apiClient.stopActiveEncodings(playSessionId);
                };
                return setSrcIntoPlayer(apiClient, player, streamInfo, streamChangeId).then(afterSetSrc, afterSetSrc);
            });
        } else {
            return setSrcIntoPlayer(apiClient, player, streamInfo, streamChangeId);
        }
    }

    function setSrcIntoPlayer(apiClient, player, streamInfo, streamChangeId) {
        const playerData = context.state.getPlayerData(player);

        playerData.streamInfo = streamInfo;

        return player.play(streamInfo).then(function () {
            if (playerData.streamChangeId !== streamChangeId) {
                return;
            }

            clearPendingStreamChange(playerData, streamChangeId);
            streamInfo.started = true;
            streamInfo.ended = false;

            context.reporting.sendProgressUpdate(player, 'timeupdate');
        }, function (e) {
            if (playerData.streamChangeId !== streamChangeId) {
                return;
            }

            clearPendingStreamChange(playerData, streamChangeId);

            context.lifecycle.onPlaybackError.call(player, e, {
                type: getMediaError(e),
                streamInfo
            });
        });
    }

    function getSavedMaxStreamingBitrate(apiClient, mediaType) {
        if (!apiClient) {
            // This should hopefully never happen
            apiClient = context.serverConnections.currentApiClient();
        }

        const endpointInfo = apiClient.getSavedEndpointInfo() || {};

        return appSettings.maxStreamingBitrate(endpointInfo.IsInNetwork, mediaType);
    }

    function detectBitrate(apiClient, item, mediaType) {
        // FIXME: This is gnarly, but don't want to change too much here in a bugfix
        return Promise.resolve()
            .then(() => {
                if (!isServerItem(item) || context.isLocalItem(item)) {
                    return Promise.reject(new Error('skip bitrate detection'));
                }

                return apiClient.getEndpointInfo()
                    .then((endpointInfo) => {
                        if ((mediaType === 'Video' || mediaType === 'Audio') && appSettings.enableAutomaticBitrateDetection(endpointInfo.IsInNetwork, mediaType)) {
                            return apiClient.detectBitrate().then((bitrate) => {
                                appSettings.maxStreamingBitrate(endpointInfo.IsInNetwork, mediaType, bitrate);
                                return bitrate;
                            });
                        }

                        return Promise.reject(new Error('skip bitrate detection'));
                    });
            })
            .catch(() => getSavedMaxStreamingBitrate(apiClient, mediaType));
    }

    // Returns true if the player can seek using native client-side seeking functions
    function canPlayerSeek(player) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        const playerData = context.state.getPlayerData(player);

        const currentSrc = (playerData.streamInfo.url || '').toLowerCase();

        if (currentSrc.indexOf('.m3u8') !== -1) {
            return true;
        }

        if (player.seekable) {
            return player.seekable();
        }

        const isPlayMethodTranscode = manager.playMethod(player) === 'Transcode';

        if (isPlayMethodTranscode) {
            return false;
        }

        return player.duration();
    }

    function changeStream(player, ticks, params) {
        if (canPlayerSeek(player) && params == null) {
            player.currentTime(parseInt(ticks / 10000, 10));
            return;
        }

        params = params || {};
        const playerData = context.state.getPlayerData(player);
        const streamChangeId = (playerData.streamChangeId || 0) + 1;
        playerData.streamChangeId = streamChangeId;
        playerData.pendingSeekTicks = ticks;
        playerData.isChangingStream = true;

        const liveStreamId = playerData.streamInfo.liveStreamId;
        const lastMediaInfoQuery = playerData.streamInfo.lastMediaInfoQuery;

        const playSessionId = manager.playSessionId(player);

        const currentItem = manager.currentItem(player);

        return player.getDeviceProfile(currentItem, {
            isRetry: params.EnableDirectPlay === false
        }).then(function (deviceProfile) {
            const audioStreamIndex = params.AudioStreamIndex == null ? context.state.getPlayerData(player).audioStreamIndex : params.AudioStreamIndex;
            const subtitleStreamIndex = params.SubtitleStreamIndex == null ? context.state.getPlayerData(player).subtitleStreamIndex : params.SubtitleStreamIndex;
            const secondarySubtitleStreamIndex = params.SecondarySubtitleStreamIndex == null ? context.state.getPlayerData(player).secondarySubtitleStreamIndex : params.SecondarySubtitleStreamIndex;

            let currentMediaSource = manager.currentMediaSource(player);
            const apiClient = context.serverConnections.getApiClient(currentItem.ServerId);

            if (ticks) {
                ticks = parseInt(ticks, 10);
            }

            const maxBitrate = params.MaxStreamingBitrate || manager.getMaxStreamingBitrate(player);

            const currentPlayOptions = currentItem.playOptions || context.session.getDefaultPlayOptions();

            const options = {
                maxBitrate,
                startPosition: ticks,
                isPlayback: true,
                audioStreamIndex,
                subtitleStreamIndex,
                enableDirectPlay: params.EnableDirectPlay,
                enableDirectStream: params.EnableDirectStream,
                allowVideoStreamCopy: params.AllowVideoStreamCopy,
                allowAudioStreamCopy: params.AllowAudioStreamCopy
            };

            return context.mediaSource.fetchPlaybackInfo(player, apiClient, currentItem, deviceProfile, currentMediaSource.Id, liveStreamId, options).then(function (result) {
                if (playerData.streamChangeId !== streamChangeId) {
                    return;
                }

                if (context.mediaSource.validatePlaybackInfoResult(result)) {
                    currentMediaSource = result.MediaSources[0];

                    const streamInfo = context.streamInfo.createStreamInfo(apiClient, currentItem.MediaType, currentItem, currentMediaSource, ticks, player);
                    streamInfo.fullscreen = currentPlayOptions.fullscreen;
                    streamInfo.alreadyOnVideoOsd = currentPlayOptions.alreadyOnVideoOsd;
                    streamInfo.lastMediaInfoQuery = lastMediaInfoQuery;
                    streamInfo.resetSubtitleOffset = false;

                    if (!streamInfo.url) {
                        clearPendingStreamChange(playerData, streamChangeId);
                        context.session.cancelPlayback();
                        context.showPlaybackError(`PlaybackError.${MediaError.NO_MEDIA_ERROR}`);
                        return;
                    }

                    context.state.getPlayerData(player).subtitleStreamIndex = subtitleStreamIndex;
                    context.state.getPlayerData(player).secondarySubtitleStreamIndex = secondarySubtitleStreamIndex;
                    context.state.getPlayerData(player).audioStreamIndex = audioStreamIndex;
                    context.state.getPlayerData(player).maxStreamingBitrate = maxBitrate;

                    return changeStreamToUrl(apiClient, player, playSessionId, streamInfo, streamChangeId);
                }

                clearPendingStreamChange(playerData, streamChangeId);
            });
        }).catch(function (error) {
            clearPendingStreamChange(playerData, streamChangeId);
            console.error('[playbackmanager] failed to change stream:', error);
        });
    }

    const getMaxStreamingBitrate = function (player) {
        player = player || manager._currentPlayer;
        if (player?.getMaxStreamingBitrate) {
            return player.getMaxStreamingBitrate();
        }

        const playerData = context.state.getPlayerData(player);

        if (playerData.maxStreamingBitrate) {
            return playerData.maxStreamingBitrate;
        }

        const mediaType = playerData.streamInfo ? playerData.streamInfo.mediaType : null;
        const currentItem = manager.currentItem(player);

        const apiClient = currentItem ? context.serverConnections.getApiClient(currentItem.ServerId) : context.serverConnections.currentApiClient();
        return getSavedMaxStreamingBitrate(apiClient, mediaType);
    };

    const enableAutomaticBitrateDetection = function (player) {
        player = player || manager._currentPlayer;
        if (player?.enableAutomaticBitrateDetection) {
            return player.enableAutomaticBitrateDetection();
        }

        const playerData = context.state.getPlayerData(player);
        const mediaType = playerData.streamInfo ? playerData.streamInfo.mediaType : null;
        const currentItem = manager.currentItem(player);

        const apiClient = currentItem ? context.serverConnections.getApiClient(currentItem.ServerId) : context.serverConnections.currentApiClient();
        const endpointInfo = apiClient.getSavedEndpointInfo() || {};

        return appSettings.enableAutomaticBitrateDetection(endpointInfo.IsInNetwork, mediaType);
    };

    const setMaxStreamingBitrate = function (options, player) {
        player = player || manager._currentPlayer;
        if (player?.setMaxStreamingBitrate) {
            return player.setMaxStreamingBitrate(options);
        }

        const apiClient = context.serverConnections.getApiClient(manager.currentItem(player).ServerId);

        apiClient.getEndpointInfo().then(function (endpointInfo) {
            const playerData = context.state.getPlayerData(player);
            const mediaType = playerData.streamInfo ? playerData.streamInfo.mediaType : null;

            let promise;
            if (options.enableAutomaticBitrateDetection) {
                appSettings.enableAutomaticBitrateDetection(endpointInfo.IsInNetwork, mediaType, true);
                promise = apiClient.detectBitrate(true);
            } else {
                appSettings.enableAutomaticBitrateDetection(endpointInfo.IsInNetwork, mediaType, false);
                promise = Promise.resolve(options.maxBitrate);
            }

            promise.then(function (bitrate) {
                appSettings.maxStreamingBitrate(endpointInfo.IsInNetwork, mediaType, bitrate);

                changeStream(player, context.state.getCurrentTicks(player), {
                    MaxStreamingBitrate: bitrate
                });
            });
        });
    };

    const seek = function (ticks, player) {
        ticks = Math.max(0, ticks);

        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.seek(ticks);
        }

        changeStream(player, ticks);
    };

    const seekRelative = function (offsetTicks, player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player) && player.seekRelative) {
            return player.seekRelative(ticks);
        }

        const ticks = context.state.getCurrentTicks(player) + offsetTicks;
        return manager.seek(ticks, player);
    };

    return {
        getSavedMaxStreamingBitrate,
        detectBitrate,
        canPlayerSeek,
        changeStream,
        getMaxStreamingBitrate,
        enableAutomaticBitrateDetection,
        setMaxStreamingBitrate,
        seek,
        seekRelative
    };
}
