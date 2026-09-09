// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-09.
/**
 * Playback OSD transport-state controller.
 * @module controllers/playback/video/TransportControl
 */

/**
 * Owns the state presentation shared by the existing transport buttons.
 */
export default class TransportControl {
    /**
     * @param {Object} options - Transport elements and adapters.
     * @param {Object} options.playback - Playback manager adapter.
     * @param {Function} options.setElementTitle - Accessible title setter.
     * @param {Function} options.translate - String translation adapter.
     * @param {HTMLElement} options.view - Video OSD root.
     */
    constructor(options) {
        this.playback = options.playback;
        this.setElementTitle = options.setElementTitle;
        this.translate = options.translate;
        this.pauseButton = options.view.querySelector('.btnPause');
        this.pauseIcon = this.pauseButton.querySelector('.material-icons');
        this.previousButton = options.view.querySelector('.btnPreviousTrack');
        this.nextButton = options.view.querySelector('.btnNextTrack');
    }

    /**
     * Render the existing pause button for the player's current state.
     * @param {boolean} isPaused - Whether playback is paused.
     * @returns {void}
     */
    updatePlayPauseState(isPaused) {
        this.pauseIcon.classList.remove('play_arrow', 'pause');
        const icon = isPaused ? 'play_arrow' : 'pause';
        const title = this.translate(isPaused ? 'Play' : 'ButtonPause');
        this.pauseIcon.classList.add(icon);
        this.setElementTitle(this.pauseButton, `${title} (K)`, title);
    }

    /**
     * Reveal the existing previous/next controls for a multi-item playlist.
     * @returns {Promise<void>}
     */
    async updatePlaylist() {
        try {
            const playlist = await this.playback.getPlaylist();
            if (playlist?.length > 1) {
                this.previousButton.classList.remove('hide');
                this.nextButton.classList.remove('hide');
                this.previousButton.disabled = false;
                this.nextButton.disabled = false;
            }
        } catch (error) {
            console.error('[VideoPlayer] failed to get playlist', error);
        }
    }

    /**
     * Restore the session's saved playback rate when it exists.
     * @param {Object} player - Active player.
     * @param {string|null} savedRate - Persisted playback rate.
     * @returns {void}
     */
    restorePlaybackRate(player, savedRate) {
        if (savedRate !== null) player.setPlaybackRate(savedRate);
    }
}
