import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Hls from 'hls.js/dist/hls.js';
import Events from '../utils/events.ts';
import { MediaError } from 'types/mediaError';
import { bindEventsToHlsPlayer } from './htmlMediaHelper';

/**
 * Regression coverage for the frozen-video-page bug (t_260722_234509_771):
 * when HLS segment requests hang server-side, hls.js exhausts its own retry
 * ladder and reports a fatal network error with no HTTP response object (a
 * timeout, not a completed 4xx/5xx/CORS response). Drives the real hls.js
 * library (same import path as production: 'hls.js/dist/hls.js'), the real
 * event bus, and the real startLoad()/destroy() methods -- only the
 * triggering ERROR payload is synthesized, standing in for a genuine
 * server-side hang that isn't reproducible against a real server in a unit
 * test. The player must give up and surface an actionable error after a
 * bounded number of retries, never spin calling hls.startLoad() forever
 * with no user-visible feedback.
 */
beforeEach(() => {
    global.Hls = Hls;
});

afterEach(() => {
    delete global.Hls;
});

function fatalTimeoutErrorData() {
    return { type: Hls.ErrorTypes.NETWORK_ERROR, fatal: true, details: 'fragLoadTimeOut' };
}

describe('htmlMediaHelper: bindEventsToHlsPlayer fatal network error recovery', () => {
    it('gives up and rejects with NETWORK_ERROR instead of retrying forever on a hung server during startup', () => {
        const hls = new Hls({});
        const instance = {};
        let rejectCalls = 0;
        let rejectedWith;
        const reject = (value) => {
            rejectCalls += 1;
            rejectedWith = value;
        };

        bindEventsToHlsPlayer(instance, hls, {}, () => undefined, () => undefined, reject);

        // Simulate repeated fatal timeouts: hls.js already exhausted its own
        // internal retry ladder before each of these fires, and no fragment
        // ever buffers successfully (no progress) in between.
        for (let i = 0; i < 10; i++) {
            hls.trigger(Hls.Events.ERROR, fatalTimeoutErrorData());
        }

        expect(rejectCalls).toBe(1);
        expect(rejectedWith).toBe(MediaError.NETWORK_ERROR);
    });

    it('gives up and surfaces an error event instead of freezing during steady-state playback', () => {
        const hls = new Hls({});
        const instance = {};
        let errorEventCalls = 0;
        let errorEventDetail;
        Events.on(instance, 'error', (event, detail) => {
            errorEventCalls += 1;
            errorEventDetail = detail;
        });

        // Steady-state: manifest already parsed, reject has already been
        // consumed and nulled out by the resolve path.
        bindEventsToHlsPlayer(instance, hls, {}, () => undefined, () => undefined, null);

        for (let i = 0; i < 10; i++) {
            hls.trigger(Hls.Events.ERROR, fatalTimeoutErrorData());
        }

        expect(errorEventCalls).toBe(1);
        expect(errorEventDetail).toEqual({ type: MediaError.NETWORK_ERROR });
    });

    it('still retries a single transient fatal network error instead of giving up immediately', () => {
        const hls = new Hls({});
        const instance = {};
        let rejectCalls = 0;
        const reject = () => {
            rejectCalls += 1;
        };

        bindEventsToHlsPlayer(instance, hls, {}, () => undefined, () => undefined, reject);

        hls.trigger(Hls.Events.ERROR, fatalTimeoutErrorData());

        expect(rejectCalls).toBe(0);
    });

    it('resets the retry budget once a fragment buffers successfully again', () => {
        const hls = new Hls({});
        const instance = {};
        let rejectCalls = 0;
        const reject = () => {
            rejectCalls += 1;
        };

        bindEventsToHlsPlayer(instance, hls, {}, () => undefined, () => undefined, reject);

        // Two transient failures, each followed by genuine progress, should
        // never exhaust the retry budget: this is a healthy, if flaky, link.
        hls.trigger(Hls.Events.ERROR, fatalTimeoutErrorData());
        hls.trigger(Hls.Events.FRAG_BUFFERED, {});
        hls.trigger(Hls.Events.ERROR, fatalTimeoutErrorData());
        hls.trigger(Hls.Events.FRAG_BUFFERED, {});
        hls.trigger(Hls.Events.ERROR, fatalTimeoutErrorData());

        expect(rejectCalls).toBe(0);
    });
});
