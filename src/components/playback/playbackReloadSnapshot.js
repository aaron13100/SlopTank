/**
 * The local, same-tab source of truth for "where exactly did playback leave
 * off, and was it playing or paused" across a page reload.
 *
 * Jellyfin's server-side resume position (`item.UserData.PlaybackPositionTicks`)
 * is only as fresh as the last progress report that actually reached the
 * server: a 10s periodic timer, plus one on pause/unpause. The final report
 * fired from `beforeunload` goes through a plain, non-keepalive network
 * request, which the browser is free to cancel once a reload starts
 * navigating away, so the server's position can lag the real one by
 * seconds. Server UserData also has no "was this paused" flag at all, so
 * there is nothing for a restore path to consult for that even when the
 * position happens to be fresh.
 *
 * This module closes both gaps with a synchronous storage write (no network
 * involved, so nothing to cancel) captured at the same `beforeunload`
 * moment, scoped to this browser tab. It is deliberately not sent to the
 * server: cross-device/cross-tab resume already has its own source of truth
 * (server UserData), and this snapshot exists only to make a same-tab
 * reload of the item it was captured for exact.
 *
 * This file is the one seam for that storage access (there is no
 * project-wide storage or clock adapter in this legacy JS codebase; the
 * existing `playbackRateSpeed` sessionStorage key in playbackmanager.js and
 * video/index.js is the established precedent for direct sessionStorage use
 * here), so its own direct sessionStorage/Date calls are the adapter, not a
 * violation of the boundary-adapter rule.
 */

const STORAGE_KEY = 'videoReloadResumeSnapshot';

/** Schema version for the stored snapshot; bump on any incompatible shape change. */
const SNAPSHOT_VERSION = 1;

/**
 * How old a snapshot may be before a reload stops trusting it.
 *
 * Reload happens within moments of the save in the normal case. This bound
 * only guards the edge case of a tab left open (sessionStorage survives a
 * suspend/resume) and reloaded much later, where the server's own resume
 * position -- possibly advanced by another session in the meantime -- is the
 * more likely to be correct of the two.
 */
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Persist the exact playback position and paused state for this item, for
 * this tab, to survive a reload.
 *
 * Best-effort: sessionStorage can throw in private-browsing/quota-exceeded
 * edge cases. A failure here must not block the caller's own unload path, so
 * it is logged, not thrown.
 *
 * @param {object} snapshot Snapshot to persist.
 * @param {string} snapshot.itemId Now-playing item id.
 * @param {string} snapshot.serverId Now-playing item's server id.
 * @param {number} snapshot.positionTicks Exact playback position, in Jellyfin ticks.
 * @param {boolean} snapshot.paused Whether the player was paused at capture time.
 */
export function saveReloadResumeSnapshot({ itemId, serverId, positionTicks, paused }) {
    if (!itemId || !serverId || !Number.isFinite(positionTicks)) {
        return;
    }

    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ // allow-direct-storage: this IS the storage adapter for the reload-resume snapshot
            v: SNAPSHOT_VERSION,
            itemId,
            serverId,
            positionTicks,
            paused: !!paused,
            savedAt: Date.now() // allow-direct-time: this IS the clock read for the reload-resume snapshot's own timestamp; no project-wide clock adapter exists in this legacy JS codebase
        }));
    } catch (err) {
        console.error('[playbackReloadSnapshot] failed to save reload resume snapshot: ' + err);
    }
}

/**
 * Read and validate the reload resume snapshot for the given item.
 *
 * Deliberately non-destructive (a peek, not a consume): video/index.js's own
 * comments document that a single real reload can dispatch this app's
 * `viewshow` more than once while its router falls back from restoring the
 * legacy view to loading it fresh, and each dispatch calls the
 * resume-from-permalink path independently. A "consume on first read"
 * design handed the position to whichever of those dispatches ran first and
 * left the one that actually stuck (the final live player) with nothing,
 * observed as an occasional reload landing back at position 0. Reading
 * without deleting means every dispatch within that cascade sees the same
 * answer, and the value stays correct anyway: as soon as playback resumes,
 * playbackReloadCapture.js's own immediate-capture-on-bind overwrites this
 * entry with the freshly resumed position within the same tick. Staleness
 * is bounded by SNAPSHOT_MAX_AGE_MS instead of by deletion.
 *
 * @param {object} target Item to resolve a snapshot for.
 * @param {string} target.itemId Now-playing item id being restored.
 * @param {string} target.serverId Now-playing item's server id being restored.
 * @returns {{ positionTicks: number, paused: boolean } | null} The saved
 *   state if a fresh, matching snapshot exists, otherwise null.
 */
export function readReloadResumeSnapshot({ itemId, serverId }) {
    let raw;
    try {
        raw = sessionStorage.getItem(STORAGE_KEY); // allow-direct-storage: this IS the storage adapter for the reload-resume snapshot
    } catch (err) {
        console.error('[playbackReloadSnapshot] failed to read reload resume snapshot: ' + err);
        return null;
    }

    if (!raw) {
        return null;
    }

    let snapshot;
    try {
        snapshot = JSON.parse(raw);
    } catch (err) {
        console.error('[playbackReloadSnapshot] discarding unparseable reload resume snapshot: ' + err);
        try {
            sessionStorage.removeItem(STORAGE_KEY); // allow-direct-storage: this IS the storage adapter for the reload-resume snapshot
        } catch (removeErr) {
            console.error('[playbackReloadSnapshot] failed to clear unparseable reload resume snapshot: ' + removeErr);
        }
        return null;
    }

    if (snapshot?.v !== SNAPSHOT_VERSION
        || snapshot.itemId !== itemId
        || snapshot.serverId !== serverId
        || !Number.isFinite(snapshot.positionTicks)) {
        return null;
    }

    if (Date.now() - snapshot.savedAt > SNAPSHOT_MAX_AGE_MS) { // allow-direct-time: this IS the clock read for the reload-resume snapshot's own staleness check; no project-wide clock adapter exists in this legacy JS codebase
        return null;
    }

    return { positionTicks: snapshot.positionTicks, paused: !!snapshot.paused };
}
