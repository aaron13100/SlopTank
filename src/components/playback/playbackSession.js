// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns a play request end to end: resolve the items to play, prepend intros,
 * run pre-play interceptors, settle the streaming bitrate, then hand the
 * item off to the launcher to start it on a player.
 *
 * Reads from the shared PlaybackContext: context.manager (the
 * PlaybackManager instance, for _currentPlayer / _playQueueManager),
 * context.items (getItemsForPlayback, translateItemsForPlayback,
 * getAdditionalParts, getIntros), context.registry (getPlayer,
 * removeCurrentPlayer), context.streams (getSavedMaxStreamingBitrate,
 * detectBitrate), context.launcher (playAfterBitrateDetect),
 * context.pluginManager (ofType), context.serverConnections (getApiClient)
 * and context.showPlaybackError. The PlaybackManager facade
 * (playbackmanager.js) creates this module and passes it the context object
 * shared by every other playback collaborator module.
 */

import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import loading from '../loading/loading';
import { MediaError } from 'types/mediaError';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';

function normalizePlayOptions(playOptions) {
    playOptions.fullscreen = playOptions.fullscreen !== false;
}

function truncatePlayOptions(playOptions) {
    return {
        aspectRatio: playOptions.aspectRatio,
        fullscreen: playOptions.fullscreen,
        mediaSourceId: playOptions.mediaSourceId,
        audioStreamIndex: playOptions.audioStreamIndex,
        subtitleStreamIndex: playOptions.subtitleStreamIndex,
        startPositionTicks: playOptions.startPositionTicks,
        alreadyOnVideoOsd: playOptions.alreadyOnVideoOsd,
        skipAutomaticBitrateDetection: playOptions.skipAutomaticBitrateDetection
    };
}

/**
 * Creates the playback session module.
 * @param {object} context The shared PlaybackContext built by
 *   playbackmanager.js.
 * @returns {object} session
 *   - getDefaultPlayOptions: default options() applied when none are given.
 *   - setPlaylistState: records the active playlist item id and index.
 *   - playInternal: runs interceptors, settles bitrate, starts one item.
 *   - cancelPlayback: tears down the current player and fires
 *     'playbackcancelled'.
 *   - destroyPlayer: destroys a player instance.
 *   - play: resolves a play request (by item list or by id) and starts it.
 */
export function createPlaybackSession(context) {
    const { manager } = context;

    function playOther(items, options) {
        const playStartIndex = options.startIndex || 0;
        const player = context.registry.getPlayer(items[playStartIndex], options);

        loading.hide();

        options.items = items;

        return player.play(options);
    }

    function playWithIntros(items, options) {
        let playStartIndex = options.startIndex || 0;
        let firstItem = items[playStartIndex];

        // If index was bad, reset it
        if (!firstItem) {
            playStartIndex = 0;
            firstItem = items[playStartIndex];
        }

        // If it's still null then there's nothing to play
        if (!firstItem) {
            context.showPlaybackError(`PlaybackError.${MediaError.NO_MEDIA_ERROR}`);
            return Promise.reject();
        }

        if (firstItem.MediaType === 'Photo' || firstItem.MediaType === 'Book') {
            return playOther(items, options);
        }

        const apiClient = context.serverConnections.getApiClient(firstItem.ServerId);

        return context.items.getIntros(firstItem, apiClient, options).then(function (introsResult) {
            const introItems = introsResult.Items;
            let introPlayOptions;

            firstItem.playOptions = truncatePlayOptions(options);

            if (introItems.length) {
                introPlayOptions = {
                    fullscreen: firstItem.playOptions.fullscreen
                };
            } else {
                introPlayOptions = firstItem.playOptions;
            }

            items = introItems.concat(items);

            // Needed by players that manage their own playlist
            introPlayOptions.items = items;
            introPlayOptions.startIndex = playStartIndex;

            return playInternal(items[playStartIndex], introPlayOptions, function () {
                manager._playQueueManager.setPlaylist(items);

                setPlaylistState(items[playStartIndex].PlaylistItemId, playStartIndex);
                loading.hide();
            });
        });
    }

    function onInterceptorRejection() {
        cancelPlayback();

        return Promise.reject();
    }

    function onPlaybackRejection(e) {
        cancelPlayback();

        let displayErrorCode = 'ErrorDefault';

        if (e instanceof Response) {
            if (e.status >= 500) {
                displayErrorCode = `PlaybackError.${MediaError.SERVER_ERROR}`;
            } else if (e.status >= 400) {
                displayErrorCode = `PlaybackError.${MediaError.NO_MEDIA_ERROR}`;
            }
        }

        context.showPlaybackError(displayErrorCode);

        return Promise.reject();
    }

    function runInterceptors(item, playOptions) {
        return new Promise(function (resolve, reject) {
            const interceptors = context.pluginManager.ofType(PluginType.PreplayIntercept);

            interceptors.sort(function (a, b) {
                return (a.order || 0) - (b.order || 0);
            });

            if (!interceptors.length) {
                resolve();
                return;
            }

            const options = Object.assign({}, playOptions);

            options.mediaType = item.MediaType;
            options.item = item;

            runNextPrePlay(interceptors, 0, options, resolve, reject);
        });
    }

    function runNextPrePlay(interceptors, index, options, resolve, reject) {
        if (index >= interceptors.length) {
            resolve();
            return;
        }

        const interceptor = interceptors[index];

        interceptor.intercept(options).then(function () {
            runNextPrePlay(interceptors, index + 1, options, resolve, reject);
        }, reject);
    }

    function getDefaultPlayOptions() {
        return {
            fullscreen: true
        };
    }

    // Set playlist state. Using a method allows for overloading in derived player implementations
    function setPlaylistState(playlistItemId, index) {
        if (!isNaN(index)) {
            manager._playQueueManager.setPlaylistState(playlistItemId, index);
        }
    }

    function playInternal(item, playOptions, onPlaybackStartedFn, prevSource) {
        if (item.IsPlaceHolder) {
            loading.hide();
            context.showPlaybackError('PlaybackErrorPlaceHolder');
            return Promise.reject();
        }

        // Normalize defaults to simplfy checks throughout the process
        normalizePlayOptions(playOptions);

        if (playOptions.isFirstItem) {
            playOptions.isFirstItem = false;
        } else {
            playOptions.isFirstItem = true;
        }

        const apiClient = context.serverConnections.getApiClient(item.ServerId);

        // TODO: This should be the media type requested, not the original media type
        const mediaType = item.MediaType;

        if (playOptions.fullscreen && !playOptions.alreadyOnVideoOsd) {
            loading.show();
        }

        return runInterceptors(item, playOptions)
            .catch(onInterceptorRejection)
            .then(() => playOptions.skipAutomaticBitrateDetection ?
                context.streams.getSavedMaxStreamingBitrate(apiClient, mediaType) :
                context.streams.detectBitrate(apiClient, item, mediaType))
            .then((bitrate) => {
                return context.launcher.playAfterBitrateDetect(bitrate, item, playOptions, onPlaybackStartedFn, prevSource)
                    .catch(onPlaybackRejection);
            })
            .catch(() => {
                if (playOptions.fullscreen) {
                    loading.hide();
                }
            });
    }

    function cancelPlayback() {
        const player = manager._currentPlayer;

        if (player) {
            destroyPlayer(player);
            context.registry.removeCurrentPlayer(player);
        }

        Events.trigger(manager, 'playbackcancelled');
    }

    function destroyPlayer(player) {
        player.destroy();
    }

    async function play(options) {
        normalizePlayOptions(options);

        if (manager._currentPlayer) {
            if (options.enableRemotePlayers === false && !manager._currentPlayer.isLocalPlayer) {
                throw new PlaybackManagerError(PlaybackManagerErrorCode.RemotePlayersDisabled, 'Remote players are disabled');
            }

            if (!manager._currentPlayer.isLocalPlayer) {
                return manager._currentPlayer.play(options);
            }
        }

        if (options.fullscreen && !options.alreadyOnVideoOsd) {
            loading.show();
        }

        let { items } = options;
        // If items were not passed directly, fetch them by ID
        if (!items) {
            if (!options.serverId) {
                throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingServerId, 'serverId required!');
            }

            items = (await context.items.getItemsForPlayback(options.serverId, {
                Ids: options.ids.join(',')
            })).Items;
        }

        // Prepare the list of items
        items = await context.items.translateItemsForPlayback(items, options);
        // Add any additional parts for movies or episodes
        items = await context.items.getAdditionalParts(items);
        // Adjust the start index for additional parts added to the queue
        if (options.startIndex) {
            let adjustedStartIndex = 0;
            for (let i = 0; i < options.startIndex; i++) {
                adjustedStartIndex += items[i].length;
            }

            options.startIndex = adjustedStartIndex;
        }
        // getAdditionalParts returns an array of arrays of items, so flatten it
        items = items.flat();

        return playWithIntros(items, options);
    }

    return {
        getDefaultPlayOptions,
        setPlaylistState,
        playInternal,
        cancelPlayback,
        destroyPlayer,
        play
    };
}
