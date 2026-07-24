import { Jellyfin, type Api } from '@jellyfin/sdk';
import { renderHook } from '@testing-library/react';
import React, { type PropsWithChildren } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { ApiContext } from 'hooks/useApi';
import { ItemKind } from 'types/base/models/item-kind';
import type { ItemDto } from 'types/base/models/item-dto';
import type { CardOptions } from 'types/cardOptions';
import { CardShape } from 'utils/card';

import useCardImageUrl from './useCardImageUrl';

function cardOptions(overrides: Partial<CardOptions> = {}): CardOptions {
    return { ...overrides };
}

describe('useCardImageUrl()', () => {
    let api: Api;

    beforeAll(() => {
        api = new Jellyfin({
            clientInfo: { name: 'jellyfin-web-codex tests', version: '0.0.0-test' },
            deviceInfo: { name: 'test-runner', id: 'test-runner-id' }
        }).createApi('https://jellyfin.test.invalid');
    });

    function renderUseCardImageUrl(item: ItemDto, options: CardOptions = cardOptions(), shape: CardShape | undefined = undefined) {
        return renderHook(() => useCardImageUrl({ item, cardOptions: options, shape }), {
            wrapper: ({ children }: PropsWithChildren) => (
                <ApiContext.Provider value={{ api }}>{children}</ApiContext.Provider>
            )
        });
    }

    it('returns no imgUrl when there is no api instance, even with a resolvable image', () => {
        const item = { Key: 'item-1', Id: 'item-1', Type: ItemKind.Movie, ImageTags: { Primary: 'tag-1' } } as ItemDto;

        const { result } = renderHook(() => useCardImageUrl({ item, cardOptions: cardOptions(), shape: undefined }), {
            wrapper: ({ children }: PropsWithChildren) => <ApiContext.Provider value={{}}>{children}</ApiContext.Provider>
        });

        expect(result.current.imgUrl).toBeUndefined();
    });

    it('returns no imgUrl when the item has no resolvable image at all', () => {
        const item = { Key: 'item-1', Id: 'item-1', Type: ItemKind.Movie } as ItemDto;

        const { result } = renderUseCardImageUrl(item);

        expect(result.current.imgUrl).toBeUndefined();
        expect(result.current.forceName).toBe(false);
        expect(result.current.coverImage).toBe(false);
    });

    it('defaults to the ImageTags.Primary image for a plain item', () => {
        const item = { Key: 'item-1', Id: 'item-1', Type: ItemKind.Movie, ImageTags: { Primary: 'primary-tag' } } as ItemDto;

        const { result } = renderUseCardImageUrl(item);

        expect(result.current.imgUrl).toContain('/Items/item-1/Images/Primary');
        expect(result.current.imgUrl).toContain('tag=primary-tag');
    });

    it('suppresses the Primary image for a childless Episode (falls through to the series image)', () => {
        const item = {
            Key: 'episode-1',
            Id: 'episode-1',
            Type: ItemKind.Episode,
            ChildCount: 0,
            ImageTags: { Primary: 'own-tag' },
            SeriesId: 'series-1',
            SeriesPrimaryImageTag: 'series-tag'
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item);

        expect(result.current.imgUrl).toContain('/Items/series-1/Images/Primary');
        expect(result.current.imgUrl).toContain('tag=series-tag');
    });

    it('prefers the thumb image when cardOptions.preferThumb is set', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.Movie,
            ImageTags: { Primary: 'primary-tag', Thumb: 'thumb-tag' }
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions({ preferThumb: true }));

        expect(result.current.imgUrl).toContain('/Items/item-1/Images/Thumb');
        expect(result.current.imgUrl).toContain('tag=thumb-tag');
    });

    it('does not prefer thumb for Episode/Program items even when preferThumb is set', () => {
        const item = {
            Key: 'episode-1',
            Id: 'episode-1',
            Type: ItemKind.Episode,
            ChildCount: 0,
            ImageTags: { Thumb: 'thumb-tag' },
            SeriesId: 'series-1',
            SeriesPrimaryImageTag: 'series-tag'
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions({ preferThumb: true }));

        expect(result.current.imgUrl).toContain('/Items/series-1/Images/Primary');
    });

    it('falls back to the series thumb when preferThumb is set and inheritThumb is not disabled', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.MusicAlbum,
            SeriesId: 'series-1',
            SeriesThumbImageTag: 'series-thumb-tag'
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions({ preferThumb: true }));

        expect(result.current.imgUrl).toContain('/Items/series-1/Images/Thumb');
        expect(result.current.imgUrl).toContain('tag=series-thumb-tag');
    });

    it('does not fall back to the series thumb when inheritThumb is explicitly false', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.MusicAlbum,
            SeriesId: 'series-1',
            SeriesThumbImageTag: 'series-thumb-tag'
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions({ preferThumb: true, inheritThumb: false }));

        expect(result.current.imgUrl).toBeUndefined();
    });

    it('prefers the banner image when cardOptions.preferBanner is set', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.Movie,
            ImageTags: { Primary: 'primary-tag', Banner: 'banner-tag' }
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions({ preferBanner: true }));

        expect(result.current.imgUrl).toContain('/Items/item-1/Images/Banner');
        expect(result.current.imgUrl).toContain('tag=banner-tag');
    });

    it('prefers the banner image when the card shape itself is Banner', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.Movie,
            ImageTags: { Primary: 'primary-tag', Banner: 'banner-tag' }
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions(), CardShape.Banner);

        expect(result.current.imgUrl).toContain('/Items/item-1/Images/Banner');
    });

    it('prefers the disc image when cardOptions.preferDisc is set', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.MusicAlbum,
            ImageTags: { Primary: 'primary-tag', Disc: 'disc-tag' }
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions({ preferDisc: true }));

        expect(result.current.imgUrl).toContain('/Items/item-1/Images/Disc');
        expect(result.current.imgUrl).toContain('tag=disc-tag');
    });

    it('falls back to the parent thumb image when cardOptions.inheritThumb is set', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.Episode,
            ParentThumbItemId: 'season-1',
            ParentThumbImageTag: 'season-thumb-tag'
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item, cardOptions({ inheritThumb: true }));

        expect(result.current.imgUrl).toContain('/Items/season-1/Images/Thumb');
        expect(result.current.imgUrl).toContain('tag=season-thumb-tag');
    });

    it('falls back to the album primary image when there is no other match', () => {
        const item = {
            Key: 'track-1',
            Id: 'track-1',
            Type: ItemKind.Audio,
            AlbumId: 'album-1',
            AlbumPrimaryImageTag: 'album-tag'
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item);

        expect(result.current.imgUrl).toContain('/Items/album-1/Images/Primary');
        expect(result.current.imgUrl).toContain('tag=album-tag');
    });

    it('falls back to the item backdrop image when there is no primary-family match', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.Movie,
            BackdropImageTags: [ 'backdrop-tag-1', 'backdrop-tag-2' ]
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item);

        expect(result.current.imgUrl).toContain('/Items/item-1/Images/Backdrop');
        expect(result.current.imgUrl).toContain('tag=backdrop-tag-1');
    });

    it('extracts the matching blurhash for the resolved image type/tag', () => {
        const item = {
            Key: 'item-1',
            Id: 'item-1',
            Type: ItemKind.Movie,
            ImageTags: { Primary: 'primary-tag' },
            ImageBlurHashes: { Primary: { 'primary-tag': 'L6PZfSjE.AyE_3t7t7R**0o#DgR4' } }
        } as ItemDto;

        const { result } = renderUseCardImageUrl(item);

        expect(result.current.blurhash).toBe('L6PZfSjE.AyE_3t7t7R**0o#DgR4');
    });
});
