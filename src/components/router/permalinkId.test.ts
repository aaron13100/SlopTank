// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-07-31, 2026-08-03, 2026-09-02, 2026-09-09.
import { describe, expect, it } from 'vitest';

import {
    buildPermalinkPath,
    buildPermalinkShareUrl,
    getExternalPermalinkId,
    isPermalinkResolutionPath,
    parsePermalinkId,
    permalinkStartSecondsToTicks
} from './permalinkId';
import grammar from './permalink-grammar-v1.json';

describe('parsePermalinkId', () => {
    it('conforms to the versioned cross-stack grammar vectors', () => {
        expect(grammar.version).toBe(1);
        for (const id of grammar.valid) expect(parsePermalinkId(id)).not.toBeNull();
        for (const id of [ ...grammar.invalid, ...grammar.reserved ]) {
            expect(parsePermalinkId(id)).toBeNull();
        }
    });

    it('parses every namespace', () => {
        expect(parsePermalinkId('tt3522806')).toEqual({ namespace: 'imdb', id: 'tt3522806' });
        expect(parsePermalinkId('tt0')).toEqual({ namespace: 'imdb', id: 'tt0' });
        expect(parsePermalinkId('tm-tv-4613')).toEqual({
            namespace: 'tmdb',
            qualifier: 'tv',
            numericId: '4613',
            id: 'tm-tv-4613'
        });
        expect(parsePermalinkId('tv-se-2043488')).toEqual({
            namespace: 'tvdb',
            qualifier: 'se',
            numericId: '2043488',
            id: 'tv-se-2043488'
        });
        expect(parsePermalinkId('sk-2f3k2m9qbd8x4w1r0ehtyc5vnz')).toEqual({
            namespace: 'sloptank',
            id: 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz'
        });
    });

    it('round trips every qualified numeric provider namespace', () => {
        for (const namespace of [ 'tm', 'tv' ]) {
            for (const qualifier of [ 'mv', 'tv', 'ep', 'se', 'co' ]) {
                const id = `${namespace}-${qualifier}-4613`;
                expect(parsePermalinkId(id)).toEqual({
                    namespace: namespace === 'tm' ? 'tmdb' : 'tvdb',
                    qualifier,
                    numericId: '4613',
                    id
                });
            }
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

describe('getExternalPermalinkId', () => {
    it('matches the server election order and qualifies numeric namespaces', () => {
        expect(getExternalPermalinkId({
            Type: 'Series',
            ProviderIds: { Imdb: 'tt14531842', Tmdb: '47907', Tvdb: '401147' }
        })).toBe('tt14531842');
        expect(getExternalPermalinkId({
            Type: 'Season',
            ProviderIds: { Tvdb: '2043488' }
        })).toBe('tv-se-2043488');
        expect(getExternalPermalinkId({
            Type: 'Episode',
            ProviderIds: { Tmdb: '1234', Tvdb: '10285912' }
        })).toBe('tm-ep-1234');
    });

    it('refuses malformed ids and unsupported item types', () => {
        expect(getExternalPermalinkId({ Type: 'Season', ProviderIds: { Tvdb: '01' } })).toBeNull();
        expect(getExternalPermalinkId({ Type: 'Audio', ProviderIds: { Tvdb: '42' } })).toBeNull();
    });
});

describe('buildPermalinkShareUrl', () => {
    it('builds the pasteable pretty entry URL for each kind', () => {
        expect(buildPermalinkShareUrl('https://media.example', 'info', 'tt3522806'))
            .toBe('https://media.example/tt3522806');
        expect(buildPermalinkShareUrl('https://media.example', 'watch', 'tm-mv-4613'))
            .toBe('https://media.example/w/tm-mv-4613');
    });

    it('never doubles the separator when the origin carries trailing slashes', () => {
        expect(buildPermalinkShareUrl('https://media.example//', 'info', 'tt3522806'))
            .toBe('https://media.example/tt3522806');
    });

    it('round trips its own output back through the parser', () => {
        const id = 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz';
        const url = buildPermalinkShareUrl('https://media.example', 'watch', id);

        expect(parsePermalinkId(url.split('/').pop() ?? '')).toEqual({ namespace: 'sloptank', id });
    });
});

describe('buildPermalinkPath', () => {
    it('builds the canonical root info and watch paths', () => {
        expect(buildPermalinkPath('info', 'tt3522806')).toBe('/tt3522806');
        expect(buildPermalinkPath('watch', 'tt3522806')).toBe('/w/tt3522806');
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

describe('isPermalinkResolutionPath', () => {
    it('recognises a permalink route in every shape the address bar produces', () => {
        expect(isPermalinkResolutionPath('/w/tt35231039')).toBe(true);
        expect(isPermalinkResolutionPath('/p/tt35231039')).toBe(true);
        expect(isPermalinkResolutionPath('/web/w/tt35231039')).toBe(true);
        expect(isPermalinkResolutionPath('/deploy-base/web/w/tt35231039')).toBe(true);
        expect(isPermalinkResolutionPath('/w/sk-2f3k2m9qbd8x4w1r0ehtyc5vnz')).toBe(true);
        expect(isPermalinkResolutionPath('/w/tm-mv-12345')).toBe(true);
    });

    it('does not claim a route that merely looks like one', () => {
        // The negative control that matters: gating navigation data on this
        // predicate means a false positive silently strips the chrome from a
        // real page, which is worse than the latency it was added to fix.
        expect(isPermalinkResolutionPath('/web/video?id=abc')).toBe(false);
        expect(isPermalinkResolutionPath('/web/details?id=abc')).toBe(false);
        expect(isPermalinkResolutionPath('/web/index.html')).toBe(false);
        expect(isPermalinkResolutionPath('/')).toBe(false);
        expect(isPermalinkResolutionPath('')).toBe(false);
        // A marker segment with nothing usable after it is not a permalink.
        expect(isPermalinkResolutionPath('/w/')).toBe(false);
        expect(isPermalinkResolutionPath('/w/not-an-id')).toBe(false);
        // Reserved namespaces never resolve, so they are not a permalink route.
        expect(isPermalinkResolutionPath('/w/mb-1234')).toBe(false);
    });
});
