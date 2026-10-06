// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * Unit coverage for the watchlist ApiClient module: every surface must talk
 * to exactly the endpoint the server defines, pass the owning user's id, and
 * answer honestly on failure instead of quietly resolving.
 *
 * The ApiClient is the module's DI seam, so the tests construct a real
 * in-memory client: a working URL builder and a working route table that
 * resolves and rejects like the transport does. No assumptions are frozen
 * behind vi.fn(); the client either serves the route or fails the request.
 */

import { describe, expect, it } from 'vitest';

import {
    addToWatchlist,
    getWatchlist,
    isInWatchlist,
    removeFromWatchlist,
    WatchlistResponseMismatchError
} from './watchlist';

type RouteHandler = (path: string, query: URLSearchParams) => { status: number; body?: unknown };

/**
 * A real (in-memory) ApiClient: builds real URLs the same way
 * jellyfin-apiclient does and dispatches ajax/getJSON through a route table
 * whose handlers run real logic. Routes that are not registered fail the
 * request the way an unreachable endpoint would.
 */
class InMemoryApiClient {
    private readonly routes = new Map<string, RouteHandler>();

    /**
     * Registers a handler for one method + path prefix.
     *
     * @param method - HTTP method.
     * @param pathPrefix - URL path below the server root.
     * @param handler - The serving logic.
     */
    on(method: string, pathPrefix: string, handler: RouteHandler): void {
        this.routes.set(`${method} ${pathPrefix}`, handler);
    }

    /**
     * Builds the absolute URL for a relative API path.
     *
     * @param path - Relative API path.
     * @param query - Query parameters.
     * @returns The absolute URL.
     */
    getUrl(path: string, query?: Record<string, unknown>): string {
        const search = query ?
            '?' + new URLSearchParams(
                Object.entries(query).map(([key, value]) => [key, String(value)])
            ).toString() :
            '';
        return `http://server.test/${path}${search}`;
    }

    private dispatch(method: string, url: string): Promise<unknown> {
        const parsed = new URL(url);
        const handler = [...this.routes.entries()]
            .find(([key]) => {
                const [routeMethod, routePath] = key.split(' ');
                return routeMethod === method && parsed.pathname === `/${routePath}`;
            })?.[1];
        if (!handler) {
            return Promise.reject(new Error(`${method} ${parsed.pathname}: no such endpoint (404)`));
        }

        const result = handler(parsed.pathname, parsed.searchParams);
        if (result.status >= 400) {
            return Promise.reject(new Error(`${result.status}`));
        }

        return Promise.resolve(result.body ?? '');
    }

    /**
     * Performs a non-JSON request like the real client's ajax().
     *
     * @param options - Method and URL.
     * @returns A promise resolving with the raw body.
     */
    ajax(options: { type: string; url: string }): Promise<unknown> {
        return this.dispatch(options.type.toUpperCase(), options.url);
    }

    /**
     * Performs a JSON GET like the real client's getJSON().
     *
     * @param url - The absolute URL.
     * @returns A promise resolving with the parsed body.
     */
    getJSON(url: string): Promise<unknown> {
        return this.dispatch('GET', url);
    }
}

describe('watchlist api module', () => {
    const userId = 'user-1';
    const itemId = 'item-1';

    it('add posts to the owning user watchlist route', async () => {
        const client = new InMemoryApiClient();
        const added: string[] = [];
        client.on('POST', `Users/${userId}/Items/${itemId}/Watchlist`, () => {
            added.push(itemId);
            return { status: 204 };
        });

        await addToWatchlist(client, userId, itemId);

        expect(added).toEqual([itemId]);
    });

    it('remove deletes from the owning user watchlist route', async () => {
        const client = new InMemoryApiClient();
        let removed = 0;
        client.on('DELETE', `Users/${userId}/Items/${itemId}/Watchlist`, () => {
            removed++;
            return { status: 204 };
        });

        await removeFromWatchlist(client, userId, itemId);

        expect(removed).toBe(1);
    });

    it('a rejected request propagates instead of resolving as success', async () => {
        const client = new InMemoryApiClient();

        // No route registered: the request fails like a missing endpoint.
        await expect(addToWatchlist(client, userId, itemId)).rejects.toThrow('404');
    });

    it('contains maps the membership answer', async () => {
        const client = new InMemoryApiClient();
        client.on('GET', `Users/${userId}/Items/Watchlist/Contains`, (path, query) => {
            expect(query.get('itemId')).toBe(itemId);
            return { status: 200, body: { ItemId: itemId, IsInWatchlist: true } };
        });

        await expect(isInWatchlist(client, userId, itemId)).resolves.toBe(true);
    });

    it('contains refuses an answer about another item', async () => {
        const client = new InMemoryApiClient();
        client.on('GET', `Users/${userId}/Items/Watchlist/Contains`, () => ({
            status: 200,
            body: { ItemId: 'item-2', IsInWatchlist: true }
        }));

        try {
            await isInWatchlist(client, userId, itemId);
            expect.unreachable('mismatched answer must throw');
        } catch (error) {
            expect(error).toBeInstanceOf(WatchlistResponseMismatchError);
            expect((error as WatchlistResponseMismatchError).code).toBe('WATCHLIST_RESPONSE_MISMATCH');
            expect((error as WatchlistResponseMismatchError).cause).toEqual({ answeredItemId: 'item-2' });
        }
    });

    it('a failed contains check propagates instead of reporting false', async () => {
        const client = new InMemoryApiClient();

        await expect(isInWatchlist(client, userId, itemId)).rejects.toThrow('404');
    });

    it('get returns the paged result with an honest total', async () => {
        const client = new InMemoryApiClient();
        client.on('GET', `Users/${userId}/Items/Watchlist`, (path, query) => {
            expect(query.get('startIndex')).toBe('10');
            expect(query.get('limit')).toBe('2');
            expect(query.get('sortOrder')).toBe('Descending');
            return {
                status: 200,
                body: {
                    Items: [{ Id: 'a' }, { Id: 'b' }],
                    TotalRecordCount: 7,
                    StartIndex: 10
                }
            };
        });

        const result = await getWatchlist(client, userId, {
            startIndex: 10,
            limit: 2,
            sortOrder: 'Descending'
        });

        expect(result.Items.map(item => item.Id)).toEqual(['a', 'b']);
        expect(result.TotalRecordCount).toBe(7);
        expect(result.StartIndex).toBe(10);
    });

    it('get tolerates a body without optional members instead of crashing the view', async () => {
        const client = new InMemoryApiClient();
        client.on('GET', `Users/${userId}/Items/Watchlist`, () => ({ status: 200, body: {} }));

        const result = await getWatchlist(client, userId);

        expect(result.Items).toEqual([]);
        expect(result.TotalRecordCount).toBe(0);
        expect(result.StartIndex).toBe(0);
    });
});
