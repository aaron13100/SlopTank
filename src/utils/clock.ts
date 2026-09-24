// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Clock adapter: the one place application code reads wall-clock time.
 *
 * Code that needs "now" imports currentTimeMs() instead of calling
 * Date.now() / new Date() directly, so every time read goes through a single
 * seam that tests and future callers can reason about.
 */

/**
 * Current wall-clock time.
 * @returns {number} Milliseconds since the Unix epoch, identical to what
 *   `new Date().getTime()` returns at the same instant.
 */
export function currentTimeMs(): number {
    return Date.now();
}
