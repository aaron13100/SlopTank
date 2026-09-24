// SlopTank modification notice: added by SlopTank on 2026-09-24.
import { afterEach, describe, expect, it } from 'vitest';

import { readReloadResumeSnapshot, saveReloadResumeSnapshot } from './playbackReloadSnapshot';

const ITEM = { itemId: 'item-1', serverId: 'server-1' };

describe('playbackReloadSnapshot', () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    it('round-trips the exact position and paused state for a matching item', () => {
        saveReloadResumeSnapshot({ ...ITEM, positionTicks: 123456789, paused: true });

        expect(readReloadResumeSnapshot(ITEM)).toEqual({ positionTicks: 123456789, paused: true });
    });

    it('is non-destructive: repeated reads for the same item keep finding it', () => {
        // A single real reload can dispatch this app's resume-from-permalink
        // path more than once (video/index.js's own comment on `viewshow`
        // dispatching twice while the router falls back); every dispatch
        // must see the same answer, not just the first one.
        saveReloadResumeSnapshot({ ...ITEM, positionTicks: 1, paused: false });

        expect(readReloadResumeSnapshot(ITEM)).not.toBeNull();
        expect(readReloadResumeSnapshot(ITEM)).not.toBeNull();
    });

    it('does not apply a snapshot saved for a different item', () => {
        saveReloadResumeSnapshot({ ...ITEM, positionTicks: 1, paused: false });

        expect(readReloadResumeSnapshot({ itemId: 'item-2', serverId: 'server-1' })).toBeNull();
    });

    it('does not apply a snapshot saved for a different server', () => {
        saveReloadResumeSnapshot({ ...ITEM, positionTicks: 1, paused: false });

        expect(readReloadResumeSnapshot({ itemId: 'item-1', serverId: 'server-2' })).toBeNull();
    });

    it('returns nothing when no snapshot was ever saved', () => {
        expect(readReloadResumeSnapshot(ITEM)).toBeNull();
    });

    // @covers video.reload.snapshot_corrupt.discarded_without_throwing
    it('discards a corrupt stored value instead of throwing', () => {
        sessionStorage.setItem('videoReloadResumeSnapshot', '{not json');

        expect(readReloadResumeSnapshot(ITEM)).toBeNull();
    });

    it('discards a snapshot missing a required field', () => {
        sessionStorage.setItem('videoReloadResumeSnapshot', JSON.stringify({
            v: 1, itemId: ITEM.itemId, serverId: ITEM.serverId, paused: false, savedAt: Date.now()
            // positionTicks intentionally omitted
        }));

        expect(readReloadResumeSnapshot(ITEM)).toBeNull();
    });

    it('discards a snapshot older than the freshness window', () => {
        sessionStorage.setItem('videoReloadResumeSnapshot', JSON.stringify({
            v: 1, itemId: ITEM.itemId, serverId: ITEM.serverId, positionTicks: 1, paused: false,
            savedAt: Date.now() - 11 * 60 * 1000 // just past the 10-minute window
        }));

        expect(readReloadResumeSnapshot(ITEM)).toBeNull();
    });

    it('does not save an incomplete snapshot', () => {
        saveReloadResumeSnapshot({ itemId: null, serverId: 'server-1', positionTicks: 1, paused: false });

        expect(sessionStorage.getItem('videoReloadResumeSnapshot')).toBeNull();
    });
});
