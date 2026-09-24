// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import { afterEach, describe, expect, it } from 'vitest';

import { handleSpaceKeydown, isSubtitleCycleKeydown } from './videoHotkeys';

/**
 * Coverage for queue task c180 item 8: the owner believes Space toggles
 * play/pause, and today it only appears to work because the browser
 * activates whichever OSD button holds focus. The video page's own keydown
 * handler unconditionally forced playPause + preventDefault + stopPropagation
 * on non-TV layouts regardless of what held focus, which would hijack Space
 * away from a focused button/input, or from any open dialog/menu (subtitle
 * track menu, episode menu, subtitle sizer -- all built on dialogHelper's
 * `.dialogContainer .dialog.opened` markup, the same thing getOpenedDialog()
 * already checks for Escape).
 *
 * videoHotkeys.js exists specifically so this decision is testable with
 * real DOM elements/events and the real jsdom document, without pulling in
 * index.js's own module-scope side effects (importing index.js also
 * imports scripts/libraryMenu.js, whose loadNavDrawer() queries a real
 * `.mainDrawer` element unconditionally at import time and throws under
 * jsdom -- see videoDialogState.js's module comment).
 */
function recordCalls() {
    const calls = [];
    return { calls, fn: (...args) => calls.push(args) };
}

/**
 * Dispatch a real, bubbling, cancelable keydown on `target` and run
 * `handleSpaceKeydown` against the live event, so preventDefault and
 * stopPropagation are observed through real DOM behavior (event.
 * defaultPrevented, and whether a listener on the parent ever saw it) rather
 * than mocked methods.
 */
function fireSpaceKeydown(target, actions) {
    const parent = target.parentElement;
    let parentSawIt = false;
    const parentListener = () => {
        parentSawIt = true;
    };
    parent.addEventListener('keydown', parentListener);

    const targetListener = (e) => handleSpaceKeydown(e, actions);
    target.addEventListener('keydown', targetListener);

    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    target.removeEventListener('keydown', targetListener);
    parent.removeEventListener('keydown', parentListener);

    return { defaultPrevented: event.defaultPrevented, parentSawIt };
}

describe('handleSpaceKeydown', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('toggles play/pause and prevents the page scroll when focus is on the video surface', () => {
        const target = document.createElement('div');
        document.body.appendChild(target);
        const playPause = recordCalls();
        const showOsd = recordCalls();
        const onHandled = recordCalls();

        const result = fireSpaceKeydown(target, {
            playPause: playPause.fn,
            showOsd: showOsd.fn,
            focusElement: 'btnPause',
            onHandled: onHandled.fn
        });

        expect(playPause.calls).toEqual([ [] ]);
        expect(showOsd.calls).toEqual([ [ 'btnPause' ] ]);
        expect(onHandled.calls).toEqual([ [] ]);
        expect(result.defaultPrevented).toBe(true);
        expect(result.parentSawIt).toBe(false);
    });

    it('does not toggle play/pause, and lets the default happen, when focus is on a button', () => {
        const target = document.createElement('button');
        document.body.appendChild(target);
        const playPause = recordCalls();
        const showOsd = recordCalls();

        const result = fireSpaceKeydown(target, {
            playPause: playPause.fn,
            showOsd: showOsd.fn,
            focusElement: 'btnPause'
        });

        expect(playPause.calls).toEqual([]);
        expect(showOsd.calls).toEqual([ [] ]);
        expect(result.defaultPrevented).toBe(false);
        expect(result.parentSawIt).toBe(true);
    });

    it('does not toggle play/pause when focus is on an input', () => {
        const target = document.createElement('input');
        document.body.appendChild(target);
        const playPause = recordCalls();
        const showOsd = recordCalls();

        const result = fireSpaceKeydown(target, {
            playPause: playPause.fn,
            showOsd: showOsd.fn,
            focusElement: 'btnPause'
        });

        expect(playPause.calls).toEqual([]);
        expect(result.defaultPrevented).toBe(false);
    });

    it('does not toggle play/pause when a dialog (e.g. the subtitle track menu) is open, even if the target is a plain div', () => {
        const dialogContainer = document.createElement('div');
        dialogContainer.className = 'dialogContainer';
        const dialog = document.createElement('div');
        dialog.className = 'dialog opened';
        dialogContainer.appendChild(dialog);
        document.body.appendChild(dialogContainer);

        const target = document.createElement('div');
        document.body.appendChild(target);
        const playPause = recordCalls();
        const showOsd = recordCalls();

        const result = fireSpaceKeydown(target, {
            playPause: playPause.fn,
            showOsd: showOsd.fn,
            focusElement: 'btnPause'
        });

        expect(playPause.calls).toEqual([]);
        expect(result.defaultPrevented).toBe(false);
    });
});

describe('isSubtitleCycleKeydown', () => {
    it('is true for an unshifted "c"', () => {
        expect(isSubtitleCycleKeydown({ key: 'c', keyCode: 67, shiftKey: false })).toBe(true);
    });

    it('is true for a CapsLock-uppercased "C" with shiftKey false', () => {
        expect(isSubtitleCycleKeydown({ key: 'C', keyCode: 67, shiftKey: false })).toBe(true);
    });

    it('is false when Shift produced the uppercase "C"', () => {
        expect(isSubtitleCycleKeydown({ key: 'C', keyCode: 67, shiftKey: true })).toBe(false);
    });

    it('is false for an unrelated key', () => {
        expect(isSubtitleCycleKeydown({ key: 'k', keyCode: 75, shiftKey: false })).toBe(false);
    });
});
