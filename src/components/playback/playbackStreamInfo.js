// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Builds the playable stream descriptor and stream URLs for an item.
 *
 * Owns turning a media source (already negotiated with the server by
 * context.mediaSource) into playback-ready output: MIME type lookup, stream
 * query-string parsing, direct-play audio stream URLs, and the final
 * StreamInfo object (url, mimeType, playMethod, text tracks, ...) that a
 * player is fed.
 *
 * Uses from context: appHost (supports), isLocalItem.
 *
 * The PlaybackManager facade (playbackmanager.js) creates this module and
 * passes it the shared context built for every collaborator factory.
 *
 * @module playbackStreamInfo
 */

import { AppFeature } from 'constants/appFeature';
import { getItemBackdropImageUrl } from '../../utils/jellyfin-apiclient/backdropImage';
import { currentTimeMs } from 'utils/clock';

/**
 * Creates the playback stream info operations.
 * @param {object} context The shared PlaybackContext built by playbackmanager.js.
 * @returns {object} createStreamInfoFromUrlItem, getAudioStreamUrlFromDeviceProfile,
 *   setStreamUrls, createStreamInfo.
 */
export function createPlaybackStreamInfo(context) {
    let startingPlaySession = currentTimeMs();

    function getMimeType(type, container) {
        container = (container || '').toLowerCase();

        if (type === 'audio') {
            if (container === 'opus') {
                return 'audio/ogg';
            }
            if (container === 'webma') {
                return 'audio/webm';
            }
            if (container === 'm4a') {
                return 'audio/mp4';
            }
        } else if (type === 'video') {
            if (container === 'mkv') {
                return 'video/x-matroska';
            }
            if (container === 'm4v') {
                return 'video/mp4';
            }
            if (container === 'mov') {
                return 'video/quicktime';
            }
            if (container === 'mpg') {
                return 'video/mpeg';
            }
            if (container === 'flv') {
                return 'video/x-flv';
            }
        }

        return type + '/' + container;
    }

    function getParam(name, url) {
        // eslint-disable-next-line sonarjs/single-char-in-character-classes
        name = name.replace(/[[]/, '\\[').replace(/[\]]/, '\\]');
        const regexS = '[\\?&]' + name + '=([^&#]*)';
        const regex = new RegExp(regexS, 'i');

        const results = regex.exec(url);
        if (results == null) {
            return '';
        } else {
            return decodeURIComponent(results[1].replace(/\+/g, ' '));
        }
    }

    function getAudioMaxValues(deviceProfile) {
        // TODO - this could vary per codec and should be done on the server using the entire profile
        let maxAudioSampleRate = null;
        let maxAudioBitDepth = null;
        let maxAudioBitrate = null;

        deviceProfile.CodecProfiles.forEach(codecProfile => {
            if (codecProfile.Type === 'Audio') {
                (codecProfile.Conditions || []).forEach(condition => {
                    if (condition.Condition === 'LessThanEqual' && condition.Property === 'AudioBitDepth') {
                        maxAudioBitDepth = condition.Value;
                    } else if (condition.Condition === 'LessThanEqual' && condition.Property === 'AudioSampleRate') {
                        maxAudioSampleRate = condition.Value;
                    } else if (condition.Condition === 'LessThanEqual' && condition.Property === 'AudioBitrate') {
                        maxAudioBitrate = condition.Value;
                    }
                });
            }
        });

        return {
            maxAudioSampleRate: maxAudioSampleRate,
            maxAudioBitDepth: maxAudioBitDepth,
            maxAudioBitrate: maxAudioBitrate
        };
    }

    function getAudioStreamUrl(item, transcodingProfile, directPlayContainers, apiClient, startPosition, maxValues) {
        const url = 'Audio/' + item.Id + '/universal';

        startingPlaySession++;
        return apiClient.getUrl(url, {
            UserId: apiClient.getCurrentUserId(),
            DeviceId: apiClient.deviceId(),
            MaxStreamingBitrate: maxValues.maxAudioBitrate || maxValues.maxBitrate,
            Container: directPlayContainers,
            TranscodingContainer: transcodingProfile.Container || null,
            TranscodingProtocol: transcodingProfile.Protocol || null,
            AudioCodec: transcodingProfile.AudioCodec,
            MaxAudioSampleRate: maxValues.maxAudioSampleRate,
            MaxAudioBitDepth: maxValues.maxAudioBitDepth,
            ApiKey: apiClient.accessToken(),
            PlaySessionId: startingPlaySession,
            StartTimeTicks: startPosition || 0,
            EnableRedirection: true,
            EnableRemoteMedia: context.appHost.supports(AppFeature.RemoteAudio),
            EnableAudioVbrEncoding: transcodingProfile.EnableAudioVbrEncoding
        });
    }

    function getStreamUrls(items, deviceProfile, maxBitrate, apiClient, startPosition) {
        const audioTranscodingProfile = deviceProfile.TranscodingProfiles.filter(function (p) {
            return p.Type === 'Audio' && p.Context === 'Streaming';
        })[0];

        let audioDirectPlayContainers = '';

        deviceProfile.DirectPlayProfiles.forEach(p => {
            if (p.Type === 'Audio') {
                if (audioDirectPlayContainers) {
                    audioDirectPlayContainers += ',' + p.Container;
                } else {
                    audioDirectPlayContainers = p.Container;
                }

                if (p.AudioCodec) {
                    audioDirectPlayContainers += '|' + p.AudioCodec;
                }
            }
        });

        const maxValues = getAudioMaxValues(deviceProfile);

        const streamUrls = [];

        for (let i = 0, length = items.length; i < length; i++) {
            const item = items[i];
            let streamUrl;

            if (item.MediaType === 'Audio' && !context.isLocalItem(item)) {
                streamUrl = getAudioStreamUrl(item, audioTranscodingProfile, audioDirectPlayContainers, apiClient, startPosition, { maxBitrate, ...maxValues });
            }

            streamUrls.push(streamUrl || '');

            if (i === 0) {
                startPosition = 0;
            }
        }

        return Promise.resolve(streamUrls);
    }

    function getTextTracks(apiClient, item, mediaSource) {
        const subtitleStreams = mediaSource.MediaStreams.filter(function (s) {
            return s.Type === 'Subtitle';
        });

        const textStreams = subtitleStreams.filter(function (s) {
            return s.DeliveryMethod === 'External';
        });

        const tracks = [];

        for (let i = 0, length = textStreams.length; i < length; i++) {
            const textStream = textStreams[i];
            let textStreamUrl;

            if (context.isLocalItem(item)) {
                textStreamUrl = textStream.Path;
            } else {
                textStreamUrl = !textStream.IsExternalUrl ? apiClient.getUrl(textStream.DeliveryUrl) : textStream.DeliveryUrl;
            }

            tracks.push({
                url: textStreamUrl,
                language: (textStream.Language || 'und'),
                isDefault: textStream.Index === mediaSource.DefaultSubtitleStreamIndex,
                index: textStream.Index,
                format: textStream.Codec
            });
        }

        return tracks;
    }

    function createStreamInfoFromUrlItem(item) {
        // Check item.Path for games
        return {
            url: item.Url || item.Path,
            playMethod: 'DirectPlay',
            item: item,
            textTracks: [],
            mediaType: item.MediaType
        };
    }

    function getAudioStreamUrlFromDeviceProfile(item, deviceProfile, maxBitrate, apiClient, startPosition) {
        const transcodingProfile = deviceProfile.TranscodingProfiles.filter(function (p) {
            return p.Type === 'Audio' && p.Context === 'Streaming';
        })[0];

        let directPlayContainers = '';

        deviceProfile.DirectPlayProfiles.forEach(p => {
            if (p.Type === 'Audio') {
                if (directPlayContainers) {
                    directPlayContainers += ',' + p.Container;
                } else {
                    directPlayContainers = p.Container;
                }

                if (p.AudioCodec) {
                    directPlayContainers += '|' + p.AudioCodec;
                }
            }
        });

        const maxValues = getAudioMaxValues(deviceProfile);

        return getAudioStreamUrl(item, transcodingProfile, directPlayContainers, apiClient, startPosition, { maxBitrate, ...maxValues });
    }

    function setStreamUrls(items, deviceProfile, maxBitrate, apiClient, startPosition) {
        return getStreamUrls(items, deviceProfile, maxBitrate, apiClient, startPosition).then(function (streamUrls) {
            for (let i = 0, length = items.length; i < length; i++) {
                const item = items[i];
                const streamUrl = streamUrls[i];

                if (streamUrl) {
                    item.PresetMediaSource = {
                        StreamUrl: streamUrl,
                        Id: item.Id,
                        MediaStreams: [],
                        RunTimeTicks: item.RunTimeTicks
                    };
                }
            }
        });
    }

    function createStreamInfo(apiClient, type, item, mediaSource, startPosition, player) {
        let mediaUrl;
        let contentType;
        let transcodingOffsetTicks = 0;
        const liveStreamId = mediaSource.LiveStreamId;

        let playMethod = 'Transcode';

        const mediaSourceContainer = (mediaSource.Container || '').toLowerCase();
        let directOptions;

        if (mediaSource.MediaStreams && player.useFullSubtitleUrls) {
            mediaSource.MediaStreams.forEach(stream => {
                if (stream.DeliveryUrl?.startsWith('/')) {
                    stream.DeliveryUrl = apiClient.getUrl(stream.DeliveryUrl);
                }
            });
        }

        if (type === 'Video' || type === 'Audio') {
            contentType = getMimeType(type.toLowerCase(), mediaSourceContainer);

            if (mediaSource.enableDirectPlay) {
                mediaUrl = mediaSource.Path;

                playMethod = 'DirectPlay';
            } else if (mediaSource.StreamUrl) {
                // Only used for audio
                mediaUrl = mediaSource.StreamUrl;
                // Use the default playMethod value of Transcode
            } else if (mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream) {
                directOptions = {
                    Static: true,
                    mediaSourceId: mediaSource.Id,
                    deviceId: apiClient.deviceId(),
                    ApiKey: apiClient.accessToken()
                };

                if (mediaSource.ETag) {
                    directOptions.Tag = mediaSource.ETag;
                }

                if (mediaSource.LiveStreamId) {
                    directOptions.LiveStreamId = mediaSource.LiveStreamId;
                }

                const prefix = type === 'Video' ? 'Videos' : 'Audio';
                mediaUrl = apiClient.getUrl(prefix + '/' + item.Id + '/stream.' + mediaSourceContainer, directOptions);

                playMethod = mediaSource.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream';
            } else if (mediaSource.SupportsTranscoding) {
                mediaUrl = apiClient.getUrl(mediaSource.TranscodingUrl);

                if (mediaSource.TranscodingSubProtocol === 'hls') {
                    contentType = 'application/x-mpegURL';
                } else {
                    contentType = getMimeType(type.toLowerCase(), mediaSource.TranscodingContainer);

                    if (mediaUrl.toLowerCase().indexOf('copytimestamps=true') === -1) {
                        transcodingOffsetTicks = startPosition || 0;
                    }
                }
            }
        } else {
            // All other media types
            mediaUrl = mediaSource.Path;
            playMethod = 'DirectPlay';
        }

        // Fallback (used for offline items)
        if (!mediaUrl && mediaSource.SupportsDirectPlay) {
            mediaUrl = mediaSource.Path;
            playMethod = 'DirectPlay';
        }

        // startPosition is absolute on the source timeline, while the
        // media element seeks within the stream it receives. Non-copying
        // transcodes start that stream at transcodingOffsetTicks, so
        // seeking the element to the absolute position would apply the
        // same chapter seek twice.
        const playerStartPositionTicks = Math.max(0, startPosition - transcodingOffsetTicks);

        const resultInfo = {
            url: mediaUrl,
            mimeType: contentType,
            transcodingOffsetTicks: transcodingOffsetTicks,
            playMethod: playMethod,
            playerStartPositionTicks: playerStartPositionTicks,
            item: item,
            mediaSource: mediaSource,
            textTracks: getTextTracks(apiClient, item, mediaSource),
            // TODO: Deprecate
            tracks: getTextTracks(apiClient, item, mediaSource),
            mediaType: type,
            liveStreamId: liveStreamId,
            playSessionId: getParam('playSessionId', mediaUrl),
            title: item.Name
        };

        const backdropUrl = getItemBackdropImageUrl(apiClient, item, {}, true);
        if (backdropUrl) {
            resultInfo.backdropUrl = backdropUrl;
        }

        return resultInfo;
    }

    return {
        createStreamInfoFromUrlItem,
        getAudioStreamUrlFromDeviceProfile,
        setStreamUrls,
        createStreamInfo
    };
}
