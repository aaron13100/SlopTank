// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns whether the video OSD chrome (header and bottom controls) is shown,
 * its slide animations, and the idle auto-hide timer.
 *
 * video/index.js constructs this and injects its dependencies.
 * @module controllers/playback/video/osdVisibility
 */
import Events from '../../../utils/events.ts';
import { EventType } from 'constants/eventType';
import mouseManager from '../../../scripts/mouseManager';
import focusManager from '../../../components/focusManager';
import layoutManager from '../../../components/layoutManager';
import dom from '../../../utils/dom';

/**
 * Build the OSD visibility controller.
 * @param {object} options - Elements and adapters this module does not own.
 * @param {HTMLElement} options.headerElement - The page header chrome.
 * @param {HTMLElement} options.osdBottomElement - The bottom OSD controls container.
 * @param {Function} options.canAutoHide - Returns whether idle conditions this module does not own allow auto-hiding the OSD.
 * @param {Function} options.toggleSubtitleSync - Toggles the subtitle sync overlay; called with 'hide' to force-hide it.
 * @returns {{ showOsd: Function, hideOsd: Function, toggleOsd: Function, resetIdle: Function, stopOsdHideTimer: Function, getVisibleMenu: Function, setVisibleMenu: Function }}
 */
export function createOsdVisibility(options) {
    const { headerElement, osdBottomElement, canAutoHide, toggleSubtitleSync } = options;

    let currentVisibleMenu;
    let osdHideTimeout;
    const transitionEndEventName = dom.whichTransitionEvent();

    function startOsdHideTimer() {
        stopOsdHideTimer();
        osdHideTimeout = setTimeout(hideOsd, 3e3);
    }

    function slideDownToShow(elem) {
        clearHideAnimationEventListeners(elem);
        elem.classList.remove('hide');
        elem.classList.remove('osdHeader-hidden');
    }

    function slideUpToHide(elem) {
        clearHideAnimationEventListeners(elem);
        elem.classList.add('osdHeader-hidden');
        elem.addEventListener(transitionEndEventName, onHideAnimationComplete);
    }

    function clearHideAnimationEventListeners(elem) {
        elem.removeEventListener(transitionEndEventName, onHideAnimationComplete);
    }

    function onHideAnimationComplete(e) {
        const elem = e.target;
        if (elem !== osdBottomElement && elem !== headerElement) return;
        elem.classList.add('hide');
        elem.removeEventListener(transitionEndEventName, onHideAnimationComplete);
    }

    const _focus = function (focusElement) {
        // If no focus element is provided, try to keep current focus if it's valid,
        // otherwise default to pause button
        const currentFocus = focusElement || document.activeElement;
        if (!currentFocus || !focusManager.isCurrentlyFocusable(currentFocus)) {
            focusElement = osdBottomElement.querySelector('.btnPause');
        }

        if (focusElement) focusManager.focus(focusElement);
    };

    function showMainOsdControls(focusElement) {
        if (!currentVisibleMenu) {
            const elem = osdBottomElement;
            currentVisibleMenu = 'osd';
            clearHideAnimationEventListeners(elem);
            elem.classList.remove('hide');
            elem.classList.remove('videoOsdBottom-hidden');

            if (!layoutManager.mobile) {
                _focus(focusElement);
            }
            toggleSubtitleSync();
        } else if (currentVisibleMenu === 'osd' && !layoutManager.mobile) {
            _focus(focusElement);
        }
    }

    function hideMainOsdControls() {
        if (currentVisibleMenu === 'osd') {
            const elem = osdBottomElement;
            clearHideAnimationEventListeners(elem);
            elem.classList.add('videoOsdBottom-hidden');

            elem.addEventListener(transitionEndEventName, onHideAnimationComplete);
            currentVisibleMenu = null;
            toggleSubtitleSync('hide');

            // Firefox does not blur by itself
            if (osdBottomElement.contains(document.activeElement)
                || headerElement.contains(document.activeElement)) {
                document.activeElement.blur();
            }
        }
    }

    function showOsd(focusElement) {
        Events.trigger(document, EventType.SHOW_VIDEO_OSD, [ true ]);
        slideDownToShow(headerElement);
        showMainOsdControls(focusElement);
        resetIdle();
    }

    function hideOsd() {
        Events.trigger(document, EventType.SHOW_VIDEO_OSD, [ false ]);
        slideUpToHide(headerElement);
        hideMainOsdControls();
        mouseManager.hideCursor();
    }

    function toggleOsd() {
        if (currentVisibleMenu === 'osd') {
            hideOsd();
        } else if (!currentVisibleMenu) {
            showOsd();
        }
    }

    function stopOsdHideTimer() {
        if (osdHideTimeout) {
            clearTimeout(osdHideTimeout);
            osdHideTimeout = null;
        }
    }

    // TODO: Move all idle-related code to `inputManager` or `idleManager` or `idleHelper` (per dialog thing) and listen event from there.

    function resetIdle() {
        // Keep a recovery control visible while playback is paused (including
        // when a browser blocks autoplay after loading a permalink), and while
        // an in-player overlay is open: its controls belong to the OSD, so
        // hiding the OSD out from under the user mid-adjustment is wrong.
        if (currentVisibleMenu && canAutoHide()) {
            startOsdHideTimer();
        } else {
            stopOsdHideTimer();
        }
    }

    /**
     * The identifier of the currently visible OSD menu ('osd', 'upnext'), or a falsy value when none is visible.
     * @returns {string|null|undefined} The visible menu identifier.
     */
    function getVisibleMenu() {
        return currentVisibleMenu;
    }

    /**
     * Set the currently visible OSD menu identifier.
     * @param {string|null} value - The new visible menu identifier.
     * @returns {void}
     */
    function setVisibleMenu(value) {
        currentVisibleMenu = value;
    }

    return { showOsd, hideOsd, toggleOsd, resetIdle, stopOsdHideTimer, getVisibleMenu, setVisibleMenu };
}
