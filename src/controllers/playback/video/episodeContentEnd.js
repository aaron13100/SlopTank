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
