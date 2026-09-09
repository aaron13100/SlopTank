// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-09.
/**
 * Playback OSD mute and volume controller.
 * @module controllers/playback/video/VolumeControl
 */

/**
 * Owns volume control state and user input while delegating playback and host
 * capability decisions through adapters.
 */
export default class VolumeControl {
    /**
     * @param {Object} options - Volume elements and boundary adapters.
     * @param {HTMLElement} options.container - OSD volume control wrapper.
     * @param {Function} options.getPlayer - Returns the active player.
     * @param {Function} options.hasPhysicalVolumeControl - Host capability check.
     * @param {Object} options.playback - Playback volume command adapter.
     * @param {Function} options.translate - String translation adapter.
     */
    constructor(options) {
        this.container = options.container;
        this.getPlayer = options.getPlayer;
        this.hasPhysicalVolumeControl = options.hasPhysicalVolumeControl;
        this.playback = options.playback;
        this.translate = options.translate;
        this.muteButton = this.container.querySelector('.buttonMute');
        this.muteIcon = this.muteButton.querySelector('.material-icons');
        this.sliderContainer = this.container.querySelector('.osdVolumeSliderContainer');
        this.slider = this.container.querySelector('.osdVolumeSlider');

        this.slider.enableKeyboardDragging();
        this.muteButton.addEventListener('click', this.onMuteClick);
        this.slider.addEventListener('input', this.onSliderInput);
    }

    onMuteClick = () => {
        this.playback.toggleMute(this.getPlayer());
    };

    onSliderInput = event => {
        this.playback.setVolume(event.target.value, this.getPlayer());
    };

    /**
     * Render player capability, mute, and current volume state.
     * @param {Object} state - Current player volume state.
     * @param {boolean} state.isMuted - Whether playback is muted.
     * @param {string[]} state.supportedCommands - Player command names.
     * @param {number} state.volumeLevel - Volume from 0 through 100.
     * @returns {void}
     */
    update({ isMuted, supportedCommands, volumeLevel }) {
        let showMute = supportedCommands.includes('Mute');
        let showSlider = supportedCommands.includes('SetVolume');
        if (this.hasPhysicalVolumeControl(this.getPlayer())) {
            showMute = false;
            showSlider = false;
        }

        this.muteButton.classList.toggle('hide', !showMute);
        this.sliderContainer.classList.toggle('hide', !showSlider);
        this.muteIcon.classList.remove('volume_off', 'volume_up');
        this.muteIcon.classList.add(isMuted ? 'volume_off' : 'volume_up');
        this.muteButton.setAttribute(
            'title',
            `${this.translate(isMuted ? 'Unmute' : 'Mute')} (M)`
        );

        if (!this.slider.dragging) this.slider.value = volumeLevel || 0;
    }

    /**
     * Disable volume changes while no playback item is active.
     * @param {boolean} disabled - Whether the volume slider is unavailable.
     * @returns {void}
     */
    setDisabled(disabled) {
        this.slider.disabled = disabled;
    }

    /**
     * Remove the DOM listeners owned by this control.
     * @returns {void}
     */
    destroy() {
        this.muteButton.removeEventListener('click', this.onMuteClick);
        this.slider.removeEventListener('input', this.onSliderInput);
    }
}
