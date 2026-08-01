import { afterEach, describe, expect, it } from 'vitest';

import VolumeControl from './VolumeControl';

function createHarness({ physicalVolume = false, supportedCommands = [ 'Mute', 'SetVolume' ] } = {}) {
    document.body.innerHTML = `
        <div class="volumeButtons">
            <button class="buttonMute"><span class="material-icons volume_up"></span></button>
            <div class="osdVolumeSliderContainer">
                <input class="osdVolumeSlider" type="range" min="0" max="100" value="50">
            </div>
        </div>
    `;
    const player = { isLocalPlayer: true };
    const slider = document.querySelector('.osdVolumeSlider');
    let keyboardDraggingEnabled = 0;
    slider.enableKeyboardDragging = () => {
        keyboardDraggingEnabled++;
    };
    const volumeCalls = [];
    const muteCalls = [];
    const playback = {
        setVolume: (...args) => volumeCalls.push(args),
        toggleMute: (...args) => muteCalls.push(args)
    };
    const control = new VolumeControl({
        container: document.querySelector('.volumeButtons'),
        getPlayer: () => player,
        hasPhysicalVolumeControl: () => physicalVolume,
        playback,
        translate: key => key
    });

    control.update({ isMuted: false, supportedCommands, volumeLevel: 50 });
    return { control, keyboardDraggingEnabled, muteCalls, player, slider, volumeCalls };
}

describe('VolumeControl', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('preserves mute and slider commands while enabling keyboard dragging', () => {
        const harness = createHarness();

        document.querySelector('.buttonMute').click();
        harness.slider.value = '73';
        harness.slider.dispatchEvent(new Event('input', { bubbles: true }));

        expect(harness.keyboardDraggingEnabled).toBe(1);
        expect(harness.muteCalls).toEqual([[ harness.player ]]);
        expect(harness.volumeCalls).toEqual([[ '73', harness.player ]]);
    });

    it('renders muted state and leaves a dragged slider under user control', () => {
        const harness = createHarness();
        harness.slider.value = '37';
        harness.slider.dragging = true;

        harness.control.update({
            isMuted: true,
            supportedCommands: [ 'Mute', 'SetVolume' ],
            volumeLevel: 90
        });

        expect(document.querySelector('.buttonMute').title).toBe('Unmute (M)');
        expect(document.querySelector('.buttonMute .material-icons').classList.contains('volume_off')).toBe(true);
        expect(harness.slider.value).toBe('37');
    });

    it('disables the slider when playback has no active item', () => {
        const harness = createHarness();

        harness.control.setDisabled(true);
        expect(harness.slider.disabled).toBe(true);
        harness.control.setDisabled(false);
        expect(harness.slider.disabled).toBe(false);
    });

    it('fails closed for unsupported and physical-device volume controls', () => {
        const unsupported = createHarness({ supportedCommands: [] });
        expect(document.querySelector('.buttonMute').classList.contains('hide')).toBe(true);
        expect(document.querySelector('.osdVolumeSliderContainer').classList.contains('hide')).toBe(true);
        unsupported.control.destroy();

        const physical = createHarness({ physicalVolume: true });
        expect(document.querySelector('.buttonMute').classList.contains('hide')).toBe(true);
        expect(document.querySelector('.osdVolumeSliderContainer').classList.contains('hide')).toBe(true);
        physical.control.destroy();
    });
});
