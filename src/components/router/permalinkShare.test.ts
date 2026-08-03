import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { buildShareUrl } from './permalinkShare';

/**
 * Tests for the "ensure first, construct second" rule
 * (docs/internal/permalink-url-design.md section 5): every share/copy action
 * asks the server to persist evidence before it builds any URL, and a caller
 * that cannot get a permanent alias still gets a working link, visibly marked
 * temporary and carrying the server's own reason.
 *
 * Only the HTTP transport is mocked, matching permalinkApi.test.ts: the real
 * ensurePermalinkIds call and its error classification run for real.
 */

interface StubRoute {
    status: number
    body?: unknown
}

function createServer(routes: Record<string, StubRoute>) {
    const calls: string[] = [];

    const adapter: AxiosAdapter = (config: AxiosRequestConfig) => {
        const key = `${(config.method ?? 'get').toUpperCase()} ${config.url ?? ''}`;
        calls.push(key);

        const route = routes[key];
        if (!route) {
            return Promise.reject(new AxiosError(`no stub route for ${key}`, 'ENOTFOUND', config as never));
        }

        const response = {
            data: route.body,
            status: route.status,
            statusText: '',
            headers: {},
            config: config as never
        } as AxiosResponse;

        if (route.status >= 200 && route.status < 300) {
            return Promise.resolve(response);
        }

        const error = new AxiosError(
            `Request failed with status code ${route.status}`,
            AxiosError.ERR_BAD_RESPONSE,
            config as never
        );
        error.response = response;
        return Promise.reject(error);
    };

    const api = {
        axiosInstance: axios.create({ adapter }),
        basePath: 'https://media.example',
        authorizationHeader: 'MediaBrowser Token="abc"'
    } as unknown as Api;

    return { api, calls };
}

const ITEM: BaseItemDto = { Id: 'item-1', ServerId: 'server-1' };

describe('buildShareUrl', () => {
    it('ensures the item then builds the pretty info URL from the returned canonical alias', async () => {
        const { api, calls } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 200,
                body: { Version: 1, Ids: [ 'tt0062622' ], CanonicalId: 'tt0062622' }
            }
        });

        const link = await buildShareUrl({ api, origin: 'https://media.example', item: ITEM, kind: 'info' });

        expect(link).toEqual({ status: 'permanent', url: 'https://media.example/tt0062622' });
        expect(calls).toEqual([ 'POST /Items/item-1/Permalink' ]);
    });

    it('builds the pretty watch URL for the watch kind', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 200,
                body: { Version: 1, Ids: [ 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz' ], CanonicalId: 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz' }
            }
        });

        const link = await buildShareUrl({ api, origin: 'https://media.example', item: ITEM, kind: 'watch' });

        expect(link).toEqual({
            status: 'permanent',
            url: 'https://media.example/w/sk-2f3k2m9qbd8x4w1r0ehtyc5vnz'
        });
    });

    it('trims a trailing slash from the configured origin before building the URL', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': { status: 200, body: { CanonicalId: 'tt0062622' } }
        });

        const link = await buildShareUrl({ api, origin: 'https://media.example/', item: ITEM, kind: 'info' });

        expect(link).toEqual({ status: 'permanent', url: 'https://media.example/tt0062622' });
    });

    it('falls back to a temporary legacy link, visibly marked and reasoned, for an empty or read-only item', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 400,
                body: { title: 'permalink-ineligible', detail: 'Item has no readable content root.', status: 400 }
            }
        });

        const link = await buildShareUrl({ api, origin: 'https://media.example', item: ITEM, kind: 'info' });

        expect(link).toEqual({
            status: 'temporary',
            url: 'https://media.example/web/details?id=item-1&serverId=server-1',
            reason: 'permalink-ineligible: Item has no readable content root.'
        });
    });

    it('falls back to a temporary legacy watch link when the server is unreachable', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 503,
                body: { title: 'capsule-unreachable', detail: 'The volume is not mounted.', status: 503 }
            }
        });

        const link = await buildShareUrl({ api, origin: 'https://media.example', item: ITEM, kind: 'watch' });

        expect(link).toEqual({
            status: 'temporary',
            url: 'https://media.example/web/video?id=item-1&serverId=server-1',
            reason: 'capsule-unreachable: The volume is not mounted.'
        });
    });

    it('reports that no link exists for an item with no id, rather than publishing one naming "undefined"', async () => {
        const { api, calls } = createServer({});

        const link = await buildShareUrl({
            api,
            origin: 'https://media.example',
            item: { ServerId: 'server-1' },
            kind: 'info'
        });

        expect(calls).toEqual([]);
        expect(link.status).toBe('unavailable');
        expect(link).not.toHaveProperty('url');
        expect(link.status === 'unavailable' && link.reason).toContain('item-id-missing');
    });

    it('omits serverId from the temporary link when the item reports none, instead of writing "undefined"', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 400,
                body: { title: 'permalink-ineligible', detail: 'No content root.', status: 400 }
            }
        });

        const link = await buildShareUrl({
            api,
            origin: 'https://media.example',
            item: { Id: 'item-1' },
            kind: 'info'
        });

        expect(link).toEqual({
            status: 'temporary',
            url: 'https://media.example/web/details?id=item-1',
            reason: 'permalink-ineligible: No content root.'
        });
    });

    it('percent-encodes an item id carrying URL syntax so the temporary link cannot be reshaped', async () => {
        const { api } = createServer({
            'POST /Items/a%26b%3Dc/Permalink': {
                status: 503,
                body: { title: 'capsule-unreachable', detail: 'Offline.', status: 503 }
            }
        });

        const link = await buildShareUrl({
            api,
            origin: 'https://media.example',
            item: { Id: 'a&b=c', ServerId: 'server-1' },
            kind: 'info'
        });

        expect(link.status === 'temporary' && link.url)
            .toBe('https://media.example/web/details?id=a%26b%3Dc&serverId=server-1');
    });
});
