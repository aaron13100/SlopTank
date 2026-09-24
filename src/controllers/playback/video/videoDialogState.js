// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Whether the video page currently has an open dialog or menu overlay.
 * Subtitle track/episode menus and the subtitle sizer all render through the
 * shared dialogHelper component, which marks its element
 * `.dialogContainer .dialog.opened`; this is the same check the Escape-key
 * handler already uses to decide whether to hide the OSD instead of closing
 * a dialog.
 *
 * Extracted from video/index.js (queue task c180) so this one check, and
 * anything that only needs it (see videoHotkeys.js's Space-bar handling),
 * can be imported and unit tested without pulling in index.js's own
 * module-scope side effects: importing index.js also imports
 * scripts/libraryMenu.js, whose loadNavDrawer() queries a real
 * `.mainDrawer` element unconditionally at import time and throws under
 * jsdom.
 *
 * @module controllers/playback/video/videoDialogState
 */

/**
 * @returns {Element | null} The open dialog element, or null when none is open.
 */
export function getOpenedDialog() {
    return document.querySelector('.dialogContainer .dialog.opened');
}
