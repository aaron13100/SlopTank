import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ServerConnections } from 'lib/jellyfin-apiclient';
import type { ItemDto } from 'types/base/models/item-dto';

import { getImageUrl } from './image';

const SERVER_ID = 'server-1';

/** Records every getScaledImageUrl call so tests can assert exactly which item/options the code resolved to. */
const calls: { itemId: string, options: Record<string, unknown> }[] = [];

describe('getImageUrl()', () => {
    beforeAll(() => {
        // Same fake-ApiClient shape as playbackmanager.test.js's createOfflineApiClient:
        // ConnectionManager.getApiClient() matches on client.serverInfo().Id, not on a
        // "serverId" concept of its own, so serverInfo must be a stateful getter/setter.
        let serverInfo: { Id: string } = { Id: SERVER_ID };
        ServerConnections.addApiClient({
            serverAddress: () => 'https://jellyfin.test.invalid',
            serverInfo(info?: { Id: string }) {
                if (info) {
                    serverInfo = info;
                }
                return serverInfo;
            },
            serverId: () => SERVER_ID,
            getScaledImageUrl: (itemId: string, options: Record<string, unknown>) => {
                calls.push({ itemId, options });
                return `https://jellyfin.test.invalid/Items/${itemId}/Images/${options.type}?tag=${options.tag}`;
            }
        });
    });

    beforeEach(() => {
        calls.length = 0;
    });

    it('returns null when the item has no ServerId', () => {
        const item = { Id: 'item-1', Type: BaseItemKind.Movie } as ItemDto;

        expect(getImageUrl(item)).toBeNull();
        expect(calls).toHaveLength(0);
    });

    describe('Episode items', () => {
        it('uses the series primary image when requesting Primary and SeriesPrimaryImageTag is set', () => {
            const item = {
                ServerId: SERVER_ID,
                Id: 'episode-1',
                Type: BaseItemKind.Episode,
                SeriesId: 'series-1',
                SeriesPrimaryImageTag: 'series-primary-tag'
            } as ItemDto;

            const url = getImageUrl(item, { type: ImageType.Primary });

            expect(url).toBe('https://jellyfin.test.invalid/Items/series-1/Images/Primary?tag=series-primary-tag');
            expect(calls).toEqual([
                { itemId: 'series-1', options: { type: ImageType.Primary, tag: 'series-primary-tag' } }
            ]);
        });

        it('returns null for Primary when there is no SeriesPrimaryImageTag', () => {
            const item = {
                ServerId: SERVER_ID,
                Id: 'episode-1',
                Type: BaseItemKind.Episode,
                SeriesId: 'series-1'
            } as ItemDto;

            expect(getImageUrl(item, { type: ImageType.Primary })).toBeNull();
            expect(calls).toHaveLength(0);
        });

        it('uses the series thumb image when requesting Thumb and SeriesThumbImageTag is set', () => {
            const item = {
                ServerId: SERVER_ID,
                Id: 'episode-1',
                Type: BaseItemKind.Episode,
                SeriesId: 'series-1',
                SeriesThumbImageTag: 'series-thumb-tag'
            } as ItemDto;

            const url = getImageUrl(item, { type: ImageType.Thumb });

            expect(url).toBe('https://jellyfin.test.invalid/Items/series-1/Images/Thumb?tag=series-thumb-tag');
            expect(calls).toEqual([
                { itemId: 'series-1', options: { type: ImageType.Thumb, tag: 'series-thumb-tag' } }
            ]);
        });

        it('falls back to the parent thumb image when there is no SeriesThumbImageTag', () => {
            const item = {
                ServerId: SERVER_ID,
                Id: 'episode-1',
                Type: BaseItemKind.Episode,
                SeriesId: 'series-1',
                ParentThumbItemId: 'season-1',
                ParentThumbImageTag: 'season-thumb-tag'
            } as ItemDto;

            const url = getImageUrl(item, { type: ImageType.Thumb });

            expect(url).toBe('https://jellyfin.test.invalid/Items/season-1/Images/Thumb?tag=season-thumb-tag');
            expect(calls).toEqual([
                { itemId: 'season-1', options: { type: ImageType.Thumb, tag: 'season-thumb-tag' } }
            ]);
        });

        it('returns null for Thumb when neither series nor parent thumb tags are set', () => {
            const item = {
                ServerId: SERVER_ID,
                Id: 'episode-1',
                Type: BaseItemKind.Episode,
                SeriesId: 'series-1'
            } as ItemDto;

            expect(getImageUrl(item, { type: ImageType.Thumb })).toBeNull();
            expect(calls).toHaveLength(0);
        });
    });

    describe('non-Episode items', () => {
        it('defaults to the Primary image type when no options are given', () => {
            const item = {
                Key: 'movie-1',
                ServerId: SERVER_ID,
                Id: 'movie-1',
                Type: BaseItemKind.Movie,
                ImageTags: { [ImageType.Primary]: 'primary-tag' }
            } as ItemDto;

            const url = getImageUrl(item);

            expect(url).toBe('https://jellyfin.test.invalid/Items/movie-1/Images/Primary?tag=primary-tag');
        });

        it('prefers PrimaryImageItemId over Id when resolving the image tag lookup', () => {
            const item = {
                Key: 'movie-1',
                ServerId: SERVER_ID,
                Id: 'movie-1',
                PrimaryImageItemId: 'linked-item-1',
                Type: BaseItemKind.Movie,
                ImageTags: { [ImageType.Primary]: 'primary-tag' }
            } as ItemDto;

            const url = getImageUrl(item, { type: ImageType.Primary });

            expect(url).toBe('https://jellyfin.test.invalid/Items/linked-item-1/Images/Primary?tag=primary-tag');
            expect(calls).toEqual([
                { itemId: 'linked-item-1', options: { type: ImageType.Primary, tag: 'primary-tag' } }
            ]);
        });

        it('falls back to the album primary image when there is no matching ImageTag', () => {
            const item = {
                ServerId: SERVER_ID,
                Id: 'track-1',
                Type: BaseItemKind.Audio,
                AlbumId: 'album-1',
                AlbumPrimaryImageTag: 'album-tag'
            } as ItemDto;

            const url = getImageUrl(item, { type: ImageType.Primary });

            expect(url).toBe('https://jellyfin.test.invalid/Items/album-1/Images/Primary?tag=album-tag');
            expect(calls).toEqual([
                { itemId: 'album-1', options: { type: ImageType.Primary, tag: 'album-tag' } }
            ]);
        });

        it('returns null when there is no matching image tag anywhere', () => {
            const item = {
                ServerId: SERVER_ID,
                Id: 'movie-1',
                Type: BaseItemKind.Movie
            } as ItemDto;

            expect(getImageUrl(item, { type: ImageType.Primary })).toBeNull();
            expect(calls).toHaveLength(0);
        });
    });
});
