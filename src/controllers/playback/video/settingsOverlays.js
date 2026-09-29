// SlopTank modification notice: added or changed by SlopTank on 2026-09-24, 2026-09-29.
/**
 * Owns the playback stats overlay, the subtitle sync overlay, and the OSD
 * settings menu button. The subtitle offset entry itself moved to the
 * Subtitles (CC) menu (SubtitleTrackMenu) on 2026-09-27; this module keeps
 * only the overlay that entry opens.
 *
 * Constructed by video/index.js, which injects its dependencies (the
 * current-player accessor, the playback manager adapter, and the OSD idle
 * reset).
 *
 * @module controllers/playback/video/settingsOverlays
 */

import { loadDynamicModule } from 'utils/dynamicImport';
import SubtitleSync from '../../../components/subtitlesync/subtitlesync';

/**
 * Creates the settings overlays controller.
 *
 * @param {object} options - Dependencies injected by video/index.js.
 * @param {Function} options.getPlayer - Returns the current player.
 * @param {object} options.playback - The playback manager adapter.
 * @param {Function} options.resetIdle - Resets the OSD idle timer.
 * @returns {object} { onSettingsButtonClick, toggleStats, destroyStats, disableStats, toggleSubtitleSync, destroySubtitleSync, getSubtitleSync }
 */
export function createSettingsOverlays(options) {
    const { getPlayer, playback, resetIdle } = options;

    let statsOverlay;
    let subtitleSyncOverlay;

    function onSettingsButtonClick() {
        const btn = this;

        loadDynamicModule(() => import('../../../components/playback/playersettingsmenu'),
            '../../../components/playback/playersettingsmenu').then((playerSettingsMenu) => {
            const player = getPlayer();

            if (player) {
                const state = playback.getPlayerState(player);

                playerSettingsMenu.show({
                    mediaType: 'Video',
                    player: player,
                    positionTo: btn,
                    quality: state.MediaSource?.SupportsTranscoding,
                    stats: true,
                    onOption: onSettingsOption
                }).finally(() => {
                    resetIdle();
                });

                setTimeout(resetIdle, 0);
            }
        });
    }

    function onSettingsOption(selectedOption) {
        if (selectedOption === 'stats') {
            toggleStats();
        }
    }

    function toggleStats() {
        loadDynamicModule(() => import('../../../components/playerstats/playerstats'),
            '../../../components/playerstats/playerstats').then(({ default: PlayerStats }) => {
            const player = getPlayer();

            if (player) {
                if (statsOverlay) {
                    statsOverlay.toggle();
                } else {
                    statsOverlay = new PlayerStats({
                        player: player
                    });
                }
            }
        });
    }

    function destroyStats() {
        if (statsOverlay) {
            statsOverlay.destroy();
            statsOverlay = null;
        }
    }

    function toggleSubtitleSync(action) {
        const player = getPlayer();
        if (subtitleSyncOverlay) {
            subtitleSyncOverlay.toggle(action);
        } else if (player && !action) {
            // Construct AND toggle: the overlay is created hidden, so a
            // first click that only constructed it would be a silent no-op.
            // A hide request never builds one; there is nothing to hide.
            subtitleSyncOverlay = new SubtitleSync(player);
            subtitleSyncOverlay.toggle(action);
        }
    }

    function destroySubtitleSync() {
        if (subtitleSyncOverlay) {
            subtitleSyncOverlay.destroy();
            subtitleSyncOverlay = null;
        }
    }

    /**
     * Disables (hides) the stats overlay without destroying it.
     */
    function disableStats() {
        if (statsOverlay) {
            statsOverlay.enabled(false);
        }
    }

    /**
     * Returns the current subtitle-sync overlay instance, if any.
     * @returns {object|undefined} The subtitle sync overlay.
     */
    function getSubtitleSync() {
        return subtitleSyncOverlay;
    }

    return { onSettingsButtonClick, toggleStats, destroyStats, disableStats, toggleSubtitleSync, destroySubtitleSync, getSubtitleSync };
}
