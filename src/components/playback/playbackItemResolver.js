// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.

/**
 * Owns turning a play/queue request into the ordered list of items to play:
 * resolving a play/queue request (a single item, a folder, series, season,
 * episode, playlist, artist, genre, studio, person, photo album, ...) into
 * the concrete ordered list of items the play queue will contain, plus
 * fetching cinema-mode intros and additional video parts for an item.
 *
 * Uses from the shared context:
 * - context.serverConnections: getApiClient, to reach the item's own server.
 * - context.registry: getPlayer, to check whether the active player supports
 *   progress tracking before resolving a single episode's follow-on episodes.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared PlaybackContext and passes it to this factory as `context.items`.
 *
 * @module playbackItemResolver
 */

import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFilter } from '@jellyfin/sdk/lib/generated-client/models/item-filter';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import merge from 'lodash-es/merge';

import { getItems } from '../../utils/jellyfin-apiclient/getItems.ts';
import * as userSettings from '../../scripts/settings/userSettings';
import { isServerItem } from './playbackMediaSource';

const UNLIMITED_ITEMS = -1;

/**
 * Creates the playback item resolver.
 *
 * @param {object} context - The shared PlaybackContext built by playbackmanager.js.
 * @returns {object} getItemsForPlayback, getIntros, translateItemsForPlayback,
 * getAdditionalParts.
 */
export function createPlaybackItemResolver(context) {
    function getItemsForPlayback(serverId, query) {
        const apiClient = context.serverConnections.getApiClient(serverId);

        if (query.Ids && query.Ids.split(',').length === 1) {
            const itemId = query.Ids.split(',');

            return apiClient.getItem(apiClient.getCurrentUserId(), itemId).then(function (item) {
                return {
                    Items: [item],
                    TotalRecordCount: 1
                };
            });
        } else {
            if (query.Limit === UNLIMITED_ITEMS) {
                delete query.Limit;
            } else {
                query.Limit = query.Limit || 300;
            }
            query.Fields = ['Chapters', 'Trickplay'];
            query.ExcludeLocationTypes = 'Virtual';
            query.EnableTotalRecordCount = false;
            query.CollapseBoxSetItems = false;

            return getItems(apiClient, apiClient.getCurrentUserId(), query);
        }
    }

    function mergePlaybackQueries(obj1, obj2) {
        const query = merge({}, obj1, obj2);

        const filters = query.Filters?.split(',') || [];
        if (!filters.includes(ItemFilter.IsNotFolder)) {
            filters.push(ItemFilter.IsNotFolder);
        }
        query.Filters = filters.join(',');
        return query;
    }

    function enableIntros(item) {
        if (item.MediaType !== 'Video') {
            return false;
        }
        if (item.Type === 'TvChannel') {
            return false;
        }
        // disable for in-progress recordings
        if (item.Status === 'InProgress') {
            return false;
        }

        return isServerItem(item);
    }

    function getIntros(firstItem, apiClient, options) {
        if (options.startPositionTicks || options.startIndex || options.fullscreen === false || !enableIntros(firstItem) || !userSettings.enableCinemaMode()) {
            return Promise.resolve({
                Items: []
            });
        }

        return apiClient.getIntros(firstItem.Id).then(function (result) {
            return result;
        }, function (error) {
            console.warn('[playbackmanager] intros request failed:', error);
            return Promise.resolve({
                Items: []
            });
        });
    }

    async function translateItemsForPlayback(items, options) {
        if (!items.length) return [];

        sortItemsIfNeeded(items, options);

        const firstItem = items[0];
        const serverId = firstItem.ServerId;
        const queryOptions = options.queryOptions || {};

        const promise = getPlaybackPromise(firstItem, serverId, options, queryOptions, items);

        if (promise) {
            const result = await promise;
            return result ? result.Items : items;
        } else {
            return items;
        }
    }

    function sortItemsIfNeeded(items, options) {
        if (items.length > 1 && options?.ids) {
            // Use the original request id array for sorting the result in the proper order
            items.sort(function (a, b) {
                return options.ids.indexOf(a.Id) - options.ids.indexOf(b.Id);
            });
        }
    }

    function getPlaybackPromise(firstItem, serverId, options, queryOptions, items) {
        const SortBy = options.shuffle ? ItemSortBy.Random : ItemSortBy.SortName;

        switch (firstItem.Type) {
            case BaseItemKind.Program:
                return getItemsForPlayback(serverId, {
                    Ids: firstItem.ChannelId
                });
            case BaseItemKind.Playlist:
                return getItemsForPlayback(serverId, {
                    ParentId: firstItem.Id,
                    SortBy: options.shuffle ? SortBy : undefined
                });
            case BaseItemKind.MusicArtist:

                return getItemsForPlayback(serverId, mergePlaybackQueries({
                    ArtistIds: firstItem.Id,
                    Recursive: true,
                    SortBy: options.shuffle ? SortBy : [
                        ItemSortBy.Album,
                        ItemSortBy.ParentIndexNumber,
                        ItemSortBy.IndexNumber,
                        ItemSortBy.SortName
                    ].join(','),
                    MediaTypes: MediaType.Audio
                }, queryOptions));
            case BaseItemKind.PhotoAlbum:
                return getItemsForPlayback(serverId, mergePlaybackQueries({
                    ParentId: firstItem.Id,
                    // Setting this to true may cause some incorrect sorting
                    Recursive: false,
                    SortBy,
                    // Only include Photos because we do not handle mixed queues currently
                    MediaTypes: MediaType.Photo,
                    Limit: UNLIMITED_ITEMS
                }, queryOptions));
            case BaseItemKind.MusicGenre:
                return getItemsForPlayback(serverId, mergePlaybackQueries({
                    GenreIds: firstItem.Id,
                    Recursive: true,
                    SortBy,
                    MediaTypes: MediaType.Audio
                }, queryOptions));
            case BaseItemKind.Genre:
                return getItemsForPlayback(serverId, mergePlaybackQueries({
                    GenreIds: firstItem.Id,
                    ParentId: firstItem.ParentId,
                    Recursive: true,
                    SortBy,
                    MediaTypes: MediaType.Video
                }, queryOptions));
            case BaseItemKind.Studio:
                return getItemsForPlayback(serverId, mergePlaybackQueries({
                    StudioIds: firstItem.Id,
                    Recursive: true,
                    SortBy,
                    MediaTypes: MediaType.Video
                }, queryOptions));
            case BaseItemKind.Person:
                return getItemsForPlayback(serverId, mergePlaybackQueries({
                    PersonIds: firstItem.Id,
                    ParentId: firstItem.ParentId,
                    Recursive: true,
                    SortBy,
                    MediaTypes: MediaType.Video
                }, queryOptions));
            case BaseItemKind.Series:
            case BaseItemKind.Season:
                return getSeriesOrSeasonPlaybackPromise(firstItem, options, items);
            case BaseItemKind.Episode:
                return getEpisodePlaybackPromise(firstItem, options, items);
        }

        return getNonItemTypePromise(firstItem, serverId, options, queryOptions);
    }

    function getNonItemTypePromise(firstItem, serverId, options, queryOptions) {
        if (firstItem.MediaType === 'Photo') {
            return getItemsForPlayback(serverId, mergePlaybackQueries({
                ParentId: firstItem.ParentId,
                Filters: 'IsNotFolder',
                // Setting this to true may cause some incorrect sorting
                Recursive: false,
                SortBy: options.shuffle ? 'Random' : 'SortName',
                MediaTypes: 'Photo,Video',
                Limit: UNLIMITED_ITEMS
            }, queryOptions)).then(function (result) {
                const playbackItems = result.Items;

                let index = playbackItems.map(function (i) {
                    return i.Id;
                }).indexOf(firstItem.Id);

                if (index === -1) {
                    index = 0;
                }

                options.startIndex = index;

                return Promise.resolve(result);
            });
        } else if (firstItem.IsFolder && firstItem.CollectionType === 'homevideos') {
            return getItemsForPlayback(serverId, mergePlaybackQueries({
                ParentId: firstItem.Id,
                Filters: 'IsNotFolder',
                Recursive: true,
                SortBy: options.shuffle ? 'Random' : 'SortName',
                // Only include Photos because we do not handle mixed queues currently
                MediaTypes: 'Photo',
                Limit: UNLIMITED_ITEMS
            }, queryOptions));
        } else if (firstItem.IsFolder && firstItem.CollectionType === 'musicvideos') {
            return getItemsForPlayback(serverId, mergePlaybackQueries({
                ParentId: firstItem.Id,
                Filters: 'IsNotFolder',
                Recursive: true,
                SortBy: options.shuffle ? 'Random' : 'SortName',
                MediaTypes: 'Video',
                Limit: UNLIMITED_ITEMS
            }, queryOptions));
        } else if (firstItem.IsFolder) {
            let sortBy = null;
            if (options.shuffle) {
                sortBy = 'Random';
            } else if (firstItem.Type !== 'BoxSet') {
                if (firstItem.CollectionType === 'music' || firstItem.MediaType === 'Audio') {
                    sortBy = 'Album,ParentIndexNumber,IndexNumber,SortName';
                } else {
                    sortBy = 'SortName';
                }
            }

            return getItemsForPlayback(serverId, mergePlaybackQueries({
                ParentId: firstItem.Id,
                Filters: 'IsNotFolder',
                Recursive: true,
                // These are pre-sorted
                SortBy: sortBy,
                MediaTypes: 'Audio,Video'
            }, queryOptions));
        }

        return null;
    }

    async function getSeriesOrSeasonPlaybackPromise(firstItem, options, items) {
        const apiClient = context.serverConnections.getApiClient(firstItem.ServerId);
        const startSeasonId = firstItem.Type === 'Season' ? items[options.startIndex || 0].Id : undefined;

        const seasonId = (startSeasonId && items.length === 1) ? startSeasonId : undefined;
        const SeriesId = firstItem.SeriesId || firstItem.Id;
        const UserId = apiClient.getCurrentUserId();

        let startItemId;

        // Start from a specific (the next unwatched) episode if we want to watch in order and have not chosen a specific season
        if (!options.shuffle && !seasonId) {
            const nextUp = await apiClient.getNextUpEpisodes({ SeriesId, UserId });
            startItemId = nextUp?.Items?.[0]?.Id;
        }

        const episodesResult = await apiClient.getEpisodes(SeriesId, {
            IsVirtualUnaired: false,
            IsMissing: false,
            SeasonId: seasonId,
            // default to first 100 episodes if no season was specified to avoid loading too large payloads
            limit: seasonId ? undefined : 100,
            SortBy: options.shuffle ? 'Random' : undefined,
            UserId,
            Fields: ['Chapters', 'Trickplay'],
            startItemId
        });

        if (options.shuffle) {
            episodesResult.StartIndex = 0;
        } else {
            episodesResult.StartIndex = undefined;
            let seasonStartIndex;
            for (const [index, e] of episodesResult.Items.entries()) {
                if (startSeasonId && items.length != 1) {
                    if (e.SeasonId == startSeasonId) {
                        if (seasonStartIndex === undefined) {
                            seasonStartIndex = index;
                        }
                    } else {
                        continue;
                    }
                }
                if (!e.UserData.Played) {
                    episodesResult.StartIndex = index;
                    break;
                }
            }
            episodesResult.StartIndex = episodesResult.StartIndex || seasonStartIndex || 0;
        }

        // TODO: fix calling code to read episodesResult.StartIndex instead when set.
        options.startIndex = episodesResult.StartIndex;

        episodesResult.TotalRecordCount = episodesResult.Items.length;

        return episodesResult;
    }

    function getEpisodePlaybackPromise(firstItem, options, items) {
        if (items.length === 1 && context.registry.getPlayer(firstItem, options).supportsProgress !== false) {
            return getEpisodes(firstItem, options);
        } else {
            return null;
        }
    }

    function getEpisodes(firstItem, options) {
        return new Promise(function (resolve, reject) {
            const apiClient = context.serverConnections.getApiClient(firstItem.ServerId);

            const { SeriesId, Id } = firstItem;
            if (!SeriesId) {
                resolve(null);
                return;
            }

            apiClient.getEpisodes(SeriesId, {
                IsVirtualUnaired: false,
                IsMissing: false,
                UserId: apiClient.getCurrentUserId(),
                Fields: ['Chapters', 'Trickplay'],
                // limit to loading 100 episodes to avoid loading too large payload
                limit: 100,
                startItemId: Id
            }).then(function (episodesResult) {
                resolve(filterEpisodes(episodesResult, firstItem, options));
            }, reject);
        });
    }

    function filterEpisodes(episodesResult, firstItem, options) {
        for (const [index, e] of episodesResult.Items.entries()) {
            if (e.Id === firstItem.Id) {
                episodesResult.StartIndex = index;
                break;
            }
        }

        // TODO: fix calling code to read episodesResult.StartIndex instead when set.
        options.startIndex = episodesResult.StartIndex;
        episodesResult.TotalRecordCount = episodesResult.Items.length;
        return episodesResult;
    }

    const getAdditionalParts = async (items) => {
        const getItemAndParts = async function (item) {
            if (
                item.PartCount && item.PartCount > 1
                && [ BaseItemKind.Episode, BaseItemKind.Movie ].includes(item.Type)
            ) {
                const client = context.serverConnections.getApiClient(item.ServerId);
                const user = await client.getCurrentUser();
                const additionalParts = await client.getAdditionalVideoParts(user.Id, item.Id);
                if (additionalParts.Items.length) {
                    return [ item, ...additionalParts.Items ];
                }
            }
            return [ item ];
        };

        return Promise.all(items.map(getItemAndParts));
    };

    return {
        getItemsForPlayback,
        getIntros,
        translateItemsForPlayback,
        getAdditionalParts
    };
}
