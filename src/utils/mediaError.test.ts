// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-09.
import { describe, expect, it } from 'vitest';
import { MediaError } from 'types/mediaError';
import { getMediaError } from './mediaError';

/**
 * Regression coverage for t_260722_234509_771: a player's startup promise
 * (e.g. htmlVideoPlayer's setSrcWithHlsJs) can reject with either a native
 * DOMException from the media element's own play() call, or a MediaError
 * value its internal error handler already classified (bindEventsToHlsPlayer
 * forwarding MediaError.NETWORK_ERROR/SERVER_ERROR/FATAL_HLS_ERROR through
 * reject()). getMediaError previously assumed every rejection was a
 * DOMException and collapsed any already-classified MediaError to the
 * generic PLAYER_ERROR, so a fatal network error during a stream-change
 * fallback surfaced as "Playback failed due to a fatal player error."
 * instead of the real, actionable message.
 */
describe('Utils: getMediaError', () => {
    it('passes through an already-classified MediaError instead of downgrading it to PLAYER_ERROR', () => {
        expect(getMediaError(MediaError.NETWORK_ERROR)).toBe(MediaError.NETWORK_ERROR);
        expect(getMediaError(MediaError.SERVER_ERROR)).toBe(MediaError.SERVER_ERROR);
        expect(getMediaError(MediaError.FATAL_HLS_ERROR)).toBe(MediaError.FATAL_HLS_ERROR);
    });

    it('maps a NotSupportedError DOMException to MEDIA_NOT_SUPPORTED', () => {
        const domException = new DOMException('no compatible source', 'NotSupportedError');

        expect(getMediaError(domException)).toBe(MediaError.MEDIA_NOT_SUPPORTED);
    });

    it('falls back to PLAYER_ERROR for an unclassified DOMException', () => {
        const domException = new DOMException('aborted', 'AbortError');

        expect(getMediaError(domException)).toBe(MediaError.PLAYER_ERROR);
    });

    it('falls back to PLAYER_ERROR when no reason is given', () => {
        expect(getMediaError()).toBe(MediaError.PLAYER_ERROR);
    });
});
