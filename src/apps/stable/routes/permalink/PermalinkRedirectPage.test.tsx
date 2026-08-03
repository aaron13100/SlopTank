import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import React, { type FC } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Api } from '@jellyfin/sdk/lib/api';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client';

import globalize from 'lib/globalize';
import { ApiContext } from 'hooks/useApi';
import type { ViewManagerPageProps } from 'components/viewManager/ViewManagerPage';

import PermalinkRedirectPage, { type PermalinkPurpose } from './PermalinkRedirectPage';

const LandingViewPage: FC<ViewManagerPageProps> = ({ controller, routeParameters }) => (
    <div data-testid='landing'>
        {`${controller === 'itemDetails/index' ? '/web/details' : '/web/video'}?${routeParameters?.toString()}`}
    </div>
);

/**
 * Entry-point tests for the two permalink routes a shared link actually lands
 * on (#/p/:permalinkId and #/w/:permalinkId).
 *
 * These render the real route component with the real resolver, the real
 * react-query cache and a real router, and replace only the HTTP transport to
 * the Jellyfin server -- an external service, and the single seam the mocking
 * policy allows. The stub answers with the exact statuses and `ProblemDetails`
 * bodies PermalinkResolutionController.cs emits, so what is asserted here is
 * what a user sees after opening a link, plus the exact request sequence the
 * client made to get there.
 */

interface StubRoute {
    status: number
    body?: unknown
    delayMs?: number
}

interface StubServer {
    api: Api
    calls: string[]
    aborted: string[]
}

function createServer(routes: Record<string, StubRoute>): StubServer {
    const calls: string[] = [];
    const aborted: string[] = [];

    const adapter: AxiosAdapter = (config: AxiosRequestConfig) => {
        const key = `${(config.method ?? 'get').toUpperCase()} ${config.url ?? ''}`;
        calls.push(key);

        const route = routes[key];
        if (!route) {
            return Promise.reject(new AxiosError(`no stub route for ${key}`, 'ENOTFOUND', config as never));
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

            const signal = config.signal as AbortSignal | undefined;
            if (signal) {
                if (signal.aborted) {
                    aborted.push(key);
                    reject(new AxiosError('canceled', AxiosError.ERR_CANCELED, config as never));
                    return;
                }
                signal.addEventListener('abort', () => {
                    aborted.push(key);
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

    return {
        api: {
            axiosInstance: axios.create({ adapter }),
            basePath: 'https://media.example',
            authorizationHeader: 'MediaBrowser Token="abc"'
        } as unknown as Api,
        calls,
        aborted
    };
}

/** Renders wherever the permalink route navigated to, so the redirect is observable. */
const LandingProbe = () => {
    const location = useLocation();
    return <div data-testid='landing'>{`${location.pathname}${location.search}`}</div>;
};

function renderPermalink(
    server: StubServer,
    purpose: PermalinkPurpose,
    path: string,
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
    const marker = purpose === 'info' ? 'p' : 'w';
    const context = {
        api: server.api,
        user: { Id: 'user-1', ServerId: 'server-1' } as UserDto
    };

    return render(
        <QueryClientProvider client={queryClient}>
            <ApiContext.Provider value={context}>
                <MemoryRouter initialEntries={[ path ]}>
                    <Routes>
                        <Route
                            path={`/${marker}/:permalinkId`}
                            element={(
                                <PermalinkRedirectPage
                                    purpose={purpose}
                                    viewPageComponent={LandingViewPage}
                                />
                            )}
                        />
                        <Route path='/web/details' element={<LandingProbe />} />
                        <Route path='/web/video' element={<LandingProbe />} />
                        <Route path='/elsewhere' element={<div data-testid='elsewhere' />} />
                    </Routes>
                </MemoryRouter>
            </ApiContext.Provider>
        </QueryClientProvider>
    );
}

const CANDIDATE = { Rank: 0, Namespace: 'external', Handle: 'handle-1', Lease: 'lease-1' };

function discovery(id: string, items: unknown[]): Record<string, StubRoute> {
    return {
        [`GET /Permalinks/${id}/Items`]: { status: 200, body: { Items: items, TotalRecordCount: items.length } }
    };
}

function detailsFor(handle: string, item: unknown): Record<string, StubRoute> {
    return { [`POST /Permalinks/Candidates/${handle}/Details`]: { status: 200, body: item } };
}

async function landingText(): Promise<string> {
    const landing = await screen.findByTestId('landing', undefined, { timeout: 5000 });
    return landing.textContent ?? '';
}

async function messageText(): Promise<string> {
    await waitFor(() => expect(document.querySelector('#permalinkMessagePage')).not.toBeNull(), { timeout: 5000 });
    return document.querySelector('#permalinkMessagePage')?.textContent ?? '';
}

const SK_MOVIE_ID = 'sk-2f3k2m9qbd8x4w1r0ehtyc5vnz';
const SK_SERIES_ID = 'sk-7h4v0p1qwe9rt2yz3nd5fgabjk';

/**
 * Loads the real string dictionary so every assertion below reads the message
 * a user actually sees. This is what makes the tests catch a string whose
 * placeholder is missing: without `{0}` in en-us.json the server's own code
 * never reaches the screen, and the failure states become indistinguishable.
 */
beforeAll(async () => {
    globalize.register({ name: 'core', strings: [{ lang: 'en-us', path: 'en-us.json' }] });
    globalize.defaultModule('core');
    await globalize.loadStrings('core');
});

describe('permalink info route (#/p/:permalinkId)', () => {
    afterEach(cleanup);

    it('opens an external IMDb link on the item it resolves to, through the protected endpoint only', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE ]),
            ...detailsFor('handle-1', { Id: 'item-1', ServerId: 'server-1', Name: '2001: A Space Odyssey' })
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        expect(await landingText()).toBe('/web/details?id=item-1&serverId=server-1');
        expect(server.calls).toEqual([
            'GET /Permalinks/tt0062622/Items',
            'POST /Permalinks/Candidates/handle-1/Details'
        ]);
    });

    it('opens a no-provider movie by its sk- alias, with no library query anywhere in the sequence', async () => {
        const server = createServer({
            ...discovery(SK_MOVIE_ID, [ { ...CANDIDATE, Namespace: 'sloptank' } ]),
            ...detailsFor('handle-1', { Id: 'item-9', ServerId: 'server-1', Name: 'Home Video 1994' })
        });

        renderPermalink(server, 'info', `/p/${SK_MOVIE_ID}`);

        expect(await landingText()).toBe('/web/details?id=item-9&serverId=server-1');
        expect(server.calls.some(call => call.includes('/Items?')) || server.calls.some(call => call.startsWith('GET /Items'))).toBe(false);
    });

    it('opens a Series by its sk- alias', async () => {
        const server = createServer({
            ...discovery(SK_SERIES_ID, [ { ...CANDIDATE, Namespace: 'sloptank' } ]),
            ...detailsFor('handle-1', { Id: 'series-3', ServerId: 'server-1', Name: 'Some Show', Type: 'Series' })
        });

        renderPermalink(server, 'info', `/p/${SK_SERIES_ID}`);

        expect(await landingText()).toBe('/web/details?id=series-3&serverId=server-1');
    });

    it('uses the server id the redeemed item reports, not the one the session happened to hold', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE ]),
            ...detailsFor('handle-1', { Id: 'item-1', ServerId: 'server-other' })
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        expect(await landingText()).toBe('/web/details?id=item-1&serverId=server-other');
    });

    it('lists every candidate in a chooser and auto-picks none when the same work exists twice', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE, { ...CANDIDATE, Rank: 1, Handle: 'handle-2', Lease: 'lease-2' } ]),
            ...detailsFor('handle-1', { Id: 'item-1', ServerId: 'server-1', Name: '2001: A Space Odyssey', Type: 'Movie', ProductionYear: 1968 }),
            ...detailsFor('handle-2', { Id: 'item-2', ServerId: 'server-1', Name: '2001: A Space Odyssey', Type: 'Movie', ProductionYear: 2001 })
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        await waitFor(() => expect(document.querySelector('#permalinkChooserPage')).not.toBeNull(), { timeout: 5000 });
        const choices = Array.from(document.querySelectorAll('#permalinkChooserPage button'));
        expect(choices).toHaveLength(2);
        expect(document.querySelector('#permalinkChooserPage')?.textContent).toContain('1968');
        expect(document.querySelector('#permalinkChooserPage')?.textContent).toContain('2001');
        expect(screen.queryByTestId('landing')).toBeNull();
    });

    it('refuses to render a chooser containing a candidate the server redeemed without an id', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE, { ...CANDIDATE, Rank: 1, Handle: 'handle-2', Lease: 'lease-2' } ]),
            ...detailsFor('handle-1', { Id: 'item-1', ServerId: 'server-1', Name: '2001: A Space Odyssey' }),
            ...detailsFor('handle-2', { ServerId: 'server-1', Name: 'Nameless duplicate' })
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        expect(await messageText()).toContain('redeemed-item-incomplete');
        expect(document.querySelector('#permalinkChooserPage')).toBeNull();
        expect(screen.queryByTestId('landing')).toBeNull();
    });

    it('says an external alias needs evidence, quoting the server, instead of reporting not found', async () => {
        const server = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 409,
                body: {
                    title: 'EvidenceRequired',
                    detail: 'EvidenceRequired: initialize protected evidence from the authenticated local item page.',
                    status: 409
                }
            }
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        expect(await messageText()).toContain('initialize protected evidence');
        expect(screen.queryByTestId('landing')).toBeNull();
    });

    it('reports a pending identity mutation as a retriable conflict, never as a dead link', async () => {
        const server = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 409,
                body: { title: 'identity-mutation-pending', detail: 'A replacement is in flight.', status: 409 }
            }
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        const text = await messageText();
        expect(text).toContain('identity-mutation-pending');
        expect(document.querySelector('#permalinkRetryButton')).not.toBeNull();
    });

    it('reports an unreachable capsule as a retriable 503 state', async () => {
        const server = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 503,
                body: { title: 'capsule-unreachable', detail: 'The volume is not mounted.', status: 503 }
            }
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        const text = await messageText();
        expect(text).toContain('capsule-unreachable');
        expect(document.querySelector('#permalinkRetryButton')).not.toBeNull();
    });

    it('reports not found when the server verified no candidate for a known-grammar sk- alias', async () => {
        const server = createServer(discovery(SK_MOVIE_ID, []));

        renderPermalink(server, 'info', `/p/${SK_MOVIE_ID}`);

        expect(await messageText()).toContain(SK_MOVIE_ID);
    });

    it('follows a renamed item to its new id on reopen, never replaying the first resolution', async () => {
        const beforeRename = createServer({
            ...discovery(SK_MOVIE_ID, [ { ...CANDIDATE, Namespace: 'sloptank' } ]),
            ...detailsFor('handle-1', { Id: 'item-9', ServerId: 'server-1', Name: 'Home Video 1994' })
        });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        const first = renderPermalink(beforeRename, 'info', `/p/${SK_MOVIE_ID}`, queryClient);
        expect(await landingText()).toBe('/web/details?id=item-9&serverId=server-1');
        first.unmount();
        cleanup();

        // The file was renamed, so the library rebuilt the item under a new
        // GUID. The durable sk- alias is unchanged, and the server now verifies
        // it against the new item -- which the client only sees because it
        // discovers and redeems again instead of reusing the cached result.
        const afterRename = createServer({
            ...discovery(SK_MOVIE_ID, [ { ...CANDIDATE, Namespace: 'sloptank', Handle: 'handle-r', Lease: 'lease-r' } ]),
            ...detailsFor('handle-r', { Id: 'item-renamed', ServerId: 'server-1', Name: 'Family Trip 1994' })
        });

        renderPermalink(afterRename, 'info', `/p/${SK_MOVIE_ID}`, queryClient);

        await waitFor(() => expect(screen.getByTestId('landing').textContent)
            .toBe('/web/details?id=item-renamed&serverId=server-1'));
        expect(afterRename.calls).toEqual([
            `GET /Permalinks/${SK_MOVIE_ID}/Items`,
            'POST /Permalinks/Candidates/handle-r/Details'
        ]);
    });

    it('rejects a malformed id without contacting the server at all', async () => {
        const server = createServer({});

        renderPermalink(server, 'info', '/p/not-a-real-permalink');

        expect(await messageText()).toContain('not a valid permalink');
        expect(server.calls).toEqual([]);
    });

    it('refuses to decide when the server counted more candidates than it returned', async () => {
        const server = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 200,
                body: { Items: [ CANDIDATE ], TotalRecordCount: 2 }
            }
        });

        renderPermalink(server, 'info', '/p/tt0062622');

        expect(await messageText()).toContain('candidate-set-truncated');
        expect(screen.queryByTestId('landing')).toBeNull();
    });

    it('aborts the in-flight resolution when the route goes away, so no stale result can land', async () => {
        const server = createServer({
            'GET /Permalinks/tt0062622/Items': {
                status: 200,
                body: { Items: [ CANDIDATE ], TotalRecordCount: 1 },
                delayMs: 200
            }
        });

        const view = renderPermalink(server, 'info', '/p/tt0062622');
        await waitFor(() => expect(server.calls).toHaveLength(1));
        view.unmount();

        await waitFor(() => expect(server.aborted).toEqual([ 'GET /Permalinks/tt0062622/Items' ]), { timeout: 5000 });
        expect(screen.queryByTestId('landing')).toBeNull();
    });
});

describe('permalink watch route (#/w/:permalinkId)', () => {
    afterEach(cleanup);

    it('exchanges the details lease for a playback lease and plays the item the frozen plan names', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE ]),
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'external', Handle: 'handle-2', Lease: 'lease-2' }
            },
            'POST /Permalinks/Candidates/handle-2/Playback': {
                status: 200,
                body: { ItemId: 'item-1', QueueCount: 1, PlaybackSessionId: 'session-1' }
            }
        });

        renderPermalink(server, 'watch', '/w/tt0062622');

        expect(await landingText()).toBe('/web/video?id=item-1&serverId=server-1');
        expect(server.calls).toEqual([
            'GET /Permalinks/tt0062622/Items',
            'POST /Permalinks/Candidates/handle-1/PlaybackLease',
            'POST /Permalinks/Candidates/handle-2/Playback'
        ]);
    });

    it('carries a valid start offset through to the player route', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE ]),
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'external', Handle: 'handle-2', Lease: 'lease-2' }
            },
            'POST /Permalinks/Candidates/handle-2/Playback': {
                status: 200,
                body: { ItemId: 'item-1', QueueCount: 1, PlaybackSessionId: 'session-1' }
            }
        });

        renderPermalink(server, 'watch', '/w/tt0062622?t=90');

        expect(await landingText()).toBe('/web/video?id=item-1&serverId=server-1&t=90');
    });

    it('drops a malformed start offset rather than guessing a position', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE ]),
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'external', Handle: 'handle-2', Lease: 'lease-2' }
            },
            'POST /Permalinks/Candidates/handle-2/Playback': {
                status: 200,
                body: { ItemId: 'item-1', QueueCount: 1, PlaybackSessionId: 'session-1' }
            }
        });

        renderPermalink(server, 'watch', '/w/tt0062622?t=-5');

        expect(await landingText()).toBe('/web/video?id=item-1&serverId=server-1');
    });

    it('surfaces a replacement race as a retriable conflict rather than playing the replaced file', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE ]),
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'external', Handle: 'handle-2', Lease: 'lease-2' }
            },
            'POST /Permalinks/Candidates/handle-2/Playback': {
                status: 409,
                body: { title: 'assignment-head-moved', detail: 'The item was replaced while this link was opening.', status: 409 }
            }
        });

        renderPermalink(server, 'watch', '/w/tt0062622');

        const text = await messageText();
        expect(text).toContain('assignment-head-moved');
        expect(screen.queryByTestId('landing')).toBeNull();
    });

    it('never starts playback from a snapshot with no item id', async () => {
        const server = createServer({
            ...discovery('tt0062622', [ CANDIDATE ]),
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'external', Handle: 'handle-2', Lease: 'lease-2' }
            },
            'POST /Permalinks/Candidates/handle-2/Playback': { status: 200, body: { QueueCount: 1 } }
        });

        renderPermalink(server, 'watch', '/w/tt0062622');

        expect(await messageText()).toContain('playback-snapshot-incomplete');
    });

    it('re-runs the whole exchange on a second open, so append-only growth is never replayed from a spent lease', async () => {
        const beforeGrowth = createServer({
            ...discovery(SK_SERIES_ID, [ { ...CANDIDATE, Namespace: 'sloptank' } ]),
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'sloptank', Handle: 'handle-2', Lease: 'lease-2' }
            },
            'POST /Permalinks/Candidates/handle-2/Playback': {
                status: 200,
                body: { ItemId: 'episode-1', QueueCount: 1, PlaybackSessionId: 'session-1' }
            }
        });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        const first = renderPermalink(beforeGrowth, 'watch', `/w/${SK_SERIES_ID}`, queryClient);
        expect(await landingText()).toBe('/web/video?id=episode-1&serverId=server-1');
        first.unmount();
        cleanup();

        // A rescan appended episodes: the server now freezes a larger queue and
        // issues different handles. The client must discover and redeem again
        // rather than reuse anything it learned on the first open.
        const afterGrowth = createServer({
            ...discovery(SK_SERIES_ID, [ { ...CANDIDATE, Namespace: 'sloptank', Handle: 'handle-3', Lease: 'lease-3' } ]),
            'POST /Permalinks/Candidates/handle-3/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'sloptank', Handle: 'handle-4', Lease: 'lease-4' }
            },
            'POST /Permalinks/Candidates/handle-4/Playback': {
                status: 200,
                body: { ItemId: 'episode-1', QueueCount: 12, PlaybackSessionId: 'session-2' }
            }
        });

        renderPermalink(afterGrowth, 'watch', `/w/${SK_SERIES_ID}`, queryClient);

        expect(await landingText()).toBe('/web/video?id=episode-1&serverId=server-1');
        expect(afterGrowth.calls).toEqual([
            `GET /Permalinks/${SK_SERIES_ID}/Items`,
            'POST /Permalinks/Candidates/handle-3/PlaybackLease',
            'POST /Permalinks/Candidates/handle-4/Playback'
        ]);
    });

    it('plays a no-provider item opened by its sk- watch link', async () => {
        const server = createServer({
            ...discovery(SK_MOVIE_ID, [ { ...CANDIDATE, Namespace: 'sloptank' } ]),
            'POST /Permalinks/Candidates/handle-1/PlaybackLease': {
                status: 200,
                body: { Rank: 0, Namespace: 'sloptank', Handle: 'handle-2', Lease: 'lease-2' }
            },
            'POST /Permalinks/Candidates/handle-2/Playback': {
                status: 200,
                body: { ItemId: 'item-9', QueueCount: 1, PlaybackSessionId: 'session-1' }
            }
        });

        renderPermalink(server, 'watch', `/w/${SK_MOVIE_ID}`);

        expect(await landingText()).toBe('/web/video?id=item-9&serverId=server-1');
    });
});
