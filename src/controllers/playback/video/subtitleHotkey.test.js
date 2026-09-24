// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import { describe, expect, it } from 'vitest';

import { createSubtitleHotkey } from './subtitleHotkey';

/**
 * Coverage for queue task c180: the owner's requested 'c'/'C' subtitle-cycle
 * hotkey, with an immediate toast naming the track now selected.
 *
 * The actual track switch is required to go through inputManager's
 * 'changesubtitletrack' command (so keyboard, remote and gamepad triggers
 * share one code path -- see video/index.js's key binding), so
 * dispatchCommand is injected here as the seam a real caller wires to
 * inputManager.handleCommand; this module reads the result back through the
 * same playback accessors SubtitleTrackMenu.js already uses rather than
 * re-implementing the cycle.
 */
function fakePlayer() {
    return { id: 'player-1' };
}

/**
 * A real-but-test-configured implementation of the playback surface this
 * module calls, matching SubtitleTrackMenu.test.jsx's style: stream state is
 * mutated by dispatchCommand, not by this fake independently re-deriving it.
 */
function fakePlayback({ tracks, startIndex = -1 }) {
    let currentIndex = startIndex;
    return {
        subtitleTracks: () => tracks,
        getSubtitleStreamIndex: () => currentIndex,
        getSubtitleStream: (_, index) => tracks.find(t => t.Index === index),
        // Test-only seam: real dispatch goes through inputManager, which
        // calls playbackManager.changeSubtitleStream() and mutates this same
        // state; this fake mirrors just that one effect.
        advanceForTest: () => {
            const indexInList = tracks.findIndex(t => t.Index === currentIndex);
            const nextIndexInList = indexInList + 1;
            currentIndex = nextIndexInList >= tracks.length ? -1 : tracks[nextIndexInList].Index;
        }
    };
}

function fakeTranslate() {
    const calls = [];
    const translate = (key, ...args) => {
        calls.push([ key, ...args ]);
        if (key === 'Off') return 'Off';
        if (key === 'NoSubtitlesAvailable') return 'No subtitles available';
        if (key === 'SubtitleTrackToast') return `Subtitles: ${args[0]}`;
        return key;
    };
    return { translate, calls };
}

function fakeToast() {
    const messages = [];
    return { showToast: message => messages.push(message), messages };
}

describe('subtitleHotkey', () => {
    it('cycles through two tracks and off, toasting the right text each time', () => {
        const tracks = [
            { Index: 2, DisplayTitle: 'English' },
            { Index: 3, DisplayTitle: 'French' }
        ];
        const playback = fakePlayback({ tracks, startIndex: -1 });
        const { translate } = fakeTranslate();
        const { showToast, messages } = fakeToast();
        const dispatchCommand = () => playback.advanceForTest();
        const player = fakePlayer();

        const hotkey = createSubtitleHotkey({ playback, dispatchCommand, translate, showToast });

        hotkey.cycle(player);
        expect(messages).toEqual([ 'Subtitles: English' ]);

        hotkey.cycle(player);
        expect(messages).toEqual([ 'Subtitles: English', 'Subtitles: French' ]);

        hotkey.cycle(player);
        expect(messages).toEqual([ 'Subtitles: English', 'Subtitles: French', 'Subtitles: Off' ]);

        hotkey.cycle(player);
        expect(messages).toEqual([
            'Subtitles: English', 'Subtitles: French', 'Subtitles: Off', 'Subtitles: English'
        ]);
    });

    it('produces distinct toast text for two same-language tracks via DisplayTitle', () => {
        const tracks = [
            { Index: 5, Language: 'eng', DisplayTitle: 'English' },
            { Index: 6, Language: 'eng', DisplayTitle: 'English (Signs & Songs)' }
        ];
        const playback = fakePlayback({ tracks, startIndex: 5 });
        const { translate } = fakeTranslate();
        const { showToast, messages } = fakeToast();
        const dispatchCommand = () => playback.advanceForTest();

        const hotkey = createSubtitleHotkey({ playback, dispatchCommand, translate, showToast });

        hotkey.cycle(fakePlayer());

        expect(messages).toEqual([ 'Subtitles: English (Signs & Songs)' ]);
    });

    it('shows "No subtitles available" and does not dispatch when the source has no subtitle streams', () => {
        const playback = fakePlayback({ tracks: [] });
        const { translate } = fakeTranslate();
        const { showToast, messages } = fakeToast();
        let dispatchCount = 0;
        const dispatchCommand = () => {
            dispatchCount++;
        };

        const hotkey = createSubtitleHotkey({ playback, dispatchCommand, translate, showToast });

        hotkey.cycle(fakePlayer());

        expect(messages).toEqual([ 'No subtitles available' ]);
        expect(dispatchCount).toBe(0);
    });

    it('does nothing when there is no current player', () => {
        const playback = fakePlayback({ tracks: [ { Index: 0, DisplayTitle: 'English' } ] });
        const { translate } = fakeTranslate();
        const { showToast, messages } = fakeToast();
        let dispatchCount = 0;
        const dispatchCommand = () => {
            dispatchCount++;
        };

        const hotkey = createSubtitleHotkey({ playback, dispatchCommand, translate, showToast });

        hotkey.cycle(null);

        expect(messages).toEqual([]);
        expect(dispatchCount).toBe(0);
    });
});
