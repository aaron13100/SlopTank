// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-08-11, 2026-09-09.
import axios, { type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { createBrowserHistory, type History } from 'history';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api } from '@jellyfin/sdk/lib/api';

import { appRouter } from './appRouter';
import { canonicalizeLegacyGuidRoute, permalinkCanonicalizationHandoff } from './permalinkCanonicalizer';
import { clearRememberedPermalinkAliases, getRememberedPermalinkAlias } from './permalinkSession';

const USER_ID = 'user-1';

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

/**
 * An API whose ensure call is held open until the test releases it, so the
 * window between "external alias shown" and "durable alias arrives" can be
 * driven deliberately rather than raced.
 *
 * @param canonicalId The durable id the held-open ensure eventually returns.
 * @returns The API and the function that lets its response through.
 */
function createGatedApi(canonicalId: string) {
    let releaseResponse: () => void = () => { /* assigned synchronously below */ };
    const responseGate = new Promise<void>(resolve => {
        releaseResponse = resolve;
    });
    const adapter: AxiosAdapter = async (config: AxiosRequestConfig) => {
        await responseGate;
        return {
            data: { CanonicalId: canonicalId },
            status: 200,
            statusText: '',
            headers: {},
            config: config as never
        } as AxiosResponse;
    };

    return {
        api: {
            axiosInstance: axios.create({ adapter }),
            basePath: 'https://media.example',
            authorizationHeader: 'MediaBrowser Token="abc"'
        } as unknown as Api,
        releaseResponse
    };
}

/**
 * A real history driving the real appRouter, attached through the seam its
 * own JSDoc names for this ("tests pass a memory history here directly").
 *
 * The point of these tests after 2026-08-11 is that canonicalization is a
 * router transition rather than a raw window.history write, so replacing the
 * router with a double would delete the property under test. What the router
 * then does with the transition -- matching the permalink route, applying the
 * basename, re-rendering -- is React Router's own behaviour and is covered end
 * to end by e2e/video-permalink.spec.ts against the real deployment.
 */
let history: History;
let rewrites: Array<{ path: string, state: unknown }>;
let unlisten: () => void;

beforeEach(() => {
    window.history.replaceState(null, '', '/');
    history = createBrowserHistory();
    appRouter.initialize(history);
    rewrites = [];
    unlisten = history.listen(({ location }) => {
        rewrites.push({ path: location.pathname + location.search, state: location.state });
    });
});

afterEach(() => {
    unlisten();
    clearRememberedPermalinkAliases();
    document.querySelector('base')?.remove();
    window.history.replaceState(null, '', '/');
});

describe('canonicalizeLegacyGuidRoute', () => {
    it('rewrites a loaded details GUID through the router, carrying the view it came from', async () => {
        const { api, calls } = createApi();
        history.replace('/web/details?id=item-1&serverId=server-1');
        rewrites.length = 0;

        await expect(canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'info',
            userId: USER_ID
        })).resolves.toBe(true);

        expect(rewrites).toHaveLength(1);
        expect(rewrites[0].path).toBe('/tt0062622');
        // The handoff is what stops the destination route rebuilding the view
        // and re-redeeming a single-use lease for an alias just minted here.
        expect(rewrites[0].state).toEqual({
            canonicalizedFrom: '/web/details',
            permalinkTarget: {
                permalinkId: 'tt0062622',
                itemId: 'item-1',
                serverId: 'server-1',
                userId: USER_ID
            }
        });
        expect(calls).toEqual([ 'POST /Items/item-1/Permalink' ]);
        expect(getRememberedPermalinkAlias('server-1', 'item-1')).toBe('tt0062622');
    });

    it('emits base-relative paths under a configured BaseUrl', async () => {
        const base = document.createElement('base');
        base.href = '/sloptank/web/';
        document.head.prepend(base);
        const { api } = createApi('sk-2f3k2m9qbd8x4w1r0ehtyc5vnz');
        history.replace('/sloptank/web/video?id=item-1&serverId=server-1&t=0');
        rewrites.length = 0;

        await canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'watch',
            userId: USER_ID
        });

        // Both halves must be base-RELATIVE. The router is created with
        // `basename: getDeploymentBasePath()` and prepends it itself, so
        // including it here would produce /sloptank/sloptank/w/...
        expect(rewrites[0].path).toBe('/w/sk-2f3k2m9qbd8x4w1r0ehtyc5vnz?t=0');
        expect((rewrites[0].state as { canonicalizedFrom: string }).canonicalizedFrom).toBe('/web/video');
    });

    it('shows a safe external URL before durable ensure finishes', async () => {
        // A durable id distinct from the external alias, so both rewrites are
        // observable. When the server's canonical id happens to equal the
        // external one the second rewrite is correctly a no-op.
        const { api, releaseResponse } = createGatedApi('sk-2f3k2m9qbd8x4w1r0ehtyc5vnz');
        history.replace('/web/details?id=season-2&serverId=server-1');
        rewrites.length = 0;

        const canonicalizing = canonicalizeLegacyGuidRoute({
            api,
            item: {
                Id: 'season-2',
                ServerId: 'server-1',
                Type: 'Season',
                ProviderIds: { Tvdb: '2043488' }
            },
            kind: 'info',
            userId: USER_ID
        });

        expect(window.location.pathname).toBe('/tv-se-2043488');
        expect(getRememberedPermalinkAlias('server-1', 'season-2')).toBe('tv-se-2043488');
        releaseResponse();
        await expect(canonicalizing).resolves.toBe(true);

        // The second rewrite starts from the external alias already on screen,
        // not from the original GUID route, or the destination route would
        // decline to recognise the view and would rebuild it mid-playback.
        expect(rewrites).toHaveLength(2);
        expect(rewrites[1].path).toBe('/sk-2f3k2m9qbd8x4w1r0ehtyc5vnz');
        expect((rewrites[1].state as { canonicalizedFrom: string }).canonicalizedFrom).toBe('/tv-se-2043488');
    });

    it('does not ensure an item that is already on a canonical route', async () => {
        const { api, calls } = createApi();
        history.replace('/tt0062622');
        rewrites.length = 0;

        await expect(canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'info',
            userId: USER_ID
        })).resolves.toBe(false);

        expect(calls).toEqual([]);
        expect(rewrites).toEqual([]);
    });

    it('does not let a late ensure completion replace a newer route', async () => {
        const { api, releaseResponse } = createGatedApi('tt0062622');
        history.replace('/web/details?id=item-1');

        const canonicalizing = canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'info',
            userId: USER_ID
        });
        history.replace('/web/video?id=item-1');
        rewrites.length = 0;
        releaseResponse();

        await expect(canonicalizing).resolves.toBe(false);
        expect(window.location.pathname).toBe('/web/video');
        expect(rewrites).toEqual([]);
    });

    it('does not label a different item with the alias it was minting', async () => {
        const { api, releaseResponse } = createGatedApi('tt0062622');
        history.replace('/web/video?id=item-1&serverId=server-1');

        const canonicalizing = canonicalizeLegacyGuidRoute({
            api,
            item: { Id: 'item-1', ServerId: 'server-1' },
            kind: 'watch',
            userId: USER_ID
        });
        // Same pathname, different item. The guard has to be about content,
        // not about the route shape, or item 2 gets item 1's alias.
        history.replace('/web/video?id=item-2&serverId=server-1');
        rewrites.length = 0;
        releaseResponse();

        await expect(canonicalizing).resolves.toBe(false);
        expect(rewrites).toEqual([]);
    });
});

describe('permalinkCanonicalizationHandoff', () => {
    const state = {
        canonicalizedFrom: '/web/video',
        permalinkTarget: {
            permalinkId: 'tt0062622',
            itemId: 'item-1',
            serverId: 'server-1',
            userId: USER_ID
        }
    };

    it('returns the item this process just minted the alias for', () => {
        expect(permalinkCanonicalizationHandoff(state, 'tt0062622', 'server-1', USER_ID))
            .toEqual({ itemId: 'item-1', serverId: 'server-1' });
    });

    it('declines a handoff for a different alias', () => {
        expect(permalinkCanonicalizationHandoff(state, 'tt0181689', 'server-1', USER_ID))
            .toBeUndefined();
    });

    it('declines a handoff left behind by another user', () => {
        // History state survives a reload and a sign-out, so the viewer is
        // re-checked rather than inherited.
        expect(permalinkCanonicalizationHandoff(state, 'tt0062622', 'server-1', 'user-2'))
            .toBeUndefined();
    });

    it('declines a handoff from another server', () => {
        expect(permalinkCanonicalizationHandoff(state, 'tt0062622', 'server-2', USER_ID))
            .toBeUndefined();
    });

    it('declines an absent or foreign state so the server resolves the alias', () => {
        expect(permalinkCanonicalizationHandoff(null, 'tt0062622', 'server-1', USER_ID)).toBeUndefined();
        expect(permalinkCanonicalizationHandoff({ usr: 'nonsense' }, 'tt0062622', 'server-1', USER_ID))
            .toBeUndefined();
    });

    it('declines when no user is signed in', () => {
        expect(permalinkCanonicalizationHandoff(state, 'tt0062622', 'server-1', undefined))
            .toBeUndefined();
    });
});
