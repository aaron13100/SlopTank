// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-09-09.
import { Jellyfin, type Api } from '@jellyfin/sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import globalize from 'lib/globalize';
import datetime from 'scripts/datetime';
import { ItemKind } from 'types/base/models/item-kind';
import type { ItemDto } from 'types/base/models/item-dto';
import type { CardOptions } from 'types/cardOptions';

import {
    getAirTimeText,
    getCardLogoUrl,
    getItemCounts,
    shouldShowOtherText,
    shouldShowParentTitleUnderneath,
    shouldShowTitle
} from './cardHelper';

function cardOptions(overrides: Partial<CardOptions> = {}): CardOptions {
    return { ...overrides };
}

describe('shouldShowTitle()', () => {
    it('shows the title when showTitle is truthy', () => {
        expect(shouldShowTitle(true, ItemKind.Movie)).toBe(true);
        expect(shouldShowTitle('auto', ItemKind.Movie)).toBe(true);
    });

    it('hides the title when showTitle is falsy for an unrelated item type', () => {
        expect(shouldShowTitle(false, ItemKind.Movie)).toBe(false);
        expect(shouldShowTitle(undefined, ItemKind.Movie)).toBe(false);
    });

    it('always shows the title for photo albums and folders regardless of showTitle', () => {
        expect(shouldShowTitle(false, ItemKind.PhotoAlbum)).toBe(true);
        expect(shouldShowTitle(undefined, ItemKind.Folder)).toBe(true);
    });
});

describe('shouldShowOtherText()', () => {
    it('inverts overlayText for the outer footer', () => {
        expect(shouldShowOtherText(true, true)).toBe(false);
        expect(shouldShowOtherText(true, false)).toBe(true);
    });

    it('passes overlayText through unchanged when not the outer footer', () => {
        expect(shouldShowOtherText(false, true)).toBe(true);
        expect(shouldShowOtherText(false, false)).toBe(false);
    });
});

describe('shouldShowParentTitleUnderneath()', () => {
    it('is true for music album, audio, and music video items', () => {
        expect(shouldShowParentTitleUnderneath(ItemKind.MusicAlbum)).toBe(true);
        expect(shouldShowParentTitleUnderneath(ItemKind.Audio)).toBe(true);
        expect(shouldShowParentTitleUnderneath(ItemKind.MusicVideo)).toBe(true);
    });

    it('is false for other item types', () => {
        expect(shouldShowParentTitleUnderneath(ItemKind.Movie)).toBe(false);
        expect(shouldShowParentTitleUnderneath(ItemKind.Series)).toBe(false);
    });
});

describe('getItemCounts()', () => {
    beforeAll(async () => {
        // Load the real string dictionary so assertions cover the actual
        // user-facing message text, not just translation keys.
        globalize.register({ name: 'core', strings: [{ lang: 'en-us', path: 'en-us.json' }] });
        globalize.defaultModule('core');
        await globalize.loadStrings('core');
    });

    it('returns the runtime for playlists', () => {
        const item = { Type: ItemKind.Playlist, RunTimeTicks: 12_000_000_000 } as ItemDto;

        expect(getItemCounts(cardOptions(), item)).toBe('20 min');
    });

    it('joins movie, series, and episode counts for genres/studios, using singular text for 1', () => {
        const item = {
            Type: ItemKind.Genre,
            MovieCount: 1,
            SeriesCount: 2,
            EpisodeCount: 0
        } as ItemDto;

        expect(getItemCounts(cardOptions(), item)).toBe('1 movie, 2 series');
    });

    it('joins album, song, and music video counts for music genres/artists', () => {
        const item = {
            Type: ItemKind.MusicGenre,
            AlbumCount: 3,
            SongCount: 1,
            MusicVideoCount: 2
        } as ItemDto;

        expect(getItemCounts(cardOptions(), item)).toBe('3 albums, 1 song, 2 music videos');
    });

    it('uses the music-artist context to trigger album/song counts for a non-MusicGenre type', () => {
        const item = { Type: ItemKind.MusicArtist, AlbumCount: 5 } as ItemDto;

        expect(getItemCounts(cardOptions({ context: 'MusicArtist' as CardOptions['context'] }), item)).toBe('5 albums');
    });

    it('returns the recursive episode count for series', () => {
        const item = { Type: ItemKind.Series, RecursiveItemCount: 12 } as ItemDto;

        expect(getItemCounts(cardOptions(), item)).toBe('12 episodes');
    });

    it('returns an empty string for item types with no count rule', () => {
        const item = { Type: ItemKind.Movie } as ItemDto;

        expect(getItemCounts(cardOptions(), item)).toBe('');
    });
});

describe('getAirTimeText()', () => {
    it('returns an empty string when the item has no StartDate', () => {
        expect(getAirTimeText({} as ItemDto, false, false)).toBe('');
    });

    it('returns just the display time when showAirDateTime is false', () => {
        const item = { StartDate: '2026-03-05T20:00:00.000Z' } as ItemDto;

        const expected = datetime.getDisplayTime(datetime.parseISO8601Date(item.StartDate));
        expect(getAirTimeText(item, false, false)).toBe(expected);
    });

    it('prefixes the date when showAirDateTime is true', () => {
        const item = { StartDate: '2026-03-05T20:00:00.000Z' } as ItemDto;

        const date = datetime.parseISO8601Date(item.StartDate);
        const expected = `${datetime.toLocaleDateString(date, { weekday: 'short', month: 'short', day: 'numeric' })} ${datetime.getDisplayTime(date)}`;
        expect(getAirTimeText(item, true, false)).toBe(expected);
    });

    it('appends the end time when EndDate is set and showAirEndTime is true', () => {
        const item = {
            StartDate: '2026-03-05T20:00:00.000Z',
            EndDate: '2026-03-05T21:00:00.000Z'
        } as ItemDto;

        const startExpected = datetime.getDisplayTime(datetime.parseISO8601Date(item.StartDate));
        const endExpected = datetime.getDisplayTime(datetime.parseISO8601Date(item.EndDate));
        expect(getAirTimeText(item, false, true)).toBe(`${startExpected} - ${endExpected}`);
    });

    it('does not append the end time when showAirEndTime is false', () => {
        const item = {
            StartDate: '2026-03-05T20:00:00.000Z',
            EndDate: '2026-03-05T21:00:00.000Z'
        } as ItemDto;

        const expected = datetime.getDisplayTime(datetime.parseISO8601Date(item.StartDate));
        expect(getAirTimeText(item, false, false)).toBe(expected);
    });
});

describe('getCardLogoUrl()', () => {
    let api: Api;

    beforeAll(() => {
        api = new Jellyfin({
            clientInfo: { name: 'jellyfin-web-codex tests', version: '0.0.0-test' },
            deviceInfo: { name: 'test-runner', id: 'test-runner-id' }
        }).createApi('https://jellyfin.test.invalid');
    });

    it('returns an undefined logoUrl when there is no api instance', () => {
        const item = { ChannelId: 'channel-1', ChannelPrimaryImageTag: 'tag' } as ItemDto;

        expect(getCardLogoUrl(item, undefined, cardOptions({ showChannelLogo: true }))).toEqual({ logoUrl: undefined });
    });

    it('returns an undefined logoUrl when there is no matching tag to render', () => {
        const item = { Id: 'item-1' } as ItemDto;

        expect(getCardLogoUrl(item, api, cardOptions())).toEqual({ logoUrl: undefined });
    });

    it('builds a channel logo URL from the channel primary image when showChannelLogo is set', () => {
        const item = {
            Id: 'item-1',
            ChannelId: 'channel-1',
            ChannelPrimaryImageTag: 'channel-tag'
        } as ItemDto;

        const { logoUrl } = getCardLogoUrl(item, api, cardOptions({ showChannelLogo: true }));

        expect(logoUrl).toContain('/Items/channel-1/Images/Primary');
        expect(logoUrl).toContain('tag=channel-tag');
        expect(logoUrl).toContain('height=40');
    });

    it('builds a parent logo URL from ParentLogoItemId when showLogo is set', () => {
        const item = {
            Id: 'item-1',
            ParentLogoItemId: 'parent-1',
            ParentLogoImageTag: 'parent-tag'
        } as ItemDto;

        const { logoUrl } = getCardLogoUrl(item, api, cardOptions({ showLogo: true }));

        expect(logoUrl).toContain('/Items/parent-1/Images/Logo');
        expect(logoUrl).toContain('tag=parent-tag');
    });

    it('falls back to the item itself when no channel or parent logo item id is set', () => {
        const item = { Id: 'item-1', ParentLogoImageTag: 'parent-tag' } as ItemDto;

        const { logoUrl } = getCardLogoUrl(item, api, cardOptions({ showLogo: true }));

        expect(logoUrl).toContain('/Items/item-1/Images/Logo');
    });

    it('prefers the channel logo over the parent logo when both options are set', () => {
        const item = {
            Id: 'item-1',
            ChannelId: 'channel-1',
            ChannelPrimaryImageTag: 'channel-tag',
            ParentLogoItemId: 'parent-1',
            ParentLogoImageTag: 'parent-tag'
        } as ItemDto;

        const { logoUrl } = getCardLogoUrl(item, api, cardOptions({ showChannelLogo: true, showLogo: true }));

        expect(logoUrl).toContain('/Items/channel-1/Images/Primary');
    });
});
