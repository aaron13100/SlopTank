// SlopTank modification notice: added or changed by SlopTank on 2026-09-24, 2026-09-25, 2026-09-27.
/**
 * Owns the OSD audio-track menu: listing the playing item's audio tracks
 * and switching to the one the user picks.
 *
 * Constructed by video/index.js, which injects its dependencies (the
 * current-player accessor, the playback manager adapter, an action-sheet
 * loader, and the OSD idle reset).
 *
 * @module controllers/playback/video/audioTrackMenu
 */

import globalize from '../../../lib/globalize';

/**
 * Creates the audio track menu controller.
 *
 * @param {object} options - Dependencies injected by video/index.js.
 * @param {Function} options.getPlayer - Returns the current player.
 * @param {object} options.playback - The playback manager adapter.
 * @param {Function} options.loadActionSheet - Returns a promise of the actionSheet module.
 * @param {Function} options.resetIdle - Resets the OSD idle timer.
 * @returns {object} { show }
 */
export function createAudioTrackMenu(options) {
    const { getPlayer, playback, loadActionSheet, resetIdle } = options;

    function showAudioTrackSelection() {
        const player = getPlayer();
        const audioTracks = playback.audioTracks(player);
        const currentIndex = playback.getAudioStreamIndex(player);
        const menuItems = audioTracks.map(function (stream) {
            const opt = {
                name: stream.DisplayTitle,
                id: stream.Index
            };

            if (stream.Index === currentIndex) {
                opt.selected = true;
            }

            return opt;
        });
        const positionTo = this;

        loadActionSheet().then((actionsheet) => {
            actionsheet.show({
                items: menuItems,
                title: globalize.translate('Audio'),
                positionTo: positionTo
            }).then(function (id) {
                const index = parseInt(id, 10);

                if (index !== currentIndex) {
                    return playback.setAudioStreamIndex(index, player);
                }
            }).finally(() => {
                resetIdle();
            });

            setTimeout(resetIdle, 0);
        });
    }

    return { show: showAudioTrackSelection };
}
