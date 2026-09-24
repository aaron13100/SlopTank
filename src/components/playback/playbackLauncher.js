// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Starts one resolved item on its player once the bitrate is known.
 *
 * Owns player choice for the item, the handoff from any previously active
 * player, carrying the previous track choice forward onto the new media
 * source, negotiating the media source and building its stream info, and
 * skip-ahead to the next queued trailer when a trailer item fails to play.
 *
 * Uses from context: manager (_currentPlayer, _playNextAfterEnded, play,
 * stop, trackHasSecondarySubtitleSupport, _playQueueManager), registry
 * (getPlayer), lifecycle (onPlaybackChanging, onPlaybackStarted,
 * onPlaybackError), session (cancelPlayback), events (bindStopped,
 * unbindStopped), state (getPlayerData), streamInfo
 * (createStreamInfoFromUrlItem, setStreamUrls, createStreamInfo), mediaSource
 * (getPlaybackMediaSource), showPlaybackError, serverConnections.
 *
 * The PlaybackManager facade (playbackmanager.js) creates this module and
 * passes it the shared context built for every collaborator factory.
 *
 * @module playbackLauncher
 */

import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import loading from '../loading/loading';
import globalize from '../../lib/globalize';
import { resolvePlaybackMediaStreams } from './mediaStreams';
import { getMediaError } from 'utils/mediaError';
import { isServerItem } from './playbackMediaSource';
import { enableLocalPlaylistManagement } from './playerRegistry';

/**
 * Creates the playback launcher operations.
 * @param {object} context The shared PlaybackContext built by playbackmanager.js.
 * @returns {object} playAfterBitrateDetect.
 */
export function createPlaybackLauncher(context) {
    const { manager } = context;

    function sendPlaybackListToPlayer(player, items, deviceProfile, apiClient, mediaSourceId, options) {
        return context.streamInfo.setStreamUrls(items, deviceProfile, options.maxBitrate, apiClient, options.startPosition).then(function () {
            loading.hide();

            return player.play({
                items,
                startPositionTicks: options.startPosition || 0,
                mediaSourceId,
                audioStreamIndex: options.audioStreamIndex,
                subtitleStreamIndex: options.subtitleStreamIndex,
                startIndex: options.startIndex
            });
        });
    }

    function rankStreamType(prevIndex, prevSource, mediaStreams, trackOptions, streamType, isSecondarySubtitle) {
        if (prevIndex == -1) {
            console.debug(`AutoSet ${streamType} - No Stream Set`);
            if (streamType == 'Subtitle') {
                if (isSecondarySubtitle) {
                    trackOptions.DefaultSecondarySubtitleStreamIndex = -1;
                } else {
                    trackOptions.DefaultSubtitleStreamIndex = -1;
                }
            }
            return;
        }

        if (!prevSource.MediaStreams || !mediaStreams) {
            console.debug(`AutoSet ${streamType} - No MediaStreams`);
            return;
        }

        let bestStreamIndex = null;
        let bestStreamScore = 0;
        const prevStream = prevSource.MediaStreams[prevIndex];

        if (!prevStream) {
            console.debug(`AutoSet ${streamType} - No prevStream`);
            return;
        }

        console.debug(`AutoSet ${streamType} - Previous was ${prevStream.Index} - ${prevStream.DisplayTitle}`);

        let prevRelIndex = 0;
        for (const stream of prevSource.MediaStreams) {
            if (stream.Type != streamType) continue;

            if (stream.Index == prevIndex) break;

            prevRelIndex += 1;
        }

        let newRelIndex = 0;
        for (const stream of mediaStreams) {
            if (stream.Type != streamType) continue;

            let score = 0;

            if (prevStream.Codec == stream.Codec) score += 1;
            if (prevRelIndex == newRelIndex) score += 1;
            if (prevStream.DisplayTitle && prevStream.DisplayTitle == stream.DisplayTitle) score += 2;
            if (prevStream.Language && prevStream.Language != 'und' && prevStream.Language == stream.Language) score += 2;

            console.debug(`AutoSet ${streamType} - Score ${score} for ${stream.Index} - ${stream.DisplayTitle}`);
            if (score > bestStreamScore && score >= 3) {
                bestStreamScore = score;
                bestStreamIndex = stream.Index;
            }

            newRelIndex += 1;
        }

        if (bestStreamIndex != null) {
            console.debug(`AutoSet ${streamType} - Using ${bestStreamIndex} score ${bestStreamScore}.`);
            if (streamType == 'Subtitle') {
                if (isSecondarySubtitle) {
                    trackOptions.DefaultSecondarySubtitleStreamIndex = bestStreamIndex;
                } else {
                    trackOptions.DefaultSubtitleStreamIndex = bestStreamIndex;
                }
            }
            if (streamType == 'Audio') {
                trackOptions.DefaultAudioStreamIndex = bestStreamIndex;
            }
        } else {
            console.debug(`AutoSet ${streamType} - Threshold not met. Using default.`);
        }
    }

    function autoSetNextTracks(prevSource, mediaStreams, trackOptions, audio, subtitle) {
        try {
            if (!prevSource) return;

            if (!mediaStreams) {
                console.warn('AutoSet - No mediaStreams');
                return;
            }

            if (audio && typeof prevSource.DefaultAudioStreamIndex == 'number') {
                rankStreamType(prevSource.DefaultAudioStreamIndex, prevSource, mediaStreams, trackOptions, 'Audio');
            }

            if (subtitle && typeof prevSource.DefaultSubtitleStreamIndex == 'number') {
                rankStreamType(prevSource.DefaultSubtitleStreamIndex, prevSource, mediaStreams, trackOptions, 'Subtitle');
            }

            if (subtitle && typeof prevSource.DefaultSecondarySubtitleStreamIndex == 'number') {
                rankStreamType(prevSource.DefaultSecondarySubtitleStreamIndex, prevSource, mediaStreams, trackOptions, 'Subtitle', true);
            }
        } catch (e) {
            console.error(`AutoSet - Caught unexpected error: ${e}`);
        }
    }

    /**
     * Returns the queued trailer items after a trailer that failed to
     * play. Prefers the originating play request's item list (present
     * when the failed item was the first of a play() call, before the
     * queue is committed on playback start); falls back to the live
     * play queue for failures while advancing through an
     * already-started trailer list.
     * @param {object} failedItem The trailer item whose playback failed.
     * @param {object} playOptions The play options passed to playInternal.
     * @returns {object[]} The remaining trailer items (possibly empty).
     */
    function getRemainingTrailers(failedItem, playOptions) {
        const sourceItems = playOptions.items || manager._playQueueManager.getPlaylist();
        const failedIndex = sourceItems.indexOf(failedItem);
        if (failedIndex === -1) {
            return [];
        }
        return sourceItems.slice(failedIndex + 1).filter((remainingItem) => remainingItem.Type === 'Trailer');
    }

    function playAfterBitrateDetect(maxBitrate, item, playOptions, onPlaybackStartedFn, prevSource) {
        const startPosition = playOptions.startPositionTicks;

        const player = context.registry.getPlayer(item, playOptions);
        const activePlayer = manager._currentPlayer;

        let promise;

        if (activePlayer) {
            // TODO: if changing players within the same playlist, this will cause nextItem to be null
            manager._playNextAfterEnded = false;
            promise = context.lifecycle.onPlaybackChanging(activePlayer, player, item);
        } else {
            promise = Promise.resolve();
        }

        if (!player) {
            return promise.then(() => {
                context.session.cancelPlayback();
                loading.hide();
                console.error(`No player found for the requested media: ${item.Url}`);
                context.showPlaybackError('ErrorPlayerNotFound');
            });
        }

        if (!isServerItem(item) || item.MediaType === 'Book') {
            return promise.then(function () {
                const streamInfo = context.streamInfo.createStreamInfoFromUrlItem(item);
                streamInfo.fullscreen = playOptions.fullscreen;
                streamInfo.alreadyOnVideoOsd = playOptions.alreadyOnVideoOsd;
                context.state.getPlayerData(player).isChangingStream = false;
                return player.play(streamInfo).then(() => {
                    loading.hide();
                    onPlaybackStartedFn();
                    context.lifecycle.onPlaybackStarted(player, playOptions, streamInfo);
                }).catch((errorCode) => {
                    const errorKey = typeof errorCode === 'string' && errorCode ? errorCode : 'ErrorDefault';

                    // Trailer playlists (YouTube URLs from remote
                    // metadata) routinely contain dead entries: skip to
                    // the next trailer instead of aborting the whole
                    // list. Scoped to Trailer items so ordinary playback
                    // error handling is unchanged.
                    const remainingTrailers = item.Type === 'Trailer' ? getRemainingTrailers(item, playOptions) : [];
                    if (remainingTrailers.length) {
                        console.warn(`[playbackmanager] trailer failed (${errorKey}); skipping to the next trailer`);
                        // Tear down the failed attempt without letting
                        // 'stopped' report a user-facing stop (which
                        // would reset the queue), then play the rest.
                        context.events.unbindStopped(player);
                        return player.stop(false).then(() => {
                            context.events.bindStopped(player);
                            return manager.play({
                                items: remainingTrailers,
                                fullscreen: playOptions.fullscreen
                            });
                        });
                    }

                    manager.stop(player);
                    loading.hide();
                    if (item.Type === 'Trailer') {
                        // Every trailer failed: name the real mapped
                        // reason instead of a generic error.
                        context.showPlaybackError('TrailerUnavailable', globalize.translate(errorKey));
                    } else {
                        context.showPlaybackError(errorKey);
                    }
                });
            });
        }

        let mediaSourceId = playOptions.mediaSourceId;
        const apiClient = context.serverConnections.getApiClient(item.ServerId);
        const isLiveTv = [BaseItemKind.TvChannel, BaseItemKind.LiveTvChannel].includes(item.Type);
        const getMediaStreams = isLiveTv ?
            Promise.resolve([]) :
            resolvePlaybackMediaStreams(apiClient, item, mediaSourceId);

        return Promise.all([promise, player.getDeviceProfile(item), apiClient.getCurrentUser(), getMediaStreams]).then(function (responses) {
            const deviceProfile = responses[1];
            const user = responses[2];
            const mediaStreams = responses[3];

            const audioStreamIndex = playOptions.audioStreamIndex;
            const subtitleStreamIndex = playOptions.subtitleStreamIndex;
            const options = {
                aspectRatio: playOptions.aspectRatio,
                maxBitrate,
                startPosition,
                isPlayback: null,
                audioStreamIndex,
                subtitleStreamIndex,
                startIndex: playOptions.startIndex,
                enableDirectPlay: null,
                enableDirectStream: null,
                allowVideoStreamCopy: null,
                allowAudioStreamCopy: null
            };

            if (player && !enableLocalPlaylistManagement(player)) {
                return sendPlaybackListToPlayer(player, playOptions.items, deviceProfile, apiClient, mediaSourceId, options);
            }

            // this reference was only needed by sendPlaybackListToPlayer
            playOptions.items = null;

            const trackOptions = {};
            let isIdFallbackNeeded = false;

            autoSetNextTracks(prevSource, mediaStreams, trackOptions, user.Configuration.RememberAudioSelections, user.Configuration.RememberSubtitleSelections);
            if (trackOptions.DefaultAudioStreamIndex != null) {
                options.audioStreamIndex = trackOptions.DefaultAudioStreamIndex;
                isIdFallbackNeeded = true;
            }
            if (trackOptions.DefaultSubtitleStreamIndex != null) {
                options.subtitleStreamIndex = trackOptions.DefaultSubtitleStreamIndex;
                isIdFallbackNeeded = true;
            }

            if (isIdFallbackNeeded) {
                mediaSourceId ||= item.Id;
            }

            return context.mediaSource.getPlaybackMediaSource(player, apiClient, deviceProfile, item, mediaSourceId, options).then(async (mediaSource) => {
                if (trackOptions.DefaultSecondarySubtitleStreamIndex != null) {
                    mediaSource.DefaultSecondarySubtitleStreamIndex = trackOptions.DefaultSecondarySubtitleStreamIndex;
                }

                if (mediaSource.DefaultSubtitleStreamIndex == null || mediaSource.DefaultSubtitleStreamIndex < 0) {
                    if (mediaSource.DefaultSecondarySubtitleStreamIndex != null) {
                        mediaSource.DefaultSubtitleStreamIndex = mediaSource.DefaultSecondarySubtitleStreamIndex;
                    }
                    mediaSource.DefaultSecondarySubtitleStreamIndex = -1;
                }

                const subtitleTrack1 = mediaSource.MediaStreams[mediaSource.DefaultSubtitleStreamIndex];
                const subtitleTrack2 = mediaSource.MediaStreams[mediaSource.DefaultSecondarySubtitleStreamIndex];

                if (!manager.trackHasSecondarySubtitleSupport(subtitleTrack1, player)
                    || !manager.trackHasSecondarySubtitleSupport(subtitleTrack2, player)) {
                    mediaSource.DefaultSecondarySubtitleStreamIndex = -1;
                }

                const streamInfo = context.streamInfo.createStreamInfo(apiClient, item.MediaType, item, mediaSource, startPosition, player);
                streamInfo.aspectRatio = playOptions.aspectRatio;
                streamInfo.fullscreen = playOptions.fullscreen;
                streamInfo.alreadyOnVideoOsd = playOptions.alreadyOnVideoOsd;

                const playerData = context.state.getPlayerData(player);

                playerData.isChangingStream = false;
                playerData.maxStreamingBitrate = maxBitrate;
                playerData.streamInfo = streamInfo;

                return player.play(streamInfo).then(function () {
                    loading.hide();
                    onPlaybackStartedFn();
                    context.lifecycle.onPlaybackStarted(player, playOptions, streamInfo, mediaSource);
                }, function (err) {
                    // TODO: Improve this because it will report playback start on a failure
                    onPlaybackStartedFn();
                    context.lifecycle.onPlaybackStarted(player, playOptions, streamInfo, mediaSource);
                    setTimeout(function () {
                        context.lifecycle.onPlaybackError.call(player, err, {
                            type: getMediaError(err),
                            streamInfo
                        });
                    }, 100);
                });
            });
        });
    }

    return {
        playAfterBitrateDetect
    };
}
