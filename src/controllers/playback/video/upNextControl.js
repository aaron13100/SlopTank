// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns the 'up next' episode card shown near the end of playback.
 *
 * video/index.js constructs this and injects its dependencies.
 * @module controllers/playback/video/upNextControl
 */
import { TICKS_PER_MINUTE, TICKS_PER_SECOND } from 'constants/time';
import Events from '../../../utils/events.ts';
import * as userSettings from '../../../scripts/settings/userSettings';
import { loadDynamicModule } from 'utils/dynamicImport';

/**
 * Build the 'up next' episode card controller.
 * @param {object} options - Elements and adapters this module does not own.
 * @param {HTMLElement} options.view - Video OSD root.
 * @param {object} options.playback - Playback manager adapter.
 * @param {object} options.osd - OSD visibility controller (getVisibleMenu, setVisibleMenu).
 * @returns {{ onPromptSkip: Function, showComingUpNextIfNeeded: Function, reset: Function }}
 */
export function createUpNextControl(options) {
    const { view, playback, osd } = options;

    let comingUpNextDisplayed;
    let currentUpNextDialog;

    function resetUpNextDialog() {
        comingUpNextDisplayed = false;
        const dlg = currentUpNextDialog;

        if (dlg) {
            dlg.destroy();
            currentUpNextDialog = null;
        }
    }

    function onPromptSkip(e, mediaSegment) {
        const player = this;
        if (mediaSegment && player && mediaSegment.EndTicks != null
            && mediaSegment.EndTicks >= playback.duration(player)
            && playback.getNextItem()
            && userSettings.enableNextVideoInfoOverlay()
        ) {
            showComingUpNext(player);
        }
    }

    function showComingUpNextIfNeeded(player, currentItem, currentTimeTicks, runtimeTicks) {
        if (runtimeTicks && currentTimeTicks && !comingUpNextDisplayed && !osd.getVisibleMenu() && currentItem.Type === 'Episode' && userSettings.enableNextVideoInfoOverlay()) {
            let showAtSecondsLeft = 30;
            if (runtimeTicks >= 50 * TICKS_PER_MINUTE) {
                showAtSecondsLeft = 40;
            } else if (runtimeTicks >= 40 * TICKS_PER_MINUTE) {
                showAtSecondsLeft = 35;
            }
            const showAtTicks = runtimeTicks - showAtSecondsLeft * TICKS_PER_SECOND;
            const timeRemainingTicks = runtimeTicks - currentTimeTicks;

            if (currentTimeTicks >= showAtTicks && runtimeTicks >= (10 * TICKS_PER_MINUTE) && timeRemainingTicks >= (20 * TICKS_PER_SECOND)) {
                showComingUpNext(player);
            }
        }
    }

    function onUpNextHidden() {
        if (osd.getVisibleMenu() === 'upnext') {
            osd.setVisibleMenu(null);
        }
    }

    function showComingUpNext(player) {
        loadDynamicModule(() => import('../../../components/upnextdialog/upnextdialog'),
            '../../../components/upnextdialog/upnextdialog').then(({ default: UpNextDialog }) => {
            if (!(osd.getVisibleMenu() || currentUpNextDialog)) {
                osd.setVisibleMenu('upnext');
                comingUpNextDisplayed = true;
                playback.nextItem(player).then(function (nextItem) {
                    currentUpNextDialog = new UpNextDialog({
                        parent: view.querySelector('.upNextContainer'),
                        player: player,
                        nextItem: nextItem
                    });
                    Events.on(currentUpNextDialog, 'hide', onUpNextHidden);
                }, onUpNextHidden);
            }
        });
    }

    return { onPromptSkip, showComingUpNextIfNeeded, reset: resetUpNextDialog };
}
