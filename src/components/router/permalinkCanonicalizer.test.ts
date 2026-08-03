import axios, { type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it } from 'vitest';

import type { Api } from '@jellyfin/sdk/lib/api';

import { canonicalizeLegacyGuidRoute } from './permalinkCanonicalizer';
import { clearRememberedPermalinkAliases, getRememberedPermalinkAlias } from './permalinkSession';

function createApi(canonicalId = 'tt0062622') {
    const calls: string[] = [];
    const adapter: AxiosAdapter = (config: AxiosRequestConfig) => {
        calls.push(`${(config.method ?? 'get').toUpperCase()} ${config.url ?? ''}`);
        return Promise.resolve({
            data: { CanonicalId: canonicalId },
            status: 200,
            statusText: '',
            headers: {},
            config: config as never
        } as AxiosResponse);
    };

    return {
        api: {
            axiosInstance: axios.create({ adapter }),
            basePath: 'https://media.example',
            authorizationHeader: 'MediaBrowser Token="abc"'
        } as unknown as Api,
        calls
    };
}

afterEach(() => {
    clearRememberedPermalinkAliases();
    document.querySelector('base')?.remove();
    window.history.replaceState(null, '', '/');
});

describe('canonicalizeLegacyGuidRoute', () => {
    it('replaces a loaded details GUID without dispatching a navigation', async () => {
        const { api, calls } = createApi();
        window.history.replaceState({ retained: true }, '', '/web/details?id=item-1&serverId=server-1');
        const navigationEvents: Event[] = [];
        const recordNavigation = (event: Event) => navigationEvents.push(event);
        window.addEventListener('hashchange', recordNavigation);
        window.addEventListener('popstate', recordNavigation);

        try {
            await expect(canonicalizeLegacyGuidRoute({
                api,
                item: { Id: 'item-1', ServerId: 'server-1' },
                kind: 'info'
            })).resolves.toBe(true);
        } finally {
            window.removeEventListener('hashchange', recordNavigation);
            window.removeEventListener('popstate', recordNavigation);
        }

        expect(window.location.pathname).toBe('/tt0062622');
        expect(window.location.search).toBe('');
        expect(window.history.state).toEqual({ retained: true });
        expect(navigationEvents).toEqual([]);
        expect(calls).toEqual([ 'POST /Items/item-1/Permalink' ]);
        expect(getRememberedPermalinkAlias('server-1', 'item-1')).toBe('tt0062622');
    });

    it('preserves a valid watch offset and the configured BaseUrl', async () => {
        const base = document.createElement('base');
        base.href = '/sloptank/web/';
        document.head.prepend(base);
        const { api } = createApi('sk-2f3k2m9qbd8x4w1r0ehtyc5vnz');
        window.history.replaceState(null, '', '/sloptank/web/video?id=item-1&serverId=server-1&t=0');

        await canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'watch'
        });

        expect(`${window.location.pathname}${window.location.search}`)
            .toBe('/sloptank/w/sk-2f3k2m9qbd8x4w1r0ehtyc5vnz?t=0');
    });

    it('does not ensure an item that is already on a canonical route', async () => {
        const { api, calls } = createApi();
        window.history.replaceState(null, '', '/tt0062622');

        await expect(canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'info'
        })).resolves.toBe(false);

        expect(calls).toEqual([]);
    });

    it('does not let a late ensure completion replace a newer route', async () => {
        let releaseResponse: (() => void) | undefined;
        const responseGate = new Promise<void>(resolve => {
            releaseResponse = resolve;
        });
        const adapter: AxiosAdapter = async (config: AxiosRequestConfig) => {
            await responseGate;
            return {
                data: { CanonicalId: 'tt0062622' },
                status: 200,
                statusText: '',
                headers: {},
                config: config as never
            } as AxiosResponse;
        };
        const api = {
            axiosInstance: axios.create({ adapter }),
            basePath: 'https://media.example',
            authorizationHeader: 'MediaBrowser Token="abc"'
        } as unknown as Api;
        window.history.replaceState(null, '', '/web/details?id=item-1');

        const canonicalizing = canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'info'
        });
        window.history.replaceState(null, '', '/web/video?id=item-1');
        releaseResponse?.();

        await expect(canonicalizing).resolves.toBe(false);
        expect(window.location.pathname).toBe('/web/video');
    });
});
