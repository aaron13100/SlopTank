// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Subtitle-cycle hotkey ('c'/'C' during video playback, queue task c180): on
 * every tap, cycles the current player's subtitle track through every
 * available stream, then off, then back to the first, and toasts which one
 * is now selected.
 *
 * Extracted as its own unit rather than folded into video/index.js's already
 * large keydown handler, mirroring this directory's existing collaborator
 * modules (VolumeControl.js, permalinkResume.js): a real, independently
 * testable unit, not a `*.helpers`/`*.utils` split. See
 * subtitleHotkey.test.js.
 *
 * @module controllers/playback/video/subtitleHotkey
 */
import { playbackManager as defaultPlaybackManager } from '../../../components/playback/playbackmanager';
import inputManager from '../../../scripts/inputManager';
import globalize from '../../../lib/globalize';
import { loadDynamicModule } from 'utils/dynamicImport';

function defaultShowToast(message) {
    loadDynamicModule(() => import('../../../components/toast/toast'),
        '../../../components/toast/toast').then(({ default: toast }) => toast({ text: message, immediate: true }));
}

/**
 * @param {object} [deps] - Injectable seams for tests; production defaults
 *   to the real singletons.
 * @param {object} [deps.playback] - Playback manager adapter: needs
 *   subtitleTracks, getSubtitleStreamIndex and getSubtitleStream.
 * @param {Function} [deps.dispatchCommand] - Performs the actual track
 *   switch. Defaults to inputManager.handleCommand('changesubtitletrack') so
 *   keyboard, remote and gamepad triggers share one code path; a caller must
 *   never call playback.changeSubtitleStream() directly instead.
 * @param {Function} [deps.translate] - String translation adapter.
 * @param {Function} [deps.showToast] - Shows a transient message; production
 *   default shows it without the shared toast's usual 300ms fade-in delay,
 *   since the owner asked for this feedback "immediately".
 * @returns {{ cycle: (player: object) => void }} `cycle` is safe to call on
 *   every 'c'/'C' keydown.
 */
export function createSubtitleHotkey({
    playback = defaultPlaybackManager,
    dispatchCommand = () => inputManager.handleCommand('changesubtitletrack'),
    translate = globalize.translate,
    showToast = defaultShowToast
} = {}) {
    function cycle(player) {
        if (!player) {
            return;
        }

        if (!playback.subtitleTracks(player).length) {
            showToast(translate('NoSubtitlesAvailable'));
            return;
        }

        dispatchCommand();

        const newIndex = playback.getSubtitleStreamIndex(player) ?? -1;
        const newStream = newIndex === -1 ? null : playback.getSubtitleStream(player, newIndex);
        const label = newStream ? newStream.DisplayTitle : translate('Off');

        showToast(translate('SubtitleTrackToast', label));
    }

    return { cycle };
}
