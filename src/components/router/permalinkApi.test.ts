// SlopTank modification notice: added or changed by SlopTank on 2026-07-31, 2026-09-09.
import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import type { Api } from '@jellyfin/sdk/lib/api';

import {
    PermalinkRequestError,
    ensurePermalinkIds,
    isPermalinkRequestError
} from './permalinkApi';

/**
 * Wire-contract tests for the permalink data-access boundary.
 *
 * Nothing here is mocked with a spy library: the module runs against a real
 * axios instance whose transport adapter is the Jellyfin server (an external
 * service, and the one seam the mocking policy allows). The adapter answers
 * with status codes and `ProblemDetails` bodies the permalink endpoints emit, so the
 * whole axios request/response/error pipeline this module depends on runs for
 * real -- including how a non-2xx surfaces as a rejected promise carrying
 * `error.response`, which is what the module's failure classification reads.
 */

interface StubRoute {
    status: number
    body?: unknown
    /** Milliseconds to wait before answering, so an abort can land mid-flight. */
    delayMs?: number
}

interface RecordedCall {
    method: string
    url: string
    params?: Record<string, string>
    body?: unknown
    authorization?: string
}

function createServer(routes: Record<string, StubRoute>) {
    const calls: RecordedCall[] = [];

    const adapter: AxiosAdapter = (config: AxiosRequestConfig) => {
        const method = (config.method ?? 'get').toUpperCase();
        const url = config.url ?? '';
        calls.push({
            method,
            url,
            params: config.params as Record<string, string> | undefined,
            body: config.data ? JSON.parse(String(config.data)) : undefined,
            authorization: (config.headers as Record<string, string> | undefined)?.Authorization
        });

        const route = routes[`${method} ${url}`];
        if (!route) {
            return Promise.reject(new AxiosError(`no stub route for ${method} ${url}`, 'ENOTFOUND', config as never));
        }

        return new Promise<AxiosResponse>((resolve, reject) => {
            const answer = () => {
                const response = {
                    data: route.body,
                    status: route.status,
                    statusText: '',
                    headers: {},
                    config: config as never
                } as AxiosResponse;

                if (route.status >= 200 && route.status < 300) {
                    resolve(response);
                    return;
                }

                const error = new AxiosError(
                    `Request failed with status code ${route.status}`,
                    AxiosError.ERR_BAD_RESPONSE,
                    config as never
                );
                error.response = response;
                reject(error);
            };

            if (config.signal) {
                const signal = config.signal as AbortSignal;
                if (signal.aborted) {
                    reject(new AxiosError('canceled', AxiosError.ERR_CANCELED, config as never));
                    return;
                }
                signal.addEventListener('abort', () => {
                    reject(new AxiosError('canceled', AxiosError.ERR_CANCELED, config as never));
                });
            }

            if (route.delayMs) {
                setTimeout(answer, route.delayMs);
            } else {
                answer();
            }
        });
    };

    const api = {
        axiosInstance: axios.create({ adapter }),
        basePath: 'https://media.example/jellyfin',
        authorizationHeader: 'MediaBrowser Token="abc"'
    } as unknown as Api;

    return { api, calls };
}

describe('typed-failure discrimination', () => {
    /**
     * Regression for a production-only defect: this app compiles to ES5 for a
     * browserslist that still names Chrome 27, where `class ... extends Error`
     * is downlevelled to a form whose instances no longer carry the subclass on
     * their prototype chain. Every `instanceof PermalinkRequestError` therefore
     * reported false in the shipped bundle only, collapsing typed server
     * failures into one generic "could not resolve" state. Vitest does not
     * downlevel, so the condition is reproduced here explicitly.
     */
    it('recognises a permalink failure whose prototype chain the bundle dropped', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 409,
                body: {
                    title: 'permalink-conflict',
                    detail: 'The permalink request conflicted with current library state.',
                    status: 409
                }
            }
        });

        const error = await ensurePermalinkIds({ api, itemId: 'item-1' })
            .catch((thrown: unknown) => thrown) as PermalinkRequestError;
        Object.setPrototypeOf(error, Error.prototype);

        expect(error instanceof PermalinkRequestError).toBe(false);
        expect(isPermalinkRequestError(error)).toBe(true);
        expect(error.code).toBe('permalink-conflict');
        expect(error.kind).toBe('conflict');
    });

    it('does not mistake an unrelated error for a permalink failure', () => {
        expect(isPermalinkRequestError(new Error('network down'))).toBe(false);
        expect(isPermalinkRequestError({ code: 'permalink-conflict' })).toBe(false);
        expect(isPermalinkRequestError(null)).toBe(false);
        expect(isPermalinkRequestError(undefined)).toBe(false);
        expect(isPermalinkRequestError('permalink-conflict')).toBe(false);
    });
});

describe('ensurePermalinkIds', () => {
    it('posts ensure for the item and returns the ordered alias set', async () => {
        const { api, calls } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 200,
                body: { Version: 1, Ids: [ 'tt0062622', 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz' ], CanonicalId: 'tt0062622' }
            }
        });

        const aliases = await ensurePermalinkIds({ api, itemId: 'item-1' });

        expect(aliases).toEqual({
            version: 1,
            ids: [ 'tt0062622', 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz' ],
            canonicalId: 'tt0062622'
        });
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toBe('/Items/item-1/Permalink');
    });

    it('falls back to the first alias when the server sends ids without an explicit canonical', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': { status: 200, body: { Ids: [ 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz' ] } }
        });

        const aliases = await ensurePermalinkIds({ api, itemId: 'item-1' });

        expect(aliases.canonicalId).toBe('sk-2f3k2m9qbd8x4w1r0ehtyc5vnz');
    });

    it('fails rather than build a URL when the server persisted no alias at all', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': { status: 200, body: { Version: 1, Ids: [] } }
        });

        const error = await ensurePermalinkIds({ api, itemId: 'item-1' })
            .catch((thrown: unknown) => thrown) as PermalinkRequestError;

        expect(error.code).toBe('alias-set-empty');
    });

    it('keeps a 400 ineligible refusal typed, so a caller can say why the link is temporary', async () => {
        const { api } = createServer({
            'POST /Items/item-1/Permalink': {
                status: 400,
                body: { title: 'permalink-ineligible', detail: 'Item has no readable content root.', status: 400 }
            }
        });

        const error = await ensurePermalinkIds({ api, itemId: 'item-1' })
            .catch((thrown: unknown) => thrown) as PermalinkRequestError;

        expect(error.kind).toBe('ineligible');
        expect(error.code).toBe('permalink-ineligible');
        expect(error.message).toBe('Item has no readable content root.');
    });
});
