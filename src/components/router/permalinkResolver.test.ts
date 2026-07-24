import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';

import { parsePermalinkId } from './permalinkId';
import { resolvePermalink } from './permalinkResolver';

// See .claude/mock-allowlist.yaml: this replaces only the network boundary
// to the real Jellyfin server (an external service), not the resolver
// itself. The replacement below is a plain function reading module-scoped
// test state (queryItemsPages/queryItemsCallCount/queryItemsError), not a
// mocking-library spy: resolvePermalink's own pagination loop, discard
// rules, exact-match logic and state selection all run for real against it.
let queryItemsPages: { Items: unknown[], TotalRecordCount: number }[] = [];
let queryItemsCallCount = 0;
let queryItemsError: Error | null = null;

async function queryItemsForTest() {
    queryItemsCallCount += 1;
    if (queryItemsError) throw queryItemsError;
    const page = queryItemsPages[queryItemsCallCount - 1] ?? { Items: [], TotalRecordCount: 0 };
    return { data: page };
}

vi.mock('@jellyfin/sdk/lib/utils/api/items-api', () => ({
    getItemsApi: () => ({ getItems: () => queryItemsForTest() })
}));

/** A stub Api object; permalinkResolver only ever forwards it to getItemsApi(), which is replaced above. */
const stubApi = {} as import('@jellyfin/sdk/lib/api').Api;

function queueSinglePage(items: unknown[], totalRecordCount = items.length) {
    queryItemsPages = [ { Items: items, TotalRecordCount: totalRecordCount } ];
}

function movie(overrides = {}) {
    return {
        Id: 'item-1',
        ServerId: 'server-1',
        Name: '2001: A Space Odyssey',
        Type: BaseItemKind.Movie,
        ProductionYear: 1968,
        ProviderIds: { Imdb: 'tt0062622' },
        ...overrides
    };
}

describe('resolvePermalink', () => {
    beforeEach(() => {
        queryItemsPages = [];
        queryItemsCallCount = 0;
        queryItemsError = null;
    });

    it('returns unsupported for a sloptank id without any network call', async () => {
        queueSinglePage([]);
        const parsed = parsePermalinkId('sk-2f3k2m9qbd8x4w1r0ehtyc5vnz')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result.status).toBe('unsupported');
        expect(queryItemsCallCount).toBe(0);
    });

    it('resolves a single exact imdb match', async () => {
        queueSinglePage([ movie() ]);
        const parsed = parsePermalinkId('tt0062622')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result).toEqual({
            status: 'resolved',
            item: { id: 'item-1', serverId: 'server-1', name: '2001: A Space Odyssey', type: BaseItemKind.Movie, productionYear: 1968 }
        });
    });

    it('is case-insensitive on the stored provider value', async () => {
        queueSinglePage([ movie({ ProviderIds: { Imdb: 'TT0062622' } }) ]);
        const parsed = parsePermalinkId('tt0062622')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result.status).toBe('resolved');
    });

    it('discards a trailer that carries the parent film\'s imdb id instead of treating it as the sole match', async () => {
        queueSinglePage([ movie({ Id: 'trailer-1', Type: BaseItemKind.Trailer, Name: 'Trailer' }) ]);
        const parsed = parsePermalinkId('tt0062622')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result.status).toBe('not-found');
    });

    it('discards an extra even when its own Type is eligible', async () => {
        queueSinglePage([ movie({ Id: 'extra-1', ExtraType: 'Trailer' }) ]);
        const parsed = parsePermalinkId('tt0062622')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result.status).toBe('not-found');
    });

    it('returns not-found when nothing matches', async () => {
        queueSinglePage([]);
        const parsed = parsePermalinkId('tt9999999')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result).toEqual({ status: 'not-found' });
    });

    it('returns every surviving candidate when several items share the same rank', async () => {
        queueSinglePage([
            movie({ Id: 'a' }),
            movie({ Id: 'b', Name: 'A Different Cut' })
        ]);
        const parsed = parsePermalinkId('tt0062622')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result.status).toBe('ambiguous');
        if (result.status === 'ambiguous') {
            expect(result.candidates.map(c => c.id)).toEqual([ 'a', 'b' ]);
        }
    });

    it('never decides from a truncated page: pages until the reported total is exhausted', async () => {
        queryItemsPages = [
            { Items: [ movie({ Id: 'a', ProviderIds: { Imdb: 'tt1111111' } }) ], TotalRecordCount: 2 },
            { Items: [ movie({ Id: 'b' }) ], TotalRecordCount: 2 }
        ];

        const parsed = parsePermalinkId('tt0062622')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(queryItemsCallCount).toBe(2);
        expect(result).toEqual({
            status: 'resolved',
            item: { id: 'b', serverId: 'server-1', name: '2001: A Space Odyssey', type: BaseItemKind.Movie, productionYear: 1968 }
        });
    });

    it('matches a tmdb id only against the item type its qualifier names', async () => {
        queueSinglePage([
            movie({ Id: 'series-1', Type: BaseItemKind.Series, ProviderIds: { Tmdb: '4613' } })
        ]);
        // tm-mv-4613 (movie) must not match a Series carrying the same numeric TMDB id.
        const parsed = parsePermalinkId('tm-mv-4613')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result.status).toBe('not-found');
    });

    it('resolves a correctly type-qualified tmdb id', async () => {
        queueSinglePage([
            movie({ Id: 'series-1', Type: BaseItemKind.Series, ProviderIds: { Tmdb: '4613' } })
        ]);
        const parsed = parsePermalinkId('tm-tv-4613')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result.status).toBe('resolved');
    });

    it('surfaces a transport error instead of silently returning not-found', async () => {
        queryItemsError = new Error('network down');
        const parsed = parsePermalinkId('tt0062622')!;
        const result = await resolvePermalink(stubApi, parsed);

        expect(result).toEqual({ status: 'error', message: 'network down' });
    });
});
