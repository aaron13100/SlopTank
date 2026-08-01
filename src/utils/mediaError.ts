import { MediaError } from 'types/mediaError';

const MEDIA_ERROR_VALUES: Set<string> = new Set(Object.values(MediaError));

function isMediaError(e: unknown): e is MediaError {
    return typeof e === 'string' && MEDIA_ERROR_VALUES.has(e);
}

/**
 * Maps a rejection reason from a player's startup promise to a
 * {@link MediaError}. The reason is either a native DOMException from the
 * media element's own play() call, or a MediaError value a player's internal
 * error handler (e.g. bindEventsToHlsPlayer) already classified and forwarded
 * through reject() -- that classification must pass through unchanged, or a
 * fatal network/server/HLS error is downgraded to the generic PLAYER_ERROR
 * and the user loses the actionable, specific error message.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/DOMException#error_names
 */
export function getMediaError(e?: DOMException | MediaError): MediaError {
    if (isMediaError(e)) return e;
    if (e?.name === 'NotSupportedError') return MediaError.MEDIA_NOT_SUPPORTED;
    return MediaError.PLAYER_ERROR;
}
