// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import { afterEach, describe, expect, it, vi } from 'vitest';

import toast from './toast';

/**
 * Coverage for queue task c180's toast `immediate` option: the owner asked
 * for the subtitle-cycle hotkey's toast to appear "immediately", but the
 * shared toast has always waited 300ms before fading in. This adds an
 * opt-in `immediate` flag (default unchanged) rather than a second toast
 * system.
 */
/**
 * toast.ts keeps its `.toastContainer` in a module-level singleton that
 * outlives any single test (it is only ever created once per real page
 * load). Clearing `document.body.innerHTML` between tests would detach
 * that container from the live document while the module still holds a
 * reference to it, so a later test's toast would be appended into a
 * disconnected tree and never be found by a `document.querySelector`
 * against the real document. Instead, always read the most recently
 * appended `.toast` element, matching how the container actually behaves
 * across a page's lifetime.
 */
function latestToast(): Element | null {
    const toasts = document.querySelectorAll('.toast');
    return toasts.length ? toasts[toasts.length - 1] : null;
}

describe('toast', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the default 300ms delay before becoming visible for a plain string call', () => {
        vi.useFakeTimers();

        toast('Hello');
        const elem = latestToast();

        expect(elem?.classList.contains('toastVisible')).toBe(false);

        vi.advanceTimersByTime(299);
        expect(elem?.classList.contains('toastVisible')).toBe(false);

        vi.advanceTimersByTime(1);
        expect(elem?.classList.contains('toastVisible')).toBe(true);

        // Flush this toast's own removal so it does not linger into the
        // next test's latestToast() lookup.
        vi.advanceTimersByTime(3600);
    });

    it('becomes visible immediately when options.immediate is true', () => {
        vi.useFakeTimers();

        toast({ text: 'Subtitles: English', immediate: true });
        const elem = latestToast();

        expect(elem?.textContent).toBe('Subtitles: English');
        expect(elem?.classList.contains('toastVisible')).toBe(true);

        vi.advanceTimersByTime(3600);
    });

    it('still removes an immediate toast on the normal visible-then-fade schedule', () => {
        vi.useFakeTimers();

        toast({ text: 'Subtitles: Off', immediate: true });
        const elem = latestToast();

        // Visible-duration (3000ms) then the fade-out class, mirroring the
        // delayed path's animateRemove() schedule.
        vi.advanceTimersByTime(2999);
        expect(elem?.classList.contains('toastHide')).toBe(false);

        vi.advanceTimersByTime(1);
        expect(elem?.classList.contains('toastHide')).toBe(true);

        // Then removed from the DOM after the fade-out transition.
        vi.advanceTimersByTime(300);
        expect(elem?.isConnected).toBe(false);
    });
});
