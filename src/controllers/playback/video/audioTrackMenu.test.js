// SlopTank modification notice: added or changed by SlopTank on 2026-09-25, 2026-09-27.
import { describe, expect, it } from 'vitest';

import { createAudioTrackMenu } from './audioTrackMenu';

/**
 * Regression coverage for queue task c288, the video/index.js sibling of
 * c209's dropped-promise fix: `showAudioTrackSelection`'s action-sheet
 * handler called `playback.setAudioStreamIndex(index, player)` without
 * returning it, so the outer `actionsheet.show().then(...).finally(resetIdle)`
 * chain settled (and reset the OSD idle timer) before the new audio stream
 * had actually taken effect, exactly like the c209 playbackManager callers
 * this same commit fixed. The fix returns that promise so the finally only
 * runs once the stream change itself has settled.
 */

/** A promise plus its resolve/reject, so the test controls when a boundary answers. */
function createDeferred() {
    let resolve;
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until cond() is truthy; throws after ~3s so failures stay fast. */
async function waitFor(cond) {
    for (let i = 0; i < 300; i++) {
        if (cond()) {
            return;
        }
        await sleep(10);
    }
    throw new TypeError('waitFor: condition never became true');
}

describe('audioTrackMenu', () => {
    it('resets the OSD idle timer only after the picked audio stream has actually changed', async () => {
        const player = { id: 'player-1' };
        const audioTracks = [
            { Index: 1, DisplayTitle: 'English' },
            { Index: 2, DisplayTitle: 'French' }
        ];
        const setAudioStreamIndexCalls = [];
        const setAudioStreamIndexDeferred = createDeferred();
        const playback = {
            audioTracks: () => audioTracks,
            getAudioStreamIndex: () => 1,
            setAudioStreamIndex: (index, p) => {
                setAudioStreamIndexCalls.push([ index, p ]);
                return setAudioStreamIndexDeferred.promise;
            }
        };

        let actionSheetOptions;
        const actionSheetDeferred = createDeferred();
        const actionsheet = {
            show: (options) => {
                actionSheetOptions = options;
                return actionSheetDeferred.promise;
            }
        };

        const resetIdleCalls = [];
        const audioTrackMenu = createAudioTrackMenu({
            getPlayer: () => player,
            playback,
            loadActionSheet: () => Promise.resolve(actionsheet),
            resetIdle: () => resetIdleCalls.push(true)
        });

        audioTrackMenu.show.call(document.createElement('button'));

        // The menu-open reset (an unconditional setTimeout(resetIdle, 0) once
        // the action sheet is showing) fires before the user picks anything.
        await waitFor(() => actionSheetOptions !== undefined);
        await waitFor(() => resetIdleCalls.length === 1);
        expect(actionSheetOptions.items.map(i => i.id)).toEqual([ 1, 2 ]);

        // The user picks French (Index 2), different from the current track.
        actionSheetDeferred.resolve('2');

        await waitFor(() => setAudioStreamIndexCalls.length === 1);
        expect(setAudioStreamIndexCalls[0]).toEqual([ 2, player ]);

        // The stream change has not settled yet: the finally's idle reset
        // must not have fired a second time.
        await sleep(30);
        expect(resetIdleCalls.length).toBe(1);

        setAudioStreamIndexDeferred.resolve();

        await waitFor(() => resetIdleCalls.length === 2);
    });
});
