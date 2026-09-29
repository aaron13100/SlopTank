// SlopTank modification notice: added or changed by SlopTank on 2026-09-23, 2026-09-29.
import { EventType } from 'constants/eventType';
import Events from '../../../utils/events.ts';

/**
 * The persistent now-playing title label on the video OSD.
 * @module controllers/playback/video/PersistentTitleControl
 */

/**
 * Show the title of what is playing only while the player controls are up.
 *
 * The composed title (series, season/episode number and episode name for TV;
 * title and year for movies) reaches this label through the same
 * VIDEO_TITLE_CHANGE document event the OSD header consumes, so the label
 * never grows a second title composer. Its visibility is driven by the same
 * SHOW_VIDEO_OSD document event osdVisibility fires when it shows or hides
 * the OSD chrome, following that state directly rather than deriving from
 * it: the label appears with the controls and leaves with them, windowed
 * and in full screen (owner request 2026-09-28, reversing the 2026-09-12
 * "always visible, Netflix style" request, which left the episode name on
 * screen over the movie after the controls faded).
 *
 * The element is decoration: aria-hidden in the markup, never focusable, and
 * pointer-events none via CSS. bind() registers its own teardown on the
 * view's viewdestroy event, so the document subscriptions never outlive the
 * view that owns them.
 */
export default class PersistentTitleControl {
    #title = '';
    #isOsdShowing = true;
    #element;
    #view;

    /**
     * @param {Object} options - View elements.
     * @param {HTMLElement} options.view - Video OSD root; hosts .persistentVideoTitle.
     */
    constructor(options) {
        this.#view = options.view;
        this.#element = options.view.querySelector('.persistentVideoTitle');
    }

    /**
     * Subscribe to the title and OSD visibility document events.
     * @returns {void}
     */
    bind() {
        Events.on(document, EventType.VIDEO_TITLE_CHANGE, this.#onTitleChange);
        Events.on(document, EventType.SHOW_VIDEO_OSD, this.#onOsdVisibility);
        this.#view.addEventListener('viewdestroy', () => this.destroy());
    }

    /**
     * Unsubscribe from the document events.
     * @returns {void}
     */
    destroy() {
        Events.off(document, EventType.VIDEO_TITLE_CHANGE, this.#onTitleChange);
        Events.off(document, EventType.SHOW_VIDEO_OSD, this.#onOsdVisibility);
    }

    #onTitleChange = (_event, title) => {
        this.#title = title || '';
        this.#element.textContent = this.#title;
        this.#updateVisibility();
    };

    #onOsdVisibility = (_event, isShowing) => {
        this.#isOsdShowing = Boolean(isShowing);
        this.#updateVisibility();
    };

    // Visible exactly while the OSD controls are visible AND there is a
    // title to show. Following isShowing directly (not inverting it) is
    // what keeps the label from ever outliving the controls again.
    #updateVisibility() {
        this.#element.classList.toggle('hide', !this.#isOsdShowing || !this.#title);
    }
}
