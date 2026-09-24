// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Typed error for PlaybackManager contract violations: a caller handed the
 * playback manager (or one of its collaborator modules) something it cannot
 * act on, such as no player, a player without a name, or a play request
 * without a server id.
 *
 * Messages are kept byte-identical to the historical untyped errors so
 * existing logs and any message-matching caller keep working; the `code`
 * lets new callers branch without string matching.
 */

/**
 * Every code a PlaybackManagerError can carry.
 * @readonly
 * @enum {string}
 */
export const PlaybackManagerErrorCode = Object.freeze({
    /** A player argument was null/undefined where one is required. */
    MissingPlayer: 'MISSING_PLAYER',
    /** A player has no name, so its per-player state cannot be keyed. */
    MissingPlayerName: 'MISSING_PLAYER_NAME',
    /** A non-local player was activated without its target info. */
    MissingTargetInfo: 'MISSING_TARGET_INFO',
    /** A player looked up by name is not registered. */
    PlayerNotFound: 'PLAYER_NOT_FOUND',
    /** play() was asked to avoid remote players while one is active. */
    RemotePlayersDisabled: 'REMOTE_PLAYERS_DISABLED',
    /** A play/queue request by item ids carried no server id. */
    MissingServerId: 'MISSING_SERVER_ID',
    /** removeFromPlaylist was called without playlist item ids. */
    InvalidPlaylistItemIds: 'INVALID_PLAYLIST_ITEM_IDS'
});

/**
 * Error thrown when the playback manager's calling contract is violated.
 */
export class PlaybackManagerError extends Error {
    /**
     * @param {string} code One of PlaybackManagerErrorCode.
     * @param {string} message Human-readable description (historical text).
     * @param {{ hint?: string, cause?: unknown }} [options] Optional remedy
     *   hint and underlying cause.
     */
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'PlaybackManagerError';
        this.code = code;
        this.hint = options.hint;
        this.cause = options.cause;

        // Required for Error subclasses after transpilation for legacy browsers.
        Object.setPrototypeOf(this, PlaybackManagerError.prototype);
    }
}
