// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Storage adapter for the session-scoped playback speed preference.
 *
 * When the user changes playback speed, the choice is remembered for the
 * rest of the browser session so the next video can restore it. This module
 * is the only reader and writer of that session value; the video OSD
 * (controllers/playback/video/index.js) reads it through loadPlaybackRate()
 * when a new video starts.
 */

const STORAGE_KEY = 'playbackRateSpeed';

/**
 * Remembers the playback speed for the rest of this browser session.
 * @param {number|string} value The playback rate the user chose (1 = normal).
 * @returns {void}
 */
export function savePlaybackRate(value) {
    sessionStorage.setItem(STORAGE_KEY, value); // allow-direct-storage: this IS the storage adapter for the session playback-rate preference
}

/**
 * Reads the playback speed remembered for this browser session.
 * @returns {string|null} The stored rate as sessionStorage returns it, or
 *   null when none was saved this session.
 */
export function loadPlaybackRate() {
    return sessionStorage.getItem(STORAGE_KEY); // allow-direct-storage: this IS the storage adapter for the session playback-rate preference
}
