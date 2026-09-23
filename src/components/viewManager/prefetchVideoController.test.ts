// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppType } from 'constants/appType';

import { prefetchVideoController } from './prefetchVideoController';

/** Real (non-mock) call recorder, matching this repo's events.test.ts convention. */
function recordCalls<Args extends unknown[]>(returns: () => Promise<unknown>) {
    const calls: Args[] = [];
    const fn = (...args: Args) => {
        calls.push(args);
        return returns();
    };
    return { calls, fn };
}

/** Runs the scheduled callback immediately and synchronously, so a test can await it. */
function immediateScheduler() {
    const scheduled: Array<() => void> = [];
    return {
        schedule: (run: () => void) => { scheduled.push(run); },
        flush: () => scheduled.forEach((run) => { run(); })
    };
}

describe('prefetchVideoController', () => {
    it('warms the video controller and its view HTML while on the details page', async () => {
        const importer = recordCalls<[AppType, string, string]>(() => Promise.resolve([]));
        const { schedule, flush } = immediateScheduler();

        prefetchVideoController(AppType.Stable, 'itemDetails/index', importer.fn, schedule);
        flush();
        await Promise.resolve();

        expect(importer.calls).toEqual([
            [ AppType.Stable, 'playback/video/index', 'playback/video/index.html' ]
        ]);
    });

    it('does nothing on any route other than item details', () => {
        const importer = recordCalls<[AppType, string, string]>(() => Promise.resolve([]));
        const { schedule, flush } = immediateScheduler();

        for (const controller of [ 'playback/video/index', 'list', 'user/home/index', '' ]) {
            prefetchVideoController(AppType.Stable, controller, importer.fn, schedule);
        }
        flush();

        expect(importer.calls).toEqual([]);
    });

    it('never lets a warmup failure escape as an unhandled rejection', async () => {
        const importer = recordCalls<[AppType, string, string]>(() => Promise.reject(new Error('network down')));
        const { schedule, flush } = immediateScheduler();

        expect(() => {
            prefetchVideoController(AppType.Stable, 'itemDetails/index', importer.fn, schedule);
            flush();
        }).not.toThrow();

        // Let the rejected promise's .catch() settle before the test ends;
        // an unswallowed rejection here would fail the suite as an
        // unhandled rejection, not as a thrown exception above.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(importer.calls).toHaveLength(1);
    });

    describe('default scheduler', () => {
        const originalRequestIdleCallback = globalThis.requestIdleCallback;

        afterEach(() => {
            globalThis.requestIdleCallback = originalRequestIdleCallback;
            vi.useRealTimers();
        });

        it('uses requestIdleCallback when the browser provides one', () => {
            const idleCalls: Array<() => void> = [];
            globalThis.requestIdleCallback = ((cb: () => void) => {
                idleCalls.push(cb);
                return 0;
            }) as typeof requestIdleCallback;
            const importer = recordCalls<[AppType, string, string]>(() => Promise.resolve([]));

            prefetchVideoController(AppType.Stable, 'itemDetails/index', importer.fn);

            expect(idleCalls).toHaveLength(1);
            expect(importer.calls).toEqual([]);
            idleCalls[0]();
            expect(importer.calls).toEqual([
                [ AppType.Stable, 'playback/video/index', 'playback/video/index.html' ]
            ]);
        });

        it('falls back to a timeout when requestIdleCallback is unavailable', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (globalThis as any).requestIdleCallback;
            vi.useFakeTimers();
            const importer = recordCalls<[AppType, string, string]>(() => Promise.resolve([]));

            prefetchVideoController(AppType.Stable, 'itemDetails/index', importer.fn);
            expect(importer.calls).toEqual([]);

            vi.runAllTimers();

            expect(importer.calls).toEqual([
                [ AppType.Stable, 'playback/video/index', 'playback/video/index.html' ]
            ]);
        });
    });
});
