// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-09-09.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Hls from 'hls.js/dist/hls.js';
import Events from '../utils/events.ts';
import { MediaError } from 'types/mediaError';
import { bindEventsToHlsPlayer, seekOnPlaybackStart } from './htmlMediaHelper';

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
    // @covers playback.error_recovery.hung_server_at_startup.gives_up_and_rejects
    // @covers audio_transcode.resume.hung_segment_at_startup.retries_then_surfaces
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

    // @covers playback.error_recovery.hung_server_steady_state.surfaces_error
    // @covers audio_transcode.resume.steady_state_stall.surfaces_instead_of_freezing
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

    // @covers playback.error_recovery.transient_error.retries_and_recovers
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

    // @covers playback.error_recovery.progress_resets_retry_budget
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

/**
 * Regression coverage for queue task c273 (t_260922_231151_281): a resume
 * seek (reload, permalink `t=` link, Continue Watching) can be silently
 * dropped, leaving playback at position 0 with no error.
 *
 * Root cause: when duration is not yet known, seekOnPlaybackStart deferred
 * the seek to the first of several media events, but only applied it if
 * `element.currentTime` was still EXACTLY 0 at that instant. On a
 * contended host (this project's normal operating condition, never a
 * "quiet box" exception), autoplay can advance currentTime by even a
 * fraction of a second before the event handler gets a turn, and once that
 * happens the exact-zero check never matches again: the seek is dropped
 * for good, not delayed.
 */
describe('htmlMediaHelper: seekOnPlaybackStart', () => {
    function fakeVideoElement({ duration }) {
        const target = new EventTarget();
        target.duration = duration;
        target.currentTime = 0;
        return target;
    }

    // @covers video.reload.seek_drop.currentTime_advanced_before_duration_known
    it('still applies the deferred seek even if currentTime already advanced past 0 before duration became known', () => {
        const element = fakeVideoElement({ duration: NaN });
        let mediaReadyCalls = 0;

        seekOnPlaybackStart({}, element, 200_000_000 /* 20s */, () => {
            mediaReadyCalls += 1;
        });

        // Autoplay ticked the position forward a little before duration
        // metadata arrived -- normal under real load, not a user seek.
        element.currentTime = 0.6;
        element.duration = 3600; // duration now known, well past the requested 20s

        element.dispatchEvent(new Event('durationchange'));

        expect(element.currentTime).toBe(20);
        expect(mediaReadyCalls).toBe(1);
    });

    it('still seeks exactly once when multiple deferred events fire in a row', () => {
        const element = fakeVideoElement({ duration: NaN });

        seekOnPlaybackStart({}, element, 100_000_000 /* 10s */, () => undefined);

        element.duration = 1800;
        element.dispatchEvent(new Event('loadedmetadata'));
        expect(element.currentTime).toBe(10);

        // A later, unrelated event on the same element must not re-seek.
        element.currentTime = 15;
        element.dispatchEvent(new Event('loadeddata'));
        expect(element.currentTime).toBe(15);
    });

    it('seeks immediately when duration is already known', () => {
        const element = fakeVideoElement({ duration: 1800 });

        seekOnPlaybackStart({}, element, 50_000_000 /* 5s */, () => undefined);

        expect(element.currentTime).toBe(5);
    });
});
