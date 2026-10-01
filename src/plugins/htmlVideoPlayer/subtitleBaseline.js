// SlopTank modification notice: added by SlopTank on 2026-10-01 (c303).
/**
 * The shared subtitle size baseline of one player: the single value every
 * renderer multiplies by the user's text-size scale. Outside Picture in
 * Picture it is the proportional video-height baseline; while Document PiP is
 * open it is raised to the PiP readability floor and follows the PiP window
 * through its `resize` event. The override lives only here, so leaving PiP
 * removes it and the durable user preference is never written.
 * @module plugins/htmlVideoPlayer/subtitleBaseline
 */
import { getPipSubtitleBaseline, getSubtitleFontSize } from 'components/subtitlesettings/subtitleappearancehelper';

export class SubtitleBaseline {
    /**
     * Last valid baseline in CSS pixels, null until a video height is known.
     * @type {number | null}
     */
    fontSize = null;

    /**
     * Ratio of the baseline to the normal proportional baseline: 1 outside
     * PiP. Renderers that do not read the baseline (libass) multiply their
     * scale by it.
     * @type {number}
     */
    boost = 1;

    #videoHeight = null;
    #pip = null;
    #getVideoHeight;
    #onChange;

    /**
     * @param {Object} options - Collaborators of the owning player.
     * @param {() => number | undefined} options.getVideoHeight - Reads the
     * live rendered video LAYOUT height in CSS pixels (clientHeight). It must
     * not be a bounding rect: the dialog's entry animation scales it with a
     * transform, which made the restored baseline 20% of the real size.
     * @param {() => void} options.onChange - Called after the baseline
     * changes so every renderer can reapply it.
     */
    constructor({ getVideoHeight, onChange }) {
        this.#getVideoHeight = getVideoHeight;
        this.#onChange = onChange;
    }

    /**
     * Record a rendered video height observation. Invalid observations keep
     * the last valid baseline.
     * @param {number} videoHeight - Rendered video height in CSS pixels.
     * @returns {void}
     */
    setVideoHeight(videoHeight) {
        if (getSubtitleFontSize(videoHeight) === null) {
            return;
        }
        this.#videoHeight = videoHeight;
        this.#recompute();
    }

    /**
     * Start following a Document PiP window. Call after the player surface
     * has moved into it.
     * @param {Window} pipWindow - The Document PiP window.
     * @returns {void}
     */
    enterPip(pipWindow) {
        this.exitPip();
        const handler = () => this.#refreshFromLiveHeight();
        pipWindow.addEventListener('resize', handler);
        this.#pip = { window: pipWindow, handler };
        this.#refreshFromLiveHeight();
    }

    /**
     * Stop following the PiP window and drop the override. Call after the
     * player surface is back in the main window. Idempotent.
     * @returns {void}
     */
    exitPip() {
        if (!this.#pip) {
            return;
        }
        this.#pip.window.removeEventListener('resize', this.#pip.handler);
        this.#pip = null;
        this.#refreshFromLiveHeight();
    }

    #refreshFromLiveHeight() {
        const live = this.#getVideoHeight();
        if (getSubtitleFontSize(live) !== null) {
            this.#videoHeight = live;
        }
        this.#recompute();
    }

    #recompute() {
        const normal = getSubtitleFontSize(this.#videoHeight);
        if (normal === null) {
            return;
        }
        this.fontSize = this.#pip ?
            getPipSubtitleBaseline(this.#videoHeight, this.#pip.window.innerHeight) :
            normal;
        this.boost = this.fontSize / normal;
        this.#onChange();
    }
}
