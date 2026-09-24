// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Keydown routing decisions for two video-page hotkeys added or fixed under
 * queue task c180: the Space-bar play/pause toggle, and the 'c'/'C'
 * subtitle-cycle key match. Extracted from video/index.js's keydown handler
 * so these decisions are independently unit testable (see
 * index.test.js) without pulling in index.js's own module-scope side
 * effects (see videoDialogState.js's module comment).
 *
 * The subtitle-cycle *action* (advancing the track and toasting the result)
 * lives separately in subtitleHotkey.js; this module only decides whether a
 * given keydown is an unshifted press of 'c'/'C'.
 *
 * @module controllers/playback/video/videoHotkeys
 */
import keyboardnavigation from '../../../scripts/keyboardNavigation';
import { getOpenedDialog } from './videoDialogState';

/**
 * Tag names whose focused element already handles Space itself (native
 * button activation, checkbox/radio toggling, or typing a space character),
 * so the video page must not also toggle playback for it.
 */
const SPACE_RESERVED_TAG_NAMES = [ 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA' ];

/**
 * Whether the video page's Space-bar shortcut should toggle play/pause for
 * this keydown, rather than deferring to the browser's native handling of
 * whatever currently holds focus, or to an open dialog/menu's own keyboard
 * handling.
 * @param {EventTarget} target - The keydown event's target.
 * @returns {boolean} False when a focused button/input/select/textarea, or
 *   an open dialog/menu, should handle the key itself.
 */
export function shouldSpaceTogglePlayback(target) {
    if (getOpenedDialog()) {
        return false;
    }

    return !(target instanceof Element && SPACE_RESERVED_TAG_NAMES.includes(target.tagName));
}

/**
 * Handle a Space keydown on the video page: toggle play/pause and suppress
 * the page scroll, unless shouldSpaceTogglePlayback says the focused control
 * or an open dialog/menu should handle it itself -- in which case the OSD is
 * still shown, but the key is left alone so native activation (a focused
 * button's click, typing into an input, a dialog's own shortcuts) proceeds.
 * @param {KeyboardEvent} e - The Space keydown event.
 * @param {object} actions
 * @param {Function} actions.playPause - Toggles playback.
 * @param {Function} actions.showOsd - Shows the OSD; called with
 *   `focusElement` when handled, with no argument otherwise (matching the
 *   two existing showOsd call shapes in video/index.js).
 * @param {*} [actions.focusElement] - Element to focus when handled.
 * @param {Function} [actions.onHandled] - Extra side effect when handled
 *   (video/index.js uses this to null out `clickedElement`, a Firefox
 *   workaround for a stray follow-up 'click' event).
 * @returns {void}
 */
export function handleSpaceKeydown(e, { playPause, showOsd, focusElement, onHandled }) {
    if (shouldSpaceTogglePlayback(e.target)) {
        playPause();
        showOsd(focusElement);
        e.preventDefault();
        e.stopPropagation();
        onHandled?.();
    } else {
        showOsd();
    }
}

/**
 * Whether this keydown is an unshifted press of the subtitle-cycle hotkey
 * ('c', or CapsLock-uppercased 'C'). Mirrors this file's own key-name
 * convention (k/K, f/F, m/M in video/index.js): a case matches both the
 * lowercase and CapsLock-uppercased key name, but Shift+letter is left
 * unhandled so it stays free for another binding.
 * @param {KeyboardEvent} e - The keydown event.
 * @returns {boolean} True for an unshifted 'c'/'C'.
 */
export function isSubtitleCycleKeydown(e) {
    const key = keyboardnavigation.getKeyName(e);
    return (key === 'c' || key === 'C') && !e.shiftKey;
}
