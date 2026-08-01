import { afterEach, describe, expect, it } from 'vitest';

import TransportControl from './TransportControl';

function createHarness({ playlist = [] } = {}) {
    document.body.innerHTML = `
        <button class="btnPause"><span class="material-icons pause"></span></button>
        <button class="btnPreviousTrack hide" disabled></button>
        <button class="btnNextTrack hide" disabled></button>
    `;
    const playback = { getPlaylist: async () => playlist };
    const titleCalls = [];
    const control = new TransportControl({
        playback,
        setElementTitle: (...args) => titleCalls.push(args),
        translate: key => key,
        view: document.body
    });
    return { control, playback, titleCalls };
}

describe('TransportControl', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('renders the play and pause states without changing button layout', () => {
        const harness = createHarness();

        harness.control.updatePlayPauseState(true);
        expect(document.querySelector('.btnPause .material-icons').classList.contains('play_arrow')).toBe(true);
        expect(harness.titleCalls.at(-1)).toEqual([
            document.querySelector('.btnPause'),
            'Play (K)',
            'Play'
        ]);

        harness.control.updatePlayPauseState(false);
        expect(document.querySelector('.btnPause .material-icons').classList.contains('pause')).toBe(true);
    });

    it('reveals existing previous and next controls for a multi-item playlist', async () => {
        const harness = createHarness({ playlist: [ { Id: 'one' }, { Id: 'two' } ] });

        await harness.control.updatePlaylist();

        expect(document.querySelector('.btnPreviousTrack').classList.contains('hide')).toBe(false);
        expect(document.querySelector('.btnNextTrack').classList.contains('hide')).toBe(false);
        expect(document.querySelector('.btnPreviousTrack').disabled).toBe(false);
        expect(document.querySelector('.btnNextTrack').disabled).toBe(false);
    });

    it('restores a saved playback rate and leaves an absent rate unchanged', () => {
        const harness = createHarness();
        const playbackRates = [];
        const player = { setPlaybackRate: rate => playbackRates.push(rate) };

        harness.control.restorePlaybackRate(player, null);
        expect(playbackRates).toEqual([]);
        harness.control.restorePlaybackRate(player, '1.5');
        expect(playbackRates).toEqual([ '1.5' ]);
    });
});
