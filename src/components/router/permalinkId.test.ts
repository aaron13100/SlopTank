import { describe, expect, it } from 'vitest';

import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ExtraType } from '@jellyfin/sdk/lib/generated-client/models/extra-type';

import {
    buildPermalinkHashPath,
    mintExternalPermalinkId,
    parsePermalinkId,
    permalinkStartSecondsToTicks
} from './permalinkId';

describe('parsePermalinkId', () => {
    it('parses every namespace', () => {
        expect(parsePermalinkId('tt3522806')).toEqual({ namespace: 'imdb', id: 'tt3522806' });
        expect(parsePermalinkId('tt0')).toEqual({ namespace: 'imdb', id: 'tt0' });
        expect(parsePermalinkId('tm-tv-4613')).toEqual({
            namespace: 'tmdb',
            qualifier: 'tv',
            numericId: '4613',
            id: 'tm-tv-4613'
        });
        expect(parsePermalinkId('sk-2f3k2m9qbd8x4w1r0ehtyc5vnz')).toEqual({
            namespace: 'sloptank',
            id: 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz'
        });
    });

    it('round trips every tmdb qualifier', () => {
        for (const qualifier of ['mv', 'tv', 'ep', 'se', 'co']) {
            const id = `tm-${qualifier}-4613`;
            expect(parsePermalinkId(id)).toEqual({ namespace: 'tmdb', qualifier, numericId: '4613', id });
        }
    });

    it('rejects leading zeros in numeric ids', () => {
        expect(parsePermalinkId('tm-mv-04613')).toBeNull();
    });

    it('rejects an unqualified tmdb id', () => {
        expect(parsePermalinkId('tm-4613')).toBeNull();
        expect(parsePermalinkId('tm-xx-4613')).toBeNull();
    });

    it('rejects uppercase and malformed sloptank ids', () => {
        expect(parsePermalinkId('SK-2f3k2m9qbd8x4w1r0ehtyc5vnz')).toBeNull();
        expect(parsePermalinkId('sk-tooshort')).toBeNull();
        // Crockford base32 excludes i, l, o, u.
        expect(parsePermalinkId('sk-2f3k2m9qbd8x4w1r0ehtyclvnz')).toBeNull();
    });

    it('rejects reserved namespace prefixes', () => {
        expect(parsePermalinkId('tv-76290')).toBeNull();
        expect(parsePermalinkId('mb-some-id')).toBeNull();
        expect(parsePermalinkId('au-some-id')).toBeNull();
    });

    it('rejects garbage and empty input', () => {
        expect(parsePermalinkId('')).toBeNull();
        expect(parsePermalinkId('not-an-id')).toBeNull();
        expect(parsePermalinkId('ttabc')).toBeNull();
        expect(parsePermalinkId('tt')).toBeNull();
    });
});

describe('mintExternalPermalinkId', () => {
    it('prefers imdb over tmdb', () => {
        const item = {
            Type: BaseItemKind.Movie,
            ProviderIds: { Imdb: 'tt0062622', Tmdb: '62' }
        };
        expect(mintExternalPermalinkId(item)).toBe('tt0062622');
    });

    it('falls back to a type-qualified tmdb id when no imdb id is present', () => {
        const item = {
            Type: BaseItemKind.Series,
            ProviderIds: { Tmdb: '4613' }
        };
        expect(mintExternalPermalinkId(item)).toBe('tm-tv-4613');
    });

    it('qualifies tmdb ids by the item\'s own type, not by provider metadata alone', () => {
        const movie = { Type: BaseItemKind.Movie, ProviderIds: { Tmdb: '4613' } };
        const series = { Type: BaseItemKind.Series, ProviderIds: { Tmdb: '4613' } };
        expect(mintExternalPermalinkId(movie)).toBe('tm-mv-4613');
        expect(mintExternalPermalinkId(series)).toBe('tm-tv-4613');
    });

    it('returns null for a type with no defined tmdb qualifier (e.g. Video)', () => {
        const item = { Type: BaseItemKind.Video, ProviderIds: { Tmdb: '4613' } };
        expect(mintExternalPermalinkId(item)).toBeNull();
    });

    it('returns null for an ineligible type even with a valid imdb id', () => {
        const item = { Type: BaseItemKind.Trailer, ProviderIds: { Imdb: 'tt0062622' } };
        expect(mintExternalPermalinkId(item)).toBeNull();
    });

    it('returns null for an extra even when its own type is eligible', () => {
        const item = { Type: BaseItemKind.Video, ExtraType: ExtraType.Trailer, ProviderIds: { Imdb: 'tt0062622' } };
        expect(mintExternalPermalinkId(item)).toBeNull();
    });

    it('returns null with no provider ids, no item, or no type', () => {
        expect(mintExternalPermalinkId({ Type: BaseItemKind.Movie })).toBeNull();
        expect(mintExternalPermalinkId({ ProviderIds: { Imdb: 'tt1' } })).toBeNull();
        expect(mintExternalPermalinkId(null)).toBeNull();
        expect(mintExternalPermalinkId(undefined)).toBeNull();
    });

    it('never mints from a malformed provider value', () => {
        const item = { Type: BaseItemKind.Movie, ProviderIds: { Imdb: 'not-an-imdb-id' } };
        expect(mintExternalPermalinkId(item)).toBeNull();
    });
});

describe('buildPermalinkHashPath', () => {
    it('builds the info and watch marker paths', () => {
        expect(buildPermalinkHashPath('info', 'tt3522806')).toBe('#/p/tt3522806');
        expect(buildPermalinkHashPath('watch', 'tt3522806')).toBe('#/w/tt3522806');
    });
});

describe('permalinkStartSecondsToTicks', () => {
    it('converts whole seconds to ticks', () => {
        expect(permalinkStartSecondsToTicks('30')).toBe(300000000);
        expect(permalinkStartSecondsToTicks('0')).toBe(0);
    });

    it('rejects anything that is not a plain non-negative integer', () => {
        expect(permalinkStartSecondsToTicks(null)).toBeNull();
        expect(permalinkStartSecondsToTicks(undefined)).toBeNull();
        expect(permalinkStartSecondsToTicks('')).toBeNull();
        expect(permalinkStartSecondsToTicks('-5')).toBeNull();
        expect(permalinkStartSecondsToTicks('5.5')).toBeNull();
        expect(permalinkStartSecondsToTicks('abc')).toBeNull();
        expect(permalinkStartSecondsToTicks('9'.repeat(400))).toBeNull();
    });
});
