// SlopTank modification notice: added or changed by SlopTank on 2026-10-07.
/**
 * Fetches the server-computed episode content-end boundary used to time the
 * Up Next prompt.
 *
 * The server answers GET MediaSegments/{itemId}/EpisodeContentEnd with the
 * boundary in ticks: the terminal Outro segment's start when one exists, else
 * MaxResumePct percent of the runtime, with a null ContentEndTicks when
 * nothing computable is known. A non-episode item answers 404.
 * @module controllers/playback/video/episodeContentEnd
 */

/**
 * Fetch the server-computed episode content-end boundary for the Up Next
 * prompt.
 *
 * Resolves to { ContentEndTicks, Source } exactly as the server reports it,
 * or to null on any failure: a legacy server without the endpoint, an
 * offline client, or a non-episode item (HTTP 404). Callers keep their
 * defensive default timing on null; a failed fetch must never break
 * playback, so nothing here rejects and nothing logs louder than
 * console.debug.
 *
 * @param {object} apiClient - API client of the server playing the item.
 * @param {string} itemId - Id of the item being played.
 * @returns {Promise<{ContentEndTicks: number|null, Source: string|null}|null>}
 *   The parsed boundary, or null when it cannot be obtained.
 */
export function fetchEpisodeContentEnd(apiClient, itemId) {
    return apiClient.ajax({
        url: apiClient.getUrl(`MediaSegments/${itemId}/EpisodeContentEnd`),
        type: 'GET',
        dataType: 'json'
    }).then(
        response => ({
            ContentEndTicks: response?.ContentEndTicks ?? null,
            Source: response?.Source ?? null
        }),
        error => {
            console.debug('EpisodeContentEnd unavailable; keeping default Up Next timing', error);
            return null;
        }
    );
}

/**
 * Tracks the one in-flight/active boundary request for the current episode
 * playback. Binding and playbackstart can both observe the same player state;
 * a new session or item replaces the key, and callers can reject stale results.
 * @returns {{begin: function(object, string|null): number|null, isCurrent: function(number): boolean, setBoundaryTicks: function(number, (number|null)): boolean, getBoundaryTicks: function(): (number|null), reset: function(): void}}
 */
export function createEpisodeContentEndRequestTracker() {
    let activeRequest = null;
    let boundaryTicks = null;
    let generation = 0;

    function reset() {
        activeRequest = null;
        boundaryTicks = null;
        generation++;
    }

    return {
        begin(item, playSessionId) {
            if (item?.Type !== 'Episode' || !item.Id) {
                reset();
                return null;
            }

            const serverId = item.ServerId ?? null;
            const sessionId = playSessionId ?? null;
            const sameEpisode = activeRequest?.serverId === serverId && activeRequest?.itemId === item.Id;
            const samePlayback = sameEpisode && (activeRequest.playSessionId === null || sessionId === null || activeRequest.playSessionId === sessionId);

            if (samePlayback) {
                if (activeRequest.playSessionId === null && sessionId !== null) {
                    activeRequest.playSessionId = sessionId;
                }
                return null;
            }

            activeRequest = { serverId, itemId: item.Id, playSessionId: sessionId, generation: ++generation };
            boundaryTicks = null;
            return activeRequest.generation;
        },
        isCurrent(requestGeneration) {
            return activeRequest?.generation === requestGeneration;
        },
        setBoundaryTicks(requestGeneration, ticks) {
            if (activeRequest?.generation !== requestGeneration) return false;
            boundaryTicks = ticks ?? null;
            return true;
        },
        getBoundaryTicks() {
            return boundaryTicks;
        },
        reset
    };
}
