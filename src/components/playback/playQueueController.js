// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import Events from '../../utils/events.ts';

import { enableLocalPlaylistManagement } from './playerRegistry';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';

/**
 * Owns the play queue: navigating it, editing it, and queueing more items.
 *
 * Uses from the shared context:
 * - context.session.getDefaultPlayOptions(), context.session.playInternal and
 *   context.session.setPlaylistState to start playback of an item already in
 *   the queue (current/next/previous track selection).
 * - context.tracks.getPreviousSource(player) to carry the previous item's
 *   audio/subtitle stream selection into the next playback request.
 * - context.items.translateItemsForPlayback and
 *   context.items.getItemsForPlayback to resolve a queue() request's item
 *   ids into playable items.
 * - context.streamInfo.setStreamUrls to prepare stream urls before handing
 *   queued items directly to a remote player.
 * - context.serverConnections.getApiClient to look up the api client for a
 *   queued item's server when queueing directly to a remote player.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context and stores this factory's return value as
 * context.queue.
 *
 * @param {object} context The shared PlaybackContext built by
 * playbackmanager.js.
 * @returns {object} getPlaylist, getItemFromPlaylistItemId,
 * setCurrentPlaylistItem, removeFromPlaylist, movePlaylistItem,
 * getCurrentPlaylistIndex, getCurrentPlaylistItemId, channelUp, channelDown,
 * nextTrack, previousTrack, queue and queueNext.
 */
export function createPlayQueueController(context) {
    const { manager } = context;

    function getPlaylist(player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            if (player.getPlaylistSync) {
                return Promise.resolve(player.getPlaylistSync());
            }

            return player.getPlaylist();
        }

        return Promise.resolve(manager._playQueueManager.getPlaylist());
    }

    function getItemFromPlaylistItemId(playlistItemId) {
        let item;
        let itemIndex;
        const playlist = manager._playQueueManager.getPlaylist();

        for (let i = 0, length = playlist.length; i < length; i++) {
            if (playlist[i].PlaylistItemId === playlistItemId) {
                item = playlist[i];
                itemIndex = i;
                break;
            }
        }

        return {
            Item: item,
            Index: itemIndex
        };
    }

    function setCurrentPlaylistItem(playlistItemId, player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.setCurrentPlaylistItem(playlistItemId);
        }

        const newItem = manager.getItemFromPlaylistItemId(playlistItemId);

        if (newItem.Item) {
            const newItemPlayOptions = newItem.Item.playOptions || context.session.getDefaultPlayOptions();

            context.session.playInternal(newItem.Item, newItemPlayOptions, function () {
                context.session.setPlaylistState(newItem.Item.PlaylistItemId, newItem.Index);
            });
        }
    }

    function removeFromPlaylist(playlistItemIds, player) {
        if (!playlistItemIds) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.InvalidPlaylistItemIds, 'Invalid playlistItemIds');
        }

        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.removeFromPlaylist(playlistItemIds);
        }

        const removeResult = manager._playQueueManager.removeFromPlaylist(playlistItemIds);

        if (removeResult.result === 'empty') {
            return manager.stop(player);
        }

        const isCurrentIndex = removeResult.isCurrentIndex;

        Events.trigger(player, 'playlistitemremove', [
            {
                playlistItemIds: playlistItemIds
            }
        ]);

        if (isCurrentIndex) {
            return manager.setCurrentPlaylistItem(manager._playQueueManager.getPlaylist()[0].PlaylistItemId, player);
        }

        return Promise.resolve();
    }

    function movePlaylistItem(playlistItemId, newIndex, player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.movePlaylistItem(playlistItemId, newIndex);
        }

        const moveResult = manager._playQueueManager.movePlaylistItem(playlistItemId, newIndex);

        if (moveResult.result === 'noop') {
            return;
        }

        Events.trigger(player, 'playlistitemmove', [
            {
                playlistItemId: moveResult.playlistItemId,
                newIndex: moveResult.newIndex
            }
        ]);
    }

    function getCurrentPlaylistIndex(player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.getCurrentPlaylistIndex();
        }

        return manager._playQueueManager.getCurrentPlaylistIndex();
    }

    function getCurrentPlaylistItemId(player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.getCurrentPlaylistItemId();
        }

        return manager._playQueueManager.getCurrentPlaylistItemId();
    }

    function channelUp(player) {
        player = player || manager._currentPlayer;
        return manager.nextTrack(player);
    }

    function channelDown(player) {
        player = player || manager._currentPlayer;
        return manager.previousTrack(player);
    }

    function nextTrack(player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.nextTrack();
        }

        const newItemInfo = manager._playQueueManager.getNextItemInfo();

        if (newItemInfo) {
            console.debug('playing next track');

            const newItemPlayOptions = newItemInfo.item.playOptions || context.session.getDefaultPlayOptions();

            context.session.playInternal(newItemInfo.item, newItemPlayOptions, function () {
                context.session.setPlaylistState(newItemInfo.item.PlaylistItemId, newItemInfo.index);
            }, context.tracks.getPreviousSource(player));
        }
    }

    function previousTrack(player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.previousTrack();
        }

        const newIndex = manager.getCurrentPlaylistIndex(player) - 1;
        if (newIndex >= 0) {
            const playlist = manager._playQueueManager.getPlaylist();
            const newItem = playlist[newIndex];

            if (newItem) {
                const newItemPlayOptions = newItem.playOptions || context.session.getDefaultPlayOptions();
                newItemPlayOptions.startPositionTicks = 0;

                context.session.playInternal(newItem, newItemPlayOptions, function () {
                    context.session.setPlaylistState(newItem.PlaylistItemId, newIndex);
                }, context.tracks.getPreviousSource(player));
            }
        }
    }

    function queue(options, player = manager._currentPlayer) {
        return queueItems(options, '', player);
    }

    function queueNext(options, player = manager._currentPlayer) {
        return queueItems(options, 'next', player);
    }

    function queueItems(options, mode, player) {
        player = player || manager._currentPlayer;

        if (!player) {
            return manager.play(options);
        }

        if (options.items) {
            return context.items.translateItemsForPlayback(options.items, options).then(function (items) {
                // TODO: Handle options.startIndex for photos
                queueAll(items, mode, player);
            });
        } else {
            if (!options.serverId) {
                throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingServerId, 'serverId required!');
            }

            return context.items.getItemsForPlayback(options.serverId, {
                Ids: options.ids.join(',')
            }).then(function (result) {
                return context.items.translateItemsForPlayback(result.Items, options).then(function (items) {
                    // TODO: Handle options.startIndex for photos
                    queueAll(items, mode, player);
                });
            });
        }
    }

    function queueAll(items, mode, player) {
        if (!items.length) {
            return;
        }

        if (!player.isLocalPlayer) {
            if (mode === 'next') {
                player.queueNext({
                    items: items
                });
            } else {
                player.queue({
                    items: items
                });
            }
            return;
        }

        const queueDirectToPlayer = player && !enableLocalPlaylistManagement(player);

        if (queueDirectToPlayer) {
            const apiClient = context.serverConnections.getApiClient(items[0].ServerId);

            player.getDeviceProfile(items[0]).then(function (profile) {
                context.streamInfo.setStreamUrls(items, profile, manager.getMaxStreamingBitrate(player), apiClient, 0).then(function () {
                    if (mode === 'next') {
                        player.queueNext(items);
                    } else {
                        player.queue(items);
                    }
                });
            });

            return;
        }

        if (mode === 'next') {
            manager._playQueueManager.queueNext(items);
        } else {
            manager._playQueueManager.queue(items);
        }
        Events.trigger(player, 'playlistitemadd');
    }

    return {
        getPlaylist,
        getItemFromPlaylistItemId,
        setCurrentPlaylistItem,
        removeFromPlaylist,
        movePlaylistItem,
        getCurrentPlaylistIndex,
        getCurrentPlaylistItemId,
        channelUp,
        channelDown,
        nextTrack,
        previousTrack,
        queue,
        queueNext
    };
}
