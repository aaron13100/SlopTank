// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import { PlaybackErrorCode } from '@jellyfin/sdk/lib/generated-client/models/playback-error-code';
import { getMediaInfoApi } from '@jellyfin/sdk/lib/utils/api/media-info-api';

import appSettings from '../../scripts/settings/appSettings';
import { AppFeature } from 'constants/appFeature';
import { MediaError } from 'types/mediaError';
import { toApi } from 'utils/jellyfin-apiclient/compat';

/**
 * Whether an item is a real server-backed item (has an Id) as opposed to a
 * synthetic item such as a channel mapping or search hint.
 *
 * @param {object} item The item to check.
 * @returns {boolean} True if the item has a server Id.
 */
export function isServerItem(item) {
    return !!item.Id;
}

/**
 * Owns negotiating a media source with the server: requesting PlaybackInfo,
 * choosing the optimal source among the ones the server offers, and opening
 * a live stream when the chosen source requires one.
 *
 * Uses from the shared context:
 * - context.isLocalItem to tell a local (offline) item from a server item.
 * - context.streamInfo.getAudioStreamUrlFromDeviceProfile and
 *   context.streamInfo.createStreamInfo to build stream URLs and the
 *   playable stream descriptor.
 * - context.streams.getSavedMaxStreamingBitrate to read the saved bitrate cap.
 * - context.registry.getPlayer to resolve the player for an item.
 * - context.serverConnections.getApiClient to get the item's api client.
 * - context.appHost.supports to check remote-video playback support.
 * - context.showPlaybackError(translationKey, ...args) to surface a
 *   PlaybackInfo error to the user.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context and stores this factory's return value as
 * context.mediaSource.
 *
 * @param {object} context The shared PlaybackContext built by
 * playbackmanager.js.
 * @returns {object} fetchPlaybackInfo, validatePlaybackInfoResult,
 * getPlaybackMediaSource, getPlaybackInfo and getPlaybackMediaSources.
 */
export function createPlaybackMediaSource(context) {
    async function fetchPlaybackInfo(player, apiClient, item, deviceProfile, mediaSourceId, liveStreamId, options) {
        if (!context.isLocalItem(item) && item.MediaType === 'Audio' && !player.useServerPlaybackInfoForAudio) {
            return {
                MediaSources: [
                    {
                        StreamUrl: context.streamInfo.getAudioStreamUrlFromDeviceProfile(item, deviceProfile, options.maxBitrate, apiClient, options.startPosition),
                        Id: item.Id,
                        MediaStreams: [],
                        RunTimeTicks: item.RunTimeTicks
                    }]
            };
        }

        if (item.PresetMediaSource) {
            return {
                MediaSources: [item.PresetMediaSource]
            };
        }

        const itemId = item.Id;

        const query = {
            UserId: apiClient.getCurrentUserId(),
            StartTimeTicks: options.startPosition || 0
        };

        const api = toApi(apiClient);
        const mediaInfoApi = getMediaInfoApi(api);

        if (options.isPlayback) {
            query.IsPlayback = true;
            query.AutoOpenLiveStream = true;
        } else {
            query.IsPlayback = false;
            query.AutoOpenLiveStream = false;
        }

        if (options.audioStreamIndex != null) {
            query.AudioStreamIndex = options.audioStreamIndex;
        }
        if (options.subtitleStreamIndex != null) {
            query.SubtitleStreamIndex = options.subtitleStreamIndex;
        }
        if (options.secondarySubtitleStreamIndex != null) {
            query.SecondarySubtitleStreamIndex = options.secondarySubtitleStreamIndex;
        }
        if (options.enableDirectPlay != null) {
            query.EnableDirectPlay = options.enableDirectPlay;
        }
        if (options.enableDirectStream != null) {
            query.EnableDirectStream = options.enableDirectStream;
        }
        if (options.allowVideoStreamCopy != null) {
            query.AllowVideoStreamCopy = options.allowVideoStreamCopy;
        }
        if (options.allowAudioStreamCopy != null) {
            query.AllowAudioStreamCopy = options.allowAudioStreamCopy;
        }
        if (mediaSourceId) {
            query.MediaSourceId = mediaSourceId;
        }
        if (liveStreamId) {
            query.LiveStreamId = liveStreamId;
        }
        if (options.maxBitrate) {
            query.MaxStreamingBitrate = options.maxBitrate;
        }
        if (player.enableMediaProbe && !player.enableMediaProbe(item)) {
            query.EnableMediaProbe = false;
        }

        // lastly, enforce player overrides for special situations
        if (query.EnableDirectStream !== false
            && player.supportsPlayMethod && !player.supportsPlayMethod('DirectStream', item)
        ) {
            query.EnableDirectStream = false;
        }

        if (player.getDirectPlayProtocols) {
            query.DirectPlayProtocols = player.getDirectPlayProtocols();
        }

        query.AlwaysBurnInSubtitleWhenTranscoding = appSettings.alwaysBurnInSubtitleWhenTranscoding();

        query.DeviceProfile = deviceProfile;

        const res = await mediaInfoApi.getPostedPlaybackInfo({ itemId: itemId, playbackInfoDto: query });
        return res.data;
    }

    function getOptimalMediaSource(apiClient, item, versions) {
        const promises = versions.map(function (v) {
            return supportsDirectPlay(apiClient, item, v);
        });

        if (!promises.length) {
            return Promise.reject();
        }

        return Promise.all(promises).then(function (results) {
            for (let i = 0, length = versions.length; i < length; i++) {
                versions[i].enableDirectPlay = results[i] || false;
            }
            let optimalVersion = versions.filter(function (v) {
                return v.enableDirectPlay;
            })[0];

            if (!optimalVersion) {
                optimalVersion = versions.filter(function (v) {
                    return v.SupportsDirectStream;
                })[0];
            }

            optimalVersion = optimalVersion || versions.filter(function (s) {
                return s.SupportsTranscoding;
            })[0];

            return optimalVersion || versions[0];
        });
    }

    function getLiveStream(player, apiClient, item, playSessionId, deviceProfile, mediaSource, options) {
        const postData = {
            DeviceProfile: deviceProfile,
            OpenToken: mediaSource.OpenToken
        };

        const query = {
            UserId: apiClient.getCurrentUserId(),
            StartTimeTicks: options.startPosition || 0,
            ItemId: item.Id,
            PlaySessionId: playSessionId
        };

        if (options.maxBitrate) {
            query.MaxStreamingBitrate = options.maxBitrate;
        }
        if (options.audioStreamIndex != null) {
            query.AudioStreamIndex = options.audioStreamIndex;
        }
        if (options.subtitleStreamIndex != null) {
            query.SubtitleStreamIndex = options.subtitleStreamIndex;
        }

        // lastly, enforce player overrides for special situations
        if (query.EnableDirectStream !== false
            && player.supportsPlayMethod && !player.supportsPlayMethod('DirectStream', item)
        ) {
            query.EnableDirectStream = false;
        }

        return apiClient.ajax({
            url: apiClient.getUrl('LiveStreams/Open', query),
            type: 'POST',
            data: JSON.stringify(postData),
            contentType: 'application/json',
            dataType: 'json'

        });
    }

    function isHostReachable(mediaSource, apiClient) {
        if (mediaSource.IsRemote) {
            return Promise.resolve(true);
        }

        return apiClient.getEndpointInfo().then(function (endpointInfo) {
            if (endpointInfo.IsInNetwork) {
                if (!endpointInfo.IsLocal) {
                    const path = (mediaSource.Path || '').toLowerCase();
                    if (path.indexOf('localhost') !== -1 || path.indexOf('127.0.0.1') !== -1) {
                        // This will only work if the app is on the same machine as the server
                        return Promise.resolve(false);
                    }
                }

                return Promise.resolve(true);
            }

            // media source is in network, but connection is out of network
            return Promise.resolve(false);
        });
    }

    function supportsDirectPlay(apiClient, item, mediaSource) {
        // folder rip hacks due to not yet being supported by the stream building engine
        const isFolderRip = mediaSource.VideoType === 'BluRay' || mediaSource.VideoType === 'Dvd' || mediaSource.VideoType === 'HdDvd';

        if (mediaSource.SupportsDirectPlay || isFolderRip) {
            if (mediaSource.IsRemote && !context.appHost.supports(AppFeature.RemoteVideo)) {
                return Promise.resolve(false);
            }

            if (mediaSource.Protocol === 'Http' && !mediaSource.RequiredHttpHeaders.length) {
                // If this is the only way it can be played, then allow it
                if (!mediaSource.SupportsDirectStream && !mediaSource.SupportsTranscoding) {
                    return Promise.resolve(true);
                } else {
                    return isHostReachable(mediaSource, apiClient);
                }
            }
        }

        return Promise.resolve(false);
    }

    /**
     * @param {import('@jellyfin/sdk/lib/generated-client/index.js').PlaybackInfoResponse} result
     * @returns {boolean}
     */
    function validatePlaybackInfoResult(result) {
        if (result.ErrorCode) {
            // NOTE: To avoid needing to retranslate the "NoCompatibleStream" message,
            // we need to keep the key in the same format.
            const errMessage = result.ErrorCode === PlaybackErrorCode.NoCompatibleStream ?
                'PlaybackErrorNoCompatibleStream' : `PlaybackError.${result.ErrorCode}`;
            context.showPlaybackError(errMessage);
            return false;
        }

        return true;
    }

    function getPlaybackInfo(item, options) {
        options = options || {};
        const startPosition = options.startPositionTicks || 0;
        const mediaType = options.mediaType || item.MediaType;
        const player = context.registry.getPlayer(item, options);
        const apiClient = context.serverConnections.getApiClient(item.ServerId);

        // Call this just to ensure the value is recorded, it is needed with getSavedMaxStreamingBitrate
        return apiClient.getEndpointInfo().then(function () {
            const maxBitrate = context.streams.getSavedMaxStreamingBitrate(context.serverConnections.getApiClient(item.ServerId), mediaType);

            return player.getDeviceProfile(item).then(function (deviceProfile) {
                const mediaOptions = {
                    maxBitrate,
                    startPosition,
                    isPlayback: null,
                    audioStreamIndex: options.audioStreamIndex,
                    subtitleStreamIndex: options.subtitleStreamIndex,
                    startIndex: null,
                    enableDirectPlay: null,
                    enableDirectStream: null,
                    allowVideoStreamCopy: null,
                    allowAudioStreamCopy: null
                };

                return getPlaybackMediaSource(player, apiClient, deviceProfile, item, options.mediaSourceId, mediaOptions).then(function (mediaSource) {
                    return context.streamInfo.createStreamInfo(apiClient, item.MediaType, item, mediaSource, startPosition, player);
                });
            });
        });
    }

    function getPlaybackMediaSources(item, options) {
        options = options || {};
        const startPosition = options.startPositionTicks || 0;
        const mediaType = options.mediaType || item.MediaType;
        // TODO: Remove the true forceLocalPlayer hack
        const player = context.registry.getPlayer(item, options, true);
        const apiClient = context.serverConnections.getApiClient(item.ServerId);

        // Call this just to ensure the value is recorded, it is needed with getSavedMaxStreamingBitrate
        return apiClient.getEndpointInfo().then(function () {
            const maxBitrate = context.streams.getSavedMaxStreamingBitrate(context.serverConnections.getApiClient(item.ServerId), mediaType);

            return player.getDeviceProfile(item).then(function (deviceProfile) {
                const mediaOptions = {
                    maxBitrate,
                    startPosition,
                    isPlayback: true,
                    audioStreamIndex: null,
                    subtitleStreamIndex: null,
                    enableDirectPlay: null,
                    enableDirectStream: null,
                    allowVideoStreamCopy: null,
                    allowAudioStreamCopy: null
                };

                return fetchPlaybackInfo(player, apiClient, item, deviceProfile, null, null, mediaOptions).then(function (playbackInfoResult) {
                    return playbackInfoResult.MediaSources;
                });
            });
        });
    }

    function getPlaybackMediaSource(player, apiClient, deviceProfile, item, mediaSourceId, options) {
        options.isPlayback = true;

        return fetchPlaybackInfo(player, apiClient, item, deviceProfile, mediaSourceId, null, options).then(function (playbackInfoResult) {
            if (validatePlaybackInfoResult(playbackInfoResult)) {
                return getOptimalMediaSource(apiClient, item, playbackInfoResult.MediaSources).then(function (mediaSource) {
                    if (mediaSource) {
                        if (mediaSource.RequiresOpening && !mediaSource.LiveStreamId) {
                            options.audioStreamIndex = null;
                            options.subtitleStreamIndex = null;

                            return getLiveStream(player, apiClient, item, playbackInfoResult.PlaySessionId, deviceProfile, mediaSource, options).then(function (openLiveStreamResult) {
                                return supportsDirectPlay(apiClient, item, openLiveStreamResult.MediaSource).then(function (result) {
                                    openLiveStreamResult.MediaSource.enableDirectPlay = result;
                                    return openLiveStreamResult.MediaSource;
                                });
                            });
                        } else {
                            if (item.AlbumId != null) {
                                return apiClient.getItem(apiClient.getCurrentUserId(), item.AlbumId).then(function(result) {
                                    mediaSource.albumNormalizationGain = result.NormalizationGain;
                                    return mediaSource;
                                });
                            }
                            return mediaSource;
                        }
                    } else {
                        context.showPlaybackError(`PlaybackError.${MediaError.NO_MEDIA_ERROR}`);
                        return Promise.reject();
                    }
                });
            } else {
                return Promise.reject();
            }
        });
    }

    return {
        fetchPlaybackInfo,
        validatePlaybackInfoResult,
        getPlaybackMediaSource,
        getPlaybackInfo,
        getPlaybackMediaSources
    };
}
