// SlopTank modification notice: added or changed by SlopTank on 2026-08-12, 2026-09-09.
/**
 * React bindings for the video OSD presence store.
 *
 * See components/playback/videoOsdPresence for why the app chrome asks the
 * mounted view rather than the address bar.
 */
import { useEffect, useSyncExternalStore } from 'react';

import {
    isVideoOsdMounted,
    subscribeToVideoOsdPresence,
    trackVideoOsdMount
} from 'components/playback/videoOsdPresence';

/**
 * Reads whether the video OSD is on screen, re-rendering when that changes.
 *
 * @returns True while at least one video OSD view is mounted.
 */
export function useIsVideoOsdMounted(): boolean {
    return useSyncExternalStore(subscribeToVideoOsdPresence, isVideoOsdMounted);
}

/**
 * Declares, for as long as the calling component is mounted, that it is
 * presenting the video OSD.
 *
 * @param isPresenting Whether this component is presenting the video OSD.
 */
export function useVideoOsdPresence(isPresenting: boolean): void {
    useEffect(() => {
        if (!isPresenting) return;
        return trackVideoOsdMount();
    }, [ isPresenting ]);
}
