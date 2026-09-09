// SlopTank modification notice: added or changed by SlopTank on 2026-09-06, 2026-09-09.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Event {
    type: string;
}

type Callback = (e: Event, ...args: any[]) => void;

/**
 * Collapses to `never` when T is inferred as exactly `any` (as opposed to a
 * real, narrower type), and to T otherwise. `any` is the one type TypeScript
 * still refuses to assign into `never`, so a generic parameter typed
 * `NotAny<T>` rejects an `any`-typed argument at compile time while a
 * correctly-typed function value still flows through unchanged.
 *
 * This is the static half of the c160 fix (see `on`/`off` below): it makes a
 * non-function listener a type error wherever tsc can see a real type on the
 * argument. It does NOT catch appRouter.onRequestFail itself, or anything
 * else whose static type is already `any` because it crosses a plain .js
 * import boundary (checkJs is off project-wide) -- tsc has nothing to narrow
 * there, by construction. Closing that gap needs either typed .d.ts coverage
 * for the untyped source, or a type-aware ESLint rule such as
 * @typescript-eslint/no-unsafe-argument (requires switching this project's
 * ESLint config to type-checked linting, a project-wide change out of scope
 * for this fix). The runtime guard in `on`/`off` is what actually covers that
 * gap today.
 */
type NotAny<T> = 0 extends (1 & T) ? never : T;

/**
 * Best-effort identification of an event target for a diagnostic message.
 * Prefers the constructor name (e.g. "AppRouter") since that is what a
 * developer greps for in the source tree; falls back to
 * Object.prototype.toString for plain objects, null, and primitives.
 */
function describeTarget(obj: any): string {
    if (obj === null || obj === undefined) {
        return String(obj);
    }

    const ctorName = obj.constructor && obj.constructor.name;
    return ctorName && ctorName !== 'Object' ? ctorName : Object.prototype.toString.call(obj);
}

/** Pre-existing invariant, unchanged by this fix: obj identifies the event
 * target itself (not the listener), and a null/undefined target means the
 * caller wired something up wrong -- a programmer assertion that should
 * crash immediately rather than fail later at trigger time. */
function assertObjPresent(obj: any): void {
    if (!obj) {
        throw new Error('obj cannot be null!'); // allow-raw-error: programmer assertion (broken call site), not a user-facing error; pre-dates this fix and is out of its scope.
    }
}

function getCallbacks(obj: any, type: string): Callback[] {
    assertObjPresent(obj);

    obj._callbacks = obj._callbacks || {};

    let callbacks = obj._callbacks[type];

    if (!callbacks) {
        obj._callbacks[type] = [];
        callbacks = obj._callbacks[type];
    }

    return callbacks;
}

/**
 * Runtime guard shared by `on`/`off`: logs full context (event type, typeof
 * the offending value, and the target's identity) and returns false when fn
 * is not callable, so the caller can skip registration/removal instead of
 * either crashing (the c160 failure mode: a bad listener only surfaced once
 * jellyfin-apiclient tried to invoke it, replacing a real 401 Response with a
 * generic "Connection Failure" dialog) or silently doing nothing (which would
 * hide the bug entirely). One bad listener degrades to a console error
 * instead of an app-wide startup crash -- ~300 Events.on/off call sites exist
 * across a live media server, and a throw here would fail every one of them
 * for every user on the very next bad registration.
 */
function warnIfNotFunction(method: 'on' | 'off', obj: any, type: string, fn: unknown): fn is Callback {
    if (typeof fn === 'function') {
        return true;
    }

    // The entire point of this guard is to degrade a bad registration into a
    // console error instead of a crash, so building that message must not
    // itself become a new way to throw (e.g. an exotic obj whose
    // `constructor` getter throws). Fall back to a minimal, still-useful
    // message rather than let describeTarget's failure escape this path.
    let target: string;
    try {
        target = describeTarget(obj);
    } catch {
        target = '<target identification failed>';
    }

    console.error(
        `[Events.${method}] ignoring non-function listener for event type "${type}" ` +
        `(typeof fn === "${typeof fn}") on target ${target}`,
        obj
    );
    return false;
}

export default {
    on<T extends Callback>(obj: any, type: string, fn: NotAny<T>): void {
        assertObjPresent(obj);

        if (!warnIfNotFunction('on', obj, type, fn)) {
            return;
        }

        const callbacks = getCallbacks(obj, type);

        callbacks.push(fn);
    },

    off<T extends Callback>(obj: any, type: string, fn: NotAny<T>): void {
        assertObjPresent(obj);

        if (!warnIfNotFunction('off', obj, type, fn)) {
            return;
        }

        const callbacks = getCallbacks(obj, type);

        const i = callbacks.indexOf(fn);
        if (i !== -1) {
            callbacks.splice(i, 1);
        }
    },

    trigger(obj: any, type: string, args: any[] = []) {
        const eventArgs: [Event, ...any] = [{ type }, ...args];

        getCallbacks(obj, type).slice(0)
            .forEach(callback => {
                callback.apply(obj, eventArgs);
            });
    }
};
/* eslint-enable @typescript-eslint/no-explicit-any */
