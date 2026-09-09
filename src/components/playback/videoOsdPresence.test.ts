// SlopTank modification notice: added or changed by SlopTank on 2026-08-12, 2026-09-09.
import { describe, expect, it } from 'vitest';

import {
    isVideoOsdMounted,
    subscribeToVideoOsdPresence,
    trackVideoOsdMount
} from './videoOsdPresence';

describe('videoOsdPresence', () => {
    it('reports nothing mounted before anything declares itself', () => {
        expect(isVideoOsdMounted()).toBe(false);
    });

    it('reports a mount for as long as it is held', () => {
        const release = trackVideoOsdMount();
        expect(isVideoOsdMounted()).toBe(true);

        release();
        expect(isVideoOsdMounted()).toBe(false);
    });

    it('stays mounted while an incoming view overlaps an outgoing one', () => {
        // React mounts the next route before unmounting the previous one, and
        // StrictMode mounts everything twice. A boolean flag would be cleared
        // here by the outgoing view, putting the navigation toolbar back over
        // a playing movie.
        const outgoing = trackVideoOsdMount();
        const incoming = trackVideoOsdMount();

        outgoing();
        expect(isVideoOsdMounted()).toBe(true);

        incoming();
        expect(isVideoOsdMounted()).toBe(false);
    });

    it('ignores a release that has already been used', () => {
        const first = trackVideoOsdMount();
        first();
        first();

        const second = trackVideoOsdMount();
        expect(isVideoOsdMounted()).toBe(true);

        second();
        expect(isVideoOsdMounted()).toBe(false);
    });

    it('notifies subscribers on every change until they unsubscribe', () => {
        const observed: boolean[] = [];
        const unsubscribe = subscribeToVideoOsdPresence(() => {
            observed.push(isVideoOsdMounted());
        });

        const release = trackVideoOsdMount();
        expect(observed).toEqual([ true ]);

        release();
        expect(observed).toEqual([ true, false ]);

        unsubscribe();
        trackVideoOsdMount()();
        expect(observed).toEqual([ true, false ]);
    });
});
