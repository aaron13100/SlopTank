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

import { fetchEpisodeContentEnd } from './episodeContentEnd';

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
