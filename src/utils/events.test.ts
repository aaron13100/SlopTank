// SlopTank modification notice: added or changed by SlopTank on 2026-09-06, 2026-09-09.
import { beforeEach, describe, expect, it } from 'vitest';
import eventsUtils from './events';

/**
 * Real (non-mock) call recorder: a plain closure that appends its argument
 * list to `calls` instead of returning a canned value. Used in place of
 * vi.fn() so these tests exercise Events against genuine function values
 * (exactly what production code passes) rather than a mocking-library
 * double.
 */
function recordCalls(): { calls: unknown[][]; fn: (...args: unknown[]) => void } {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
        calls.push(args);
    };
    return { calls, fn };
}

describe('Utils: events', () => {
    describe('Method: on', () => {
        it('should throw error if object is null', () => {
            const call = () => eventsUtils.on(null, 'testEvent', () => undefined);

            expect(call).toThrowError(new Error('obj cannot be null!'));
        });

        it('should init object callbacks with testEvent type if it does not exist', () => {
            const obj = {};
            const callback = () => undefined;

            eventsUtils.on(obj, 'testEvent', callback);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [callback]
            });
        });

        it('should add callback to existing object callbacks', () => {
            const initialCallback = () => undefined;
            const obj = {
                _callbacks: { testEvent: [initialCallback] }
            };
            const otherCallback = () => undefined;

            eventsUtils.on(obj, 'testEvent', otherCallback);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [initialCallback, otherCallback]
            });
        });

        // Regression coverage for c160 / t_260813_010357_439: appRouter.onRequestFail
        // was undefined (the method had been removed) and Events.on registered it
        // anyway, so the first 'requestfail' trigger threw deep inside
        // jellyfin-apiclient and replaced a real 401 Response with a generic
        // "Connection Failure" dialog. A non-function listener must be rejected
        // at registration time, with enough context to find the call site, and
        // must never crash the caller.
        it('should reject a non-function listener, log the event type/typeof/target, and not register it', () => {
            const originalConsoleError = console.error;
            const errorCalls: unknown[][] = [];
            console.error = (...args: unknown[]) => {
                errorCalls.push(args);
            };

            try {
                // Cast mirrors the real bug shape: appRouter is imported from a
                // plain .js file, so appRouter.onRequestFail is typed `any` and a
                // removed method resolves to `undefined` without tsc ever seeing
                // a mismatch.
                const brokenCallback = undefined as unknown as Parameters<typeof eventsUtils.on>[2];
                const obj: Record<string, unknown> = { constructor: { name: 'AppRouter' } };

                eventsUtils.on(obj, 'requestfail', brokenCallback);

                expect(obj._callbacks).toBeUndefined();
                expect(errorCalls).toHaveLength(1);
                const [message, ...rest] = errorCalls[0];
                // The message string alone carries all three pieces needed to find
                // the call site: event type, typeof the bad value, and the
                // target's constructor name. The raw target is also passed as a
                // trailing arg so a real browser console can inspect it directly.
                expect(String(message)).toContain('requestfail');
                expect(String(message)).toContain('undefined');
                expect(String(message)).toContain('AppRouter');
                expect(rest).toEqual([obj]);
            } finally {
                console.error = originalConsoleError;
            }
        });

        it('should still register and fire a valid function listener (no false-positive guard)', () => {
            const originalConsoleError = console.error;
            const errorCalls: unknown[][] = [];
            console.error = (...args: unknown[]) => {
                errorCalls.push(args);
            };

            try {
                const obj = {};
                const { calls, fn: callback } = recordCalls();

                eventsUtils.on(obj, 'testEvent', callback);
                eventsUtils.trigger(obj, 'testEvent', ['testValue']);

                expect(obj).toHaveProperty('_callbacks', {
                    testEvent: [callback]
                });
                expect(calls).toEqual([[{ type: 'testEvent' }, 'testValue']]);
                expect(errorCalls).toHaveLength(0);
            } finally {
                console.error = originalConsoleError;
            }
        });
    });

    describe('Method: off', () => {
        let obj: { _callbacks: { testEvent: Array<(...args: unknown[]) => void> } };
        let initialCallback: (...args: unknown[]) => void;
        beforeEach(() => {
            initialCallback = () => undefined;
            obj = {
                _callbacks: { testEvent: [initialCallback] }
            };
        });

        it('should remove existing callbacks', () => {
            eventsUtils.off(obj, 'testEvent', initialCallback);

            expect(obj).toHaveProperty('_callbacks', { testEvent: [] });
        });
        it('should not remove callback if it is not registered for the given event', () => {
            eventsUtils.off(obj, 'otherEvent', initialCallback);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [initialCallback],
                otherEvent: []
            });
        });
        it('should not remove callback if it is not registered', () => {
            const callbackToRemove = () => undefined;

            eventsUtils.off(obj, 'testEvent', callbackToRemove);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [initialCallback]
            });
        });

        // Symmetric with the on() guard: a non-function fn passed to off() is
        // already runtime-harmless (indexOf just never matches), but logging it
        // surfaces the caller bug (e.g. the wrong reference passed to
        // unregister, silently leaking the real listener) instead of hiding it.
        it('should reject a non-function listener and leave existing callbacks untouched', () => {
            const originalConsoleError = console.error;
            const errorCalls: unknown[][] = [];
            console.error = (...args: unknown[]) => {
                errorCalls.push(args);
            };

            try {
                const brokenCallback = undefined as unknown as Parameters<typeof eventsUtils.off>[2];

                eventsUtils.off(obj, 'testEvent', brokenCallback);

                expect(obj).toHaveProperty('_callbacks', {
                    testEvent: [initialCallback]
                });
                expect(errorCalls).toHaveLength(1);
                const [message] = errorCalls[0];
                expect(String(message)).toContain('testEvent');
                expect(String(message)).toContain('undefined');
            } finally {
                console.error = originalConsoleError;
            }
        });
    });

    describe('Method: trigger', () => {
        it('should trigger registered callback with given parameters', () => {
            const obj = {};
            const { calls, fn: callback } = recordCalls();
            eventsUtils.on(obj, 'testEvent', callback);

            eventsUtils.trigger(obj, 'testEvent', ['testValue1', 'testValue2']);

            expect(calls).toEqual([
                [{ type: 'testEvent' }, 'testValue1', 'testValue2']
            ]);
        });
    });
});
