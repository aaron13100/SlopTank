// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns translating keyboard, remote/gamepad command and pointer input on the
 * video page into OSD and playback actions, and attaching/detaching those
 * listeners.
 *
 * video/index.js constructs this and injects its dependencies.
 * @module controllers/playback/video/videoInputControl
 */
import browser from '../../../scripts/browser';
import dom from '../../../utils/dom';
import inputManager from '../../../scripts/inputManager';
import keyboardnavigation from '../../../scripts/keyboardNavigation';
import layoutManager from '../../../components/layoutManager';
import { getOpenedDialog } from './videoDialogState';
import { handleSpaceKeydown, isSubtitleCycleKeydown } from './videoHotkeys';
import { currentTimeMs } from 'utils/clock';

/**
 * Build the video page input controller.
 * @param {object} options - Elements and adapters this module does not own.
 * @param {HTMLElement} options.view - Video OSD root.
 * @param {object} options.osd - OSD visibility controller (showOsd, hideOsd, toggleOsd, resetIdle, getVisibleMenu).
 * @param {object} options.playback - Playback manager adapter.
 * @param {Function} options.getPlayer - Returns the current player.
 * @param {Function} options.getSubtitleSync - Returns the current subtitle sync overlay, or a falsy value.
 * @param {object} options.subtitleTrackMenu - Subtitle track menu (hasOpenOverlay, closeOverlays).
 * @param {object} options.subtitleHotkey - Subtitle cycle hotkey handler.
 * @param {Function} options.toggleStats - Toggles the stats overlay.
 * @param {HTMLElement} options.osdBottomElement - The bottom OSD controls container.
 * @param {HTMLElement} options.nowPlayingPositionSlider - The seek position slider.
 * @param {HTMLElement} options.btnRewind - The rewind button.
 * @param {HTMLElement} options.btnFastForward - The fast-forward button.
 * @returns {{ bind: Function, unbind: Function, bindViewGestures: Function, isMouseDown: Function, cancelPendingClick: Function }}
 */
export function createVideoInputControl(options) {
    const {
        view,
        osd,
        playback,
        getPlayer,
        getSubtitleSync,
        subtitleTrackMenu,
        subtitleHotkey,
        toggleStats,
        osdBottomElement,
        nowPlayingPositionSlider,
        btnRewind,
        btnFastForward
    } = options;

    let mouseIsDown = false;

    /**
         * Clicked element.
         * To skip 'click' handling on Firefox/Edge.
         */
    let clickedElement;
    let lastPointerMoveData;
    let playPauseClickTimeout;
    let lastPointerDown = 0;

    /**
     * Route a press outside an open in-player overlay to dismissing it, so the
     * overlay (and the live subtitle preview it drives) can never be stranded
     * on screen by any interaction other than its own close button.
     * @param {PointerEvent} e - Press anywhere in the document.
     * @returns {void}
     */
    function onOverlayDismissPointerDown(e) {
        if (!subtitleTrackMenu.hasOpenOverlay()
                || (e.target && dom.parentWithClass(e.target, 'subtitleSizer'))) {
            return;
        }

        subtitleTrackMenu.closeOverlays();

        // A press on the bare video would otherwise toggle playback, but
        // dismissing the overlay was the entire intent of that press. Presses
        // on the OSD chrome fall through, so its buttons still act on one press.
        if (!dom.parentWithClass(e.target, ['videoOsdBottom', 'skinHeader', 'upNextContainer'])) {
            e.stopPropagation();
            osd.showOsd();
        }
    }

    function onPointerMove(e) {
        if ((e.pointerType || (layoutManager.mobile ? 'touch' : 'mouse')) === 'mouse') {
            const eventX = e.screenX || e.clientX || 0;
            const eventY = e.screenY || e.clientY || 0;
            const obj = lastPointerMoveData;

            if (!obj) {
                lastPointerMoveData = {
                    x: eventX,
                    y: eventY
                };
                return;
            }

            if (Math.abs(eventX - obj.x) < 10 && Math.abs(eventY - obj.y) < 10) {
                return;
            }

            obj.x = eventX;
            obj.y = eventY;
            osd.showOsd();
        }
    }

    function onInputCommand(e) {
        const player = getPlayer();

        switch (e.detail.command) {
            case 'left':
                if (osd.getVisibleMenu() === 'osd') {
                    osd.showOsd();
                } else if (!osd.getVisibleMenu()) {
                    e.preventDefault();
                    playback.rewind(player);
                }

                break;

            case 'right':
                if (osd.getVisibleMenu() === 'osd') {
                    osd.showOsd();
                } else if (!osd.getVisibleMenu()) {
                    e.preventDefault();
                    playback.fastForward(player);
                }

                break;

            case 'pageup':
                playback.nextChapter(player);
                break;

            case 'pagedown':
                playback.previousChapter(player);
                break;

            case 'up':
            case 'down':
            case 'select':
            case 'menu':
            case 'info':
            case 'play':
            case 'playpause':
            case 'pause':
            case 'fastforward':
            case 'rewind':
            case 'next':
            case 'previous':
                osd.showOsd();
                break;

            case 'record':
                onRecordingCommand();
                osd.showOsd();
                break;

            case 'togglestats':
                toggleStats();
                break;

            case 'back':
                // Ignore command when some dialog is opened
                if (osd.getVisibleMenu() === 'osd' && !getOpenedDialog()) {
                    osd.hideOsd();
                    e.preventDefault();
                }
                break;
        }
    }

    function onRecordingCommand() {
        const btnRecord = view.querySelector('.btnRecord');

        if (!btnRecord.classList.contains('hide')) {
            btnRecord.click();
        }
    }

    function onClickCapture(e) {
        // Firefox/Edge emits `click` even if `preventDefault` was used on `keydown`
        // Ignore 'click' if another element was originally clicked
        if (!e.target.contains(clickedElement)) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }

    function onKeyDown(e) {
        clickedElement = e.target;

        const isKeyModified = e.ctrlKey || e.altKey || e.metaKey;

        // Skip modified keys
        if (isKeyModified) return;

        const key = keyboardnavigation.getKeyName(e);

        const btnPlayPause = osdBottomElement.querySelector('.btnPause');

        if (e.keyCode === 32) {
            handleSpaceKeydown(e, {
                playPause: () => playback.playPause(getPlayer()),
                showOsd: osd.showOsd,
                focusElement: btnPlayPause,
                // Trick Firefox with a null element to skip next click
                onHandled: () => { clickedElement = null; }
            });
            return;
        }

        if (layoutManager.tv && !osd.getVisibleMenu()) {
            // Change the behavior of some keys when the OSD is hidden
            switch (key) {
                case 'ArrowLeft':
                case 'ArrowRight':
                    if (!e.shiftKey) {
                        e.preventDefault();
                        osd.showOsd(nowPlayingPositionSlider);
                        nowPlayingPositionSlider.dispatchEvent(new KeyboardEvent(e.type, e));
                    }
                    return;
                case 'Enter':
                    if (e.target.tagName !== 'BUTTON') {
                        e.preventDefault();
                        playback.playPause(getPlayer());
                        osd.showOsd(btnPlayPause);
                    }
                    return;
            }
        }

        if (layoutManager.tv && keyboardnavigation.isNavigationKey(key)) {
            if (!e.shiftKey) osd.showOsd();
            return;
        }

        switch (key) {
            case 'Enter':
                osd.showOsd();
                break;
            case 'Escape':
            case 'Back':
                // Ignore key when some dialog is opened
                if (osd.getVisibleMenu() === 'osd' && !getOpenedDialog()) {
                    osd.hideOsd();
                    e.stopPropagation();
                }
                break;
            case 'k':
            case 'K':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.playPause(getPlayer());
                    osd.showOsd(btnPlayPause);
                }
                break;
            case 'ArrowUp':
            case 'Up':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.volumeUp(getPlayer());
                }
                break;
            case 'ArrowDown':
            case 'Down':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.volumeDown(getPlayer());
                }
                break;
            case 'l':
            case 'L':
            case 'ArrowRight':
            case 'Right':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.fastForward(getPlayer());
                    osd.showOsd(btnFastForward);
                }
                break;
            case 'j':
            case 'J':
            case 'ArrowLeft':
            case 'Left':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.rewind(getPlayer());
                    osd.showOsd(btnRewind);
                }
                break;
            case 'f':
            case 'F':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.toggleFullscreen(getPlayer());
                }
                break;
            case 'm':
            case 'M':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.toggleMute(getPlayer());
                }
                break;
            case 'c':
            case 'C':
                if (isSubtitleCycleKeydown(e)) {
                    e.preventDefault();
                    subtitleHotkey.cycle(getPlayer());
                }
                break;
            case 'p':
            case 'P':
                if (e.shiftKey) {
                    e.preventDefault();
                    playback.previousTrack(getPlayer());
                }
                break;
            case 'n':
            case 'N':
                if (e.shiftKey) {
                    e.preventDefault();
                    playback.nextTrack(getPlayer());
                }
                break;
            case 'NavigationLeft':
            case 'GamepadDPadLeft':
            case 'GamepadLeftThumbstickLeft':
                // Ignores gamepad events that are always triggered, even when not focused.
                if (document.hasFocus()) {
                    playback.rewind(getPlayer());
                    osd.showOsd(btnRewind);
                }
                break;
            case 'NavigationRight':
            case 'GamepadDPadRight':
            case 'GamepadLeftThumbstickRight':
                // Ignores gamepad events that are always triggered, even when not focused.
                if (document.hasFocus()) {
                    playback.fastForward(getPlayer());
                    osd.showOsd(btnFastForward);
                }
                break;
            case 'Home':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.seekPercent(0, getPlayer());
                }
                break;
            case 'End':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.seekPercent(100, getPlayer());
                }
                break;
            case '0':
            case '1':
            case '2':
            case '3':
            case '4':
            case '5':
            case '6':
            case '7':
            case '8':
            case '9': { // no Shift
                e.preventDefault();
                const percent = parseInt(key, 10) * 10;
                playback.seekPercent(percent, getPlayer());
                break;
            }
            case '>': // Shift+.
                e.preventDefault();
                playback.increasePlaybackRate(getPlayer());
                break;
            case '<': // Shift+,
                e.preventDefault();
                playback.decreasePlaybackRate(getPlayer());
                break;
            case 'PageUp':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.nextChapter(getPlayer());
                }
                break;
            case 'PageDown':
                if (!e.shiftKey) {
                    e.preventDefault();
                    playback.previousChapter(getPlayer());
                }
                break;
            case 'g':
            case 'G':
                if (!e.shiftKey) {
                    e.preventDefault();
                    getSubtitleSync()?.decrementOffset();
                }
                break;
            case 'h':
            case 'H':
                if (!e.shiftKey) {
                    e.preventDefault();
                    getSubtitleSync()?.incrementOffset();
                }
                break;
        }
    }

    function onKeyDownCapture() {
        osd.resetIdle();
    }

    function onWindowMouseDown(e) {
        clickedElement = e.target;
        mouseIsDown = true;
        osd.resetIdle();
    }

    function onWindowMouseUp() {
        mouseIsDown = false;
        osd.resetIdle();
    }

    function onWindowDragEnd() {
        // mousedown -> dragstart -> dragend !!! no mouseup :(
        mouseIsDown = false;
        osd.resetIdle();
    }

    function onViewPointerDown(e) {
        if (dom.parentWithClass(e.target, ['videoOsdBottom', 'upNextContainer'])) {
            osd.showOsd();
            return;
        }

        const pointerType = e.pointerType || (layoutManager.mobile ? 'touch' : 'mouse');
        const now = currentTimeMs();

        switch (pointerType) {
            case 'touch':
                if (now - lastPointerDown > 300) {
                    lastPointerDown = now;
                    osd.toggleOsd();
                }

                break;

            case 'mouse':
                if (!e.button) {
                    if (playPauseClickTimeout) {
                        clearTimeout(playPauseClickTimeout);
                        playPauseClickTimeout = 0;
                    } else {
                        playPauseClickTimeout = setTimeout(function() {
                            playback.playPause(getPlayer());
                            osd.showOsd();
                            playPauseClickTimeout = 0;
                        }, 300);
                    }
                }

                break;

            default:
                playback.playPause(getPlayer());
                osd.showOsd();
        }
    }

    function onViewDoubleClick(e) {
        if (e.target !== view) return;
        playback.toggleFullscreen(getPlayer());
    }

    /**
     * Attach the document/window-level input listeners for one active view.
     * @returns {void}
     */
    function bind() {
        /* eslint-disable-next-line compat/compat */
        dom.addEventListener(document, window.PointerEvent ? 'pointermove' : 'mousemove', onPointerMove, {
            passive: true
        });
        inputManager.on(window, onInputCommand);
        document.addEventListener('keydown', onKeyDown);
        dom.addEventListener(document, 'keydown', onKeyDownCapture, {
            capture: true,
            passive: true
        });
        /* eslint-disable-next-line compat/compat */
        dom.addEventListener(document, window.PointerEvent ? 'pointerdown' : 'mousedown', onOverlayDismissPointerDown, {
            capture: true
        });
        /* eslint-disable-next-line compat/compat */
        dom.addEventListener(window, window.PointerEvent ? 'pointerdown' : 'mousedown', onWindowMouseDown, {
            capture: true,
            passive: true
        });
        /* eslint-disable-next-line compat/compat */
        dom.addEventListener(window, window.PointerEvent ? 'pointerup' : 'mouseup', onWindowMouseUp, {
            capture: true,
            passive: true
        });
        dom.addEventListener(window, 'touchstart', onWindowMouseDown, {
            capture: true,
            passive: true
        });
        ['touchend', 'touchcancel'].forEach((event) => {
            dom.addEventListener(window, event, onWindowMouseUp, {
                capture: true,
                passive: true
            });
        });
        dom.addEventListener(window, 'dragend', onWindowDragEnd, {
            capture: true,
            passive: true
        });
        if (browser.firefox || browser.edge) {
            dom.addEventListener(document, 'click', onClickCapture, { capture: true });
        }
    }

    /**
     * Detach the document/window-level input listeners for one active view.
     * @returns {void}
     */
    function unbind() {
        document.removeEventListener('keydown', onKeyDown);
        dom.removeEventListener(document, 'keydown', onKeyDownCapture, {
            capture: true,
            passive: true
        });
        /* eslint-disable-next-line compat/compat */
        dom.removeEventListener(document, window.PointerEvent ? 'pointerdown' : 'mousedown', onOverlayDismissPointerDown, {
            capture: true
        });
        /* eslint-disable-next-line compat/compat */
        dom.removeEventListener(window, window.PointerEvent ? 'pointerdown' : 'mousedown', onWindowMouseDown, {
            capture: true,
            passive: true
        });
        /* eslint-disable-next-line compat/compat */
        dom.removeEventListener(window, window.PointerEvent ? 'pointerup' : 'mouseup', onWindowMouseUp, {
            capture: true,
            passive: true
        });
        dom.removeEventListener(window, 'touchstart', onWindowMouseDown, {
            capture: true,
            passive: true
        });
        ['touchend', 'touchcancel'].forEach((event) => {
            dom.removeEventListener(window, event, onWindowMouseUp, {
                capture: true,
                passive: true
            });
        });
        dom.removeEventListener(window, 'dragend', onWindowDragEnd, {
            capture: true,
            passive: true
        });
        if (browser.firefox || browser.edge) {
            dom.removeEventListener(document, 'click', onClickCapture, { capture: true });
        }
        /* eslint-disable-next-line compat/compat */
        dom.removeEventListener(document, window.PointerEvent ? 'pointermove' : 'mousemove', onPointerMove, {
            passive: true
        });
        inputManager.off(window, onInputCommand);
    }

    /**
     * Attach the view element's own pointer gesture listeners. These are
     * bound once for the view's lifetime, unlike bind()/unbind() which run
     * per viewshow/viewbeforehide cycle.
     * @returns {void}
     */
    function bindViewGestures() {
        /* eslint-disable-next-line compat/compat */
        dom.addEventListener(view, window.PointerEvent ? 'pointerdown' : 'click', onViewPointerDown, { passive: true });
        dom.addEventListener(view, 'dblclick', onViewDoubleClick);
    }

    /**
     * Whether a pointer/touch press is currently held down.
     * @returns {boolean} True while the press is held.
     */
    function isMouseDown() {
        return mouseIsDown;
    }

    /**
     * Cancel a pending deferred single-click play/pause toggle.
     * @returns {void}
     */
    function cancelPendingClick() {
        clearTimeout(playPauseClickTimeout);
    }

    return { bind, unbind, bindViewGestures, isMouseDown, cancelPendingClick };
}
