// SlopTank modification notice: added or changed by SlopTank on 2026-10-07.
/**
 * EpisodeContentEnd boundary fetch (c189).
 *
 * The Up Next prompt consumes the server-computed episode content-end
 * boundary (terminal Outro start, else MaxResumePct of runtime) from
 * GET /MediaSegments/{itemId}/EpisodeContentEnd. The fetch must never break
 * playback: any failure (legacy server without the endpoint, offline client,
 * non-episode item answering 404) resolves to null so callers keep their
 * defensive default timing. The apiClient is the real DI seam here
 * (fetchEpisodeContentEnd takes it as an argument), so the tests pass a
 * plain object literal in the same shape the app's ServerConnections hands
 * out; no HTTP is attempted.
 */
import { describe, expect, it } from 'vitest';

import { createEpisodeContentEndRequestTracker, fetchEpisodeContentEnd } from './episodeContentEnd';

/** Plain apiClient literal that answers every ajax call with ajaxResult. */
function recordedApiClient(ajaxResult: Promise<unknown>) {
    const calls = {
        getUrlPaths: [] as string[],
        ajaxOptions: [] as unknown[]
    };
    return {
        calls,
        getUrl(url: string) {
            calls.getUrlPaths.push(url);
            return `http://localhost/${url}`;
        },
        ajax(options: unknown) {
            calls.ajaxOptions.push(options);
            return ajaxResult;
        }
    };
}

describe('fetchEpisodeContentEnd', () => {
    it('GETs MediaSegments/{itemId}/EpisodeContentEnd and parses the boundary', async () => {
        const apiClient = recordedApiClient(Promise.resolve({
            ItemId: 'episode-1',
            ContentEndTicks: 1_620_000_000_00,
            Source: 'TerminalOutro',
            UnrelatedField: 'ignored'
        }));

        const result = await fetchEpisodeContentEnd(apiClient, 'episode-1');

        expect(apiClient.calls.getUrlPaths).toEqual(['MediaSegments/episode-1/EpisodeContentEnd']);
        expect(apiClient.calls.ajaxOptions).toHaveLength(1);
        expect(apiClient.calls.ajaxOptions[0]).toMatchObject({
            url: 'http://localhost/MediaSegments/episode-1/EpisodeContentEnd',
            type: 'GET'
        });
        expect(result).toEqual({ ContentEndTicks: 1_620_000_000_00, Source: 'TerminalOutro' });
    });

    it('resolves null when the server answers 404 (item is not an Episode)', async () => {
        const notFound = Object.assign(new Error('Not Found'), { status: 404 });
        const apiClient = recordedApiClient(Promise.reject(notFound));

        await expect(fetchEpisodeContentEnd(apiClient, 'movie-1')).resolves.toBeNull();
    });

    it('resolves null when the request fails (legacy server, offline)', async () => {
        const apiClient = recordedApiClient(Promise.reject(new Error('network error')));

        await expect(fetchEpisodeContentEnd(apiClient, 'episode-1')).resolves.toBeNull();
    });
});

describe('createEpisodeContentEndRequestTracker', () => {
    const episode = { Type: 'Episode', ServerId: 'server-1', Id: 'episode-1' };

    it('deduplicates bind and playbackstart observations for the same episode session', () => {
        const tracker = createEpisodeContentEndRequestTracker();
        const bindRequest = tracker.begin(episode, 'play-session-1');

        expect(bindRequest).not.toBeNull();
        expect(tracker.setBoundaryTicks(bindRequest!, 2_010_000_000)).toBe(true);
        expect(tracker.begin(episode, 'play-session-1')).toBeNull();
        expect(tracker.isCurrent(bindRequest!)).toBe(true);
        expect(tracker.getBoundaryTicks()).toBe(2_010_000_000);
    });

    it('preserves the computed boundary across a same-session player rebind', () => {
        const tracker = createEpisodeContentEndRequestTracker();
        const initialBindRequest = tracker.begin(episode, 'play-session-1');

        expect(initialBindRequest).not.toBeNull();
        expect(tracker.setBoundaryTicks(initialBindRequest!, 2_010_000_000)).toBe(true);

        // bindToPlayer can run again for the same player/session. It must
        // deduplicate the fetch without erasing the boundary already in use.
        expect(tracker.begin(episode, 'play-session-1')).toBeNull();
        expect(tracker.getBoundaryTicks()).toBe(2_010_000_000);
    });

    it('starts a fresh request and clears the boundary for a new session of the same episode', () => {
        const tracker = createEpisodeContentEndRequestTracker();
        const firstSession = tracker.begin(episode, 'play-session-1');

        expect(firstSession).not.toBeNull();
        expect(tracker.setBoundaryTicks(firstSession!, 2_010_000_000)).toBe(true);

        const secondSession = tracker.begin(episode, 'play-session-2');

        expect(secondSession).not.toBeNull();
        expect(tracker.isCurrent(firstSession!)).toBe(false);
        expect(tracker.isCurrent(secondSession!)).toBe(true);
        expect(tracker.getBoundaryTicks()).toBeNull();
        expect(tracker.setBoundaryTicks(firstSession!, 2_010_000_000)).toBe(false);
    });

    it('deduplicates a session id becoming available after the bind observation', () => {
        const tracker = createEpisodeContentEndRequestTracker();
        const bindRequest = tracker.begin(episode, null);

        expect(bindRequest).not.toBeNull();
        expect(tracker.begin(episode, 'play-session-1')).toBeNull();
        expect(tracker.isCurrent(bindRequest!)).toBe(true);
    });

    it('replaces the active request for another episode or playback session and rejects stale results', () => {
        const tracker = createEpisodeContentEndRequestTracker();
        const firstRequest = tracker.begin(episode, 'play-session-1');
        const secondRequest = tracker.begin({ ...episode, Id: 'episode-2' }, 'play-session-2');

        expect(secondRequest).not.toBeNull();
        expect(tracker.isCurrent(firstRequest!)).toBe(false);
        expect(tracker.isCurrent(secondRequest!)).toBe(true);
        expect(tracker.getBoundaryTicks()).toBeNull();
        expect(tracker.setBoundaryTicks(firstRequest!, 2_010_000_000)).toBe(false);

        const replayRequest = tracker.begin(episode, 'play-session-3');
        expect(replayRequest).not.toBeNull();
        expect(tracker.isCurrent(secondRequest!)).toBe(false);
        expect(tracker.isCurrent(replayRequest!)).toBe(true);
        expect(tracker.getBoundaryTicks()).toBeNull();
    });

    it('allows the same playback key to be fetched again after stop or release reset', () => {
        const tracker = createEpisodeContentEndRequestTracker();
        const firstRequest = tracker.begin(episode, 'play-session-1');

        tracker.reset();

        const replayRequest = tracker.begin(episode, 'play-session-1');
        expect(replayRequest).not.toBeNull();
        expect(tracker.isCurrent(firstRequest!)).toBe(false);
        expect(tracker.isCurrent(replayRequest!)).toBe(true);
        expect(tracker.getBoundaryTicks()).toBeNull();
    });

    it('clears the active episode request for non-episode state', () => {
        const tracker = createEpisodeContentEndRequestTracker();
        const request = tracker.begin(episode, 'play-session-1');

        expect(tracker.begin({ ...episode, Type: 'Series' }, 'play-session-1')).toBeNull();
        expect(tracker.isCurrent(request!)).toBe(false);
    });
});
