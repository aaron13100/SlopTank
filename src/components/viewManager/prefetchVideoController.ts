// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
import { AppType } from 'constants/appType';

export type ImportControllerFn = (
    appType: AppType,
    controller: string,
    view: string
) => Promise<unknown>;

type Scheduler = (run: () => void) => void;

/** Used only when the browser has no requestIdleCallback (older Safari). */
const IDLE_FALLBACK_MS = 1500;

const defaultScheduler: Scheduler = (run) => {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run);
    } else {
        setTimeout(run, IDLE_FALLBACK_MS);
    }
};

/**
 * Speculatively warms the video player controller (its JS chunk and legacy
 * view HTML) while the item details page is on screen, at idle priority so
 * it never competes with the details page's own fetches (Similar, posters,
 * UserViews). By the time the user reaches the Play button, the fetch,
 * parse and top-level module evaluation this normally pays for only after
 * the click has often already happened.
 *
 * A miss costs nothing: `importController` here is the exact function real
 * navigation uses, so a warmed chunk is reused (not re-fetched) on the real
 * click, and a failed or skipped warmup just leaves the real navigation to
 * fetch and report normally, same as before this existed.
 */
export function prefetchVideoController(
    appType: AppType,
    controller: string,
    importController: ImportControllerFn,
    schedule: Scheduler = defaultScheduler
): void {
    if (controller !== 'itemDetails/index') return;

    schedule(() => {
        importController(appType, 'playback/video/index', 'playback/video/index.html')
            .catch(() => { /* warmup only; a real click retries and surfaces the failure itself */ });
    });
}
