// SlopTank modification notice: added or changed by SlopTank on 2026-08-12, 2026-09-09.
/**
 * Tracks whether the video OSD is on screen, so the app chrome can follow the
 * view rather than the URL.
 *
 * The app layout draws the navigation toolbar, and the video OSD needs that
 * toolbar replaced by its own fading one. The layout renders above the routed
 * page, so it cannot ask its own children what they are showing, and asking
 * the address bar instead is what broke: the toolbar was suppressed by testing
 * `location.pathname === '/web/video'`, so the moment playback canonicalized
 * its address to `/w/<alias>` the same view was on screen under a path that
 * test did not know, and the navigation toolbar sat permanently over the movie
 * (reported 2026-08-12).
 *
 * A route cannot answer the question either: `/w/<alias>` renders the player
 * only once the alias resolves, and renders a spinner, a chooser or an error
 * page otherwise, all of which need the ordinary toolbar. Only the thing
 * actually mounted knows, so the mount declares it and the layout reads it.
 *
 * The count is a count rather than a flag because mounts overlap: React mounts
 * the incoming route before unmounting the outgoing one, and StrictMode mounts
 * every component twice in development. A flag would be cleared by the
 * outgoing view after the incoming one set it, leaving the navigation toolbar
 * drawn over a playing movie again.
 */

let mountedCount = 0;
const listeners = new Set<() => void>();

function notifyListeners(): void {
    listeners.forEach(listener => {
        listener();
    });
}

/**
 * Whether any mounted view is currently presenting the video OSD.
 *
 * @returns True while at least one video OSD view is mounted.
 */
export function isVideoOsdMounted(): boolean {
    return mountedCount > 0;
}

/**
 * Subscribes to changes in video OSD presence.
 *
 * @param listener Called after every change; read the value with isVideoOsdMounted.
 * @returns An unsubscribe function.
 */
export function subscribeToVideoOsdPresence(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Declares that a video OSD view is now on screen.
 *
 * @returns A release function for when that view goes away. Releasing twice is
 *          a no-op, so a caller cannot drive the count negative and leave the
 *          app permanently convinced a player is on screen.
 */
export function trackVideoOsdMount(): () => void {
    mountedCount += 1;
    notifyListeners();

    let released = false;
    return () => {
        if (released) return;
        released = true;
        mountedCount -= 1;
        notifyListeners();
    };
}
