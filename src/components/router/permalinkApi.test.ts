// SlopTank modification notice: added or changed by SlopTank on 2026-07-31, 2026-09-09.
import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import type { Api } from '@jellyfin/sdk/lib/api';

import {
    PermalinkRequestError,
    discoverPermalinkCandidates,
    ensurePermalinkIds,
    exchangePermalinkPlaybackLease,
    isPermalinkRequestError,
    redeemPermalinkDetails,
    redeemPermalinkPlayback
} from './permalinkApi';

/**
 * Wire-contract tests for the permalink data-access boundary.
 *
 * Nothing here is mocked with a spy library: the module runs against a real
 * axios instance whose transport adapter is the Jellyfin server (an external
 * service, and the one seam the mocking policy allows). The adapter answers
 * with the exact status codes and `ProblemDetails` bodies
 * Jellyfin.Api/Controllers/PermalinkResolutionController.cs emits, so the
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

const CANDIDATE = { Rank: 0, Namespace: 'external', Handle: 'handle-1', Lease: 'lease-1' };

describe('discoverPermalinkCandidates', () => {
    it('asks the protected endpoint for the requested purpose and returns every verified candidate', async () => {
        const { api, calls } = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 200,
                body: { Items: [ CANDIDATE ], TotalRecordCount: 1 }
            }
        });

        const candidates = await discoverPermalinkCandidates({ api, permalinkId: 'tt0062622', purpose: 'details' });

        expect(candidates).toEqual([ { rank: 0, namespace: 'external', handle: 'handle-1', lease: 'lease-1' } ]);
        expect(calls).toHaveLength(1);
        expect(calls[0].params).toEqual({ purpose: 'details' });
        expect(calls[0].authorization).toBe('MediaBrowser Token="abc"');
    });

    it('percent-encodes the id so a hostile segment cannot reshape the request path', async () => {
        const { api, calls } = createServer({
            'GET /Permalinks/tt1%2F..%2FUsers/Items': { status: 200, body: { Items: [], TotalRecordCount: 0 } }
        });

        await discoverPermalinkCandidates({ api, permalinkId: 'tt1/../Users', purpose: 'details' });

        expect(calls[0].url).toBe('/Permalinks/tt1%2F..%2FUsers/Items');
    });

    it('refuses to decide from a truncated candidate set rather than returning the rows it got', async () => {
        const { api } = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 200,
                body: { Items: [ CANDIDATE ], TotalRecordCount: 4 }
            }
        });

        const error = await discoverPermalinkCandidates({ api, permalinkId: 'tt0062622', purpose: 'details' })
            .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(PermalinkRequestError);
        expect((error as PermalinkRequestError).code).toBe('candidate-set-truncated');
        expect((error as PermalinkRequestError).message).toContain('counted 4');
    });

    it('rejects a candidate missing its lease instead of resolving something unredeemable', async () => {
        const { api } = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 200,
                body: { Items: [ { Rank: 0, Namespace: 'external', Handle: 'handle-1' } ], TotalRecordCount: 1 }
            }
        });

        const error = await discoverPermalinkCandidates({ api, permalinkId: 'tt0062622', purpose: 'details' })
            .catch((thrown: unknown) => thrown);

        expect((error as PermalinkRequestError).code).toBe('candidate-envelope-incomplete');
    });

    it.each([
        { status: 409, title: 'EvidenceRequired', kind: 'conflict' },
        { status: 409, title: 'identity-mutation-pending', kind: 'conflict' },
        { status: 503, title: 'capsule-unreachable', kind: 'unavailable' },
        { status: 401, title: 'unauthorized', kind: 'unauthorized' },
        { status: 400, title: 'permalink-ineligible', kind: 'ineligible' },
        { status: 404, title: 'not-found', kind: 'not-found' }
    ])('classifies HTTP $status as $kind and keeps the server code and detail', async ({ status, title, kind }) => {
        const { api } = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status,
                body: { title, detail: `server said ${title}`, status }
            }
        });

        const error = await discoverPermalinkCandidates({ api, permalinkId: 'tt0062622', purpose: 'details' })
            .catch((thrown: unknown) => thrown) as PermalinkRequestError;

        expect(error).toBeInstanceOf(PermalinkRequestError);
        expect(error.kind).toBe(kind);
        expect(error.code).toBe(title);
        expect(error.message).toBe(`server said ${title}`);
        expect(error.status).toBe(status);
        expect(error.cause).toBeInstanceOf(AxiosError);
    });

    it('reports a transport failure as a transport failure, never as a status code', async () => {
        const { api } = createServer({});

        const error = await discoverPermalinkCandidates({ api, permalinkId: 'tt0062622', purpose: 'details' })
            .catch((thrown: unknown) => thrown) as PermalinkRequestError;

        expect(error.kind).toBe('transport');
        expect(error.status).toBeNull();
        expect(error.hint).toContain('/Permalinks/tt0062622/Items');
    });

    it('classifies an aborted request distinctly so a stale route never renders a failure', async () => {
        const { api } = createServer({
            'GET /Permalinks/tt0062622/Items': { status: 200, body: { Items: [], TotalRecordCount: 0 }, delayMs: 50 }
        });
        const controller = new AbortController();

        const pending = discoverPermalinkCandidates({
            api,
            permalinkId: 'tt0062622',
            purpose: 'details',
            signal: controller.signal
        }).catch((thrown: unknown) => thrown);
        controller.abort();

        const error = await pending as PermalinkRequestError;
        expect(error.kind).toBe('aborted');
        expect(error.code).toBe('request-aborted');
    });
});

describe('lease redemption', () => {
    it('spends the details lease at the candidate handle and returns the revalidated item', async () => {
        const { api, calls } = createServer({
            'POST /Permalinks/Candidates/handle-1/Details': {
                status: 200,
                body: { Id: 'item-1', ServerId: 'server-1', Name: '2001: A Space Odyssey' }
            }
        });

        const item = await redeemPermalinkDetails({
            api,
            candidate: { rank: 0, namespace: 'external', handle: 'handle-1', lease: 'lease-1' }
        });

        expect(item.Id).toBe('item-1');
        expect(calls[0].body).toEqual({ Lease: 'lease-1' });
    });

    it('exchanges a details lease for a playback-purpose candidate', async () => {
        const { api, calls } = createServer({
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'external', Handle: 'handle-2', Lease: 'lease-2' }
            }
        });

        const playback = await exchangePermalinkPlaybackLease({
            api,
            candidate: { rank: 0, namespace: 'external', handle: 'handle-1', lease: 'lease-1' }
        });

        expect(playback).toEqual({ rank: 0, namespace: 'external', handle: 'handle-2', lease: 'lease-2' });
        expect(calls[0].body).toEqual({ Lease: 'lease-1' });
    });

    it('binds a playback redemption to one session and returns the frozen plan', async () => {
        const { api, calls } = createServer({
            'POST /Permalinks/Candidates/handle-2/Playback': {
                status: 200,
                body: { ItemId: 'item-1', QueueCount: 3, PlaybackSessionId: 'session-1' }
            }
        });

        const snapshot = await redeemPermalinkPlayback({
            api,
            candidate: { rank: 0, namespace: 'external', handle: 'handle-2', lease: 'lease-2' },
            playbackSessionId: 'session-1'
        });

        expect(snapshot).toEqual({ itemId: 'item-1', queueCount: 3, playbackSessionId: 'session-1' });
        expect(calls[0].body).toEqual({ Lease: 'lease-2', PlaybackSessionId: 'session-1' });
    });

    it('refuses a playback snapshot with no item id rather than starting playback of nothing', async () => {
        const { api } = createServer({
            'POST /Permalinks/Candidates/handle-2/Playback': { status: 200, body: { QueueCount: 1 } }
        });

        const error = await redeemPermalinkPlayback({
            api,
            candidate: { rank: 0, namespace: 'external', handle: 'handle-2', lease: 'lease-2' },
            playbackSessionId: 'session-1'
        }).catch((thrown: unknown) => thrown) as PermalinkRequestError;

        expect(error.code).toBe('playback-snapshot-incomplete');
    });

    it('surfaces a replayed lease as the server 409 it is', async () => {
        const { api } = createServer({
            'POST /Permalinks/Candidates/handle-1/Details': {
                status: 409,
                body: { title: 'lease-consumed', detail: 'This lease was already redeemed.', status: 409 }
            }
        });

        const error = await redeemPermalinkDetails({
            api,
            candidate: { rank: 0, namespace: 'external', handle: 'handle-1', lease: 'lease-1' }
        }).catch((thrown: unknown) => thrown) as PermalinkRequestError;

        expect(error.kind).toBe('conflict');
        expect(error.code).toBe('lease-consumed');
    });
});

describe('typed-failure discrimination', () => {
    /**
     * Regression for a production-only defect: this app compiles to ES5 for a
     * browserslist that still names Chrome 27, where `class ... extends Error`
     * is downlevelled to a form whose instances no longer carry the subclass on
     * their prototype chain. Every `instanceof PermalinkRequestError` therefore
     * reported false in the shipped bundle only, collapsing EvidenceRequired,
     * 409 and 503 into one generic "could not resolve" state. Observed live at
     * `#/p/tt0062622`, which rendered
     * "Could not resolve this link (resolver-failure: EvidenceRequired: ...)"
     * instead of the EvidenceRequired message. Vitest does not downlevel, so
     * the condition is reproduced here explicitly.
     */
    it('recognises a permalink failure whose prototype chain the bundle dropped', async () => {
        const { api } = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 409,
                body: {
                    title: 'EvidenceRequired',
                    detail: 'EvidenceRequired: initialize protected evidence from the authenticated local item page.',
                    status: 409
                }
            }
        });

        const error = await discoverPermalinkCandidates({ api, permalinkId: 'tt0062622', purpose: 'details' })
            .catch((thrown: unknown) => thrown) as PermalinkRequestError;
        Object.setPrototypeOf(error, Error.prototype);

        expect(error instanceof PermalinkRequestError).toBe(false);
        expect(isPermalinkRequestError(error)).toBe(true);
        expect(error.code).toBe('EvidenceRequired');
        expect(error.kind).toBe('conflict');
    });

    it('does not mistake an unrelated error for a permalink failure', () => {
        expect(isPermalinkRequestError(new Error('network down'))).toBe(false);
        expect(isPermalinkRequestError({ code: 'EvidenceRequired' })).toBe(false);
        expect(isPermalinkRequestError(null)).toBe(false);
        expect(isPermalinkRequestError(undefined)).toBe(false);
        expect(isPermalinkRequestError('EvidenceRequired')).toBe(false);
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
