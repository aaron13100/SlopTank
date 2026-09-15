// SlopTank modification notice: added or changed by SlopTank on 2026-09-15.

/**
 * Resolve the media streams a play flow needs for track auto-selection.
 *
 * The play path used to refetch the whole item by id just to read its
 * MediaStreams, adding one full API round trip between the Play click and
 * PlaybackInfo (measured 2026-09-15: ~1.4s of the click-to-video window on a
 * contended box, against a 7ms server). A single-item GET payload already
 * carries the streams, so the common case resolves synchronously from the
 * item in hand.
 *
 * The details page always passes a mediaSourceId: its source selector
 * defaults to the item's only source, whose id equals the item id for
 * single-source media. Selecting that source carries no new information, so
 * it counts as no selection and the item's own streams are reused. A
 * genuinely different source (multi-source media) still refetches, because a
 * different source's streams cannot be assumed from the item's own list, and
 * so does an item that arrived without streams (list queries omit them).
 *
 * @param apiClient - ApiClient for the item's server.
 * @param item - The item about to be played.
 * @param mediaSourceId - Explicit media source selection, if any.
 * @returns Media streams for auto-selection.
 */
export function resolvePlaybackMediaStreams(apiClient, item, mediaSourceId) {
    const onlySourceId = Array.isArray(item.MediaSources) && item.MediaSources.length === 1
        ? item.MediaSources[0].Id
        : null;
    const selectedOtherSource = Boolean(mediaSourceId)
        && mediaSourceId !== onlySourceId;

    if (!selectedOtherSource && Array.isArray(item.MediaStreams) && item.MediaStreams.length > 0) {
        return Promise.resolve(item.MediaStreams);
    }

    return apiClient.getItem(apiClient.getCurrentUserId(), mediaSourceId || item.Id)
        .then(fullItem => fullItem.MediaStreams);
}
