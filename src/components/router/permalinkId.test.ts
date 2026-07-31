import { describe, expect, it } from 'vitest';

import {
    buildPermalinkHashPath,
    buildPermalinkShareUrl,
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

// The client used to mint an external id from an item's own ProviderIds here.
// That is gone on purpose: an alias the server has not bound to durable
// evidence does not resolve, so publishing one ships a dead link. Choosing the
// id is now `POST /Items/{id}/Permalink` (permalinkApi.ts), exercised through
// the real copy/share entry point in itemContextMenu.permalink.test.js, and
// this module only shapes the URL around whatever alias came back.

describe('buildPermalinkShareUrl', () => {
    it('builds the pasteable pretty entry URL for each kind', () => {
        expect(buildPermalinkShareUrl('https://media.example', 'info', 'tt3522806'))
            .toBe('https://media.example/web/p/tt3522806');
        expect(buildPermalinkShareUrl('https://media.example', 'watch', 'tm-mv-4613'))
            .toBe('https://media.example/web/w/tm-mv-4613');
    });

    it('never doubles the separator when the origin carries trailing slashes', () => {
        expect(buildPermalinkShareUrl('https://media.example//', 'info', 'tt3522806'))
            .toBe('https://media.example/web/p/tt3522806');
    });

    it('round trips its own output back through the parser', () => {
        const id = 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz';
        const url = buildPermalinkShareUrl('https://media.example', 'watch', id);

        expect(parsePermalinkId(url.split('/').pop() ?? '')).toEqual({ namespace: 'sloptank', id });
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
