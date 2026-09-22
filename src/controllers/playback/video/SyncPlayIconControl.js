// SlopTank modification notice: added or changed by SlopTank on 2026-09-22.
import { pluginManager } from '../../../components/pluginManager';
import { PluginType } from '../../../types/plugin.ts';
import Events from '../../../utils/events.ts';

/**
 * SyncPlay group-playback feedback animation for the video OSD.
 * @module controllers/playback/video/SyncPlayIconControl
 */

/**
 * Renders SyncPlay group state changes as the OSD's animated sync icon.
 *
 * Dormant unless the SyncPlay plugin is instantiated: bind() looks the plugin
 * up, subscribes to its manager events, and translates each one into the icon
 * animation the legacy OSD shows over the video. destroy() unsubscribes, so a
 * destroyed view can never animate its detached icon after a re-enter.
 */
export default class SyncPlayIconControl {
    #manager = null;
    #hideIconTimer = null;

    /**
     * @param {Object} options - View elements and OSD control adapters.
     * @param {HTMLElement} options.view - Video OSD root; hosts #syncPlayIcon.
     * @param {Function} options.showOsd - Wake the OSD controls (SyncPlay pause).
     * @param {Function} options.hideOsd - Hide the OSD controls (SyncPlay schedule-play).
     */
    constructor(options) {
        this.view = options.view;
        this.showOsd = options.showOsd;
        this.hideOsd = options.hideOsd;
    }

    /**
     * Subscribe to the SyncPlay plugin's manager events, when the plugin exists.
     * @returns {void}
     */
    bind() {
        const syncPlay = pluginManager.firstOfType(PluginType.SyncPlay)?.instance;
        if (!syncPlay) {
            return;
        }

        this.#manager = syncPlay.Manager;
        Events.on(this.#manager, 'enabled', this.#onEnabled);
        Events.on(this.#manager, 'notify-osd', this.#onNotifyOsd);
        Events.on(this.#manager, 'group-state-update', this.#onGroupStateUpdate);
    }

    /**
     * Unsubscribe from the manager and cancel any pending icon hide.
     * @returns {void}
     */
    destroy() {
        if (this.#manager) {
            Events.off(this.#manager, 'enabled', this.#onEnabled);
            Events.off(this.#manager, 'notify-osd', this.#onNotifyOsd);
            Events.off(this.#manager, 'group-state-update', this.#onGroupStateUpdate);
            this.#manager = null;
        }

        if (this.#hideIconTimer) {
            clearTimeout(this.#hideIconTimer);
            this.#hideIconTimer = null;
        }
    }

    #onEnabled = (_event, enabled) => {
        if (!enabled) {
            const syncPlayIcon = this.view.querySelector('#syncPlayIcon');
            syncPlayIcon.style.visibility = 'hidden';
        }
    };

    #onNotifyOsd = (_event, action) => {
        this.showIcon(action);
    };

    #onGroupStateUpdate = (_event, state, reason) => {
        if (state === 'Playing' && reason === 'Unpause') {
            this.showIcon('schedule-play');
        } else if (state === 'Playing' && reason === 'Ready') {
            this.showIcon('schedule-play');
        } else if (state === 'Paused' && reason === 'Pause') {
            this.showIcon('pause');
        } else if (state === 'Paused' && reason === 'Ready') {
            this.showIcon('clear');
        } else if (state === 'Waiting' && reason === 'Seek') {
            this.showIcon('seek');
        } else if (state === 'Waiting' && reason === 'Buffer') {
            this.showIcon('buffering');
        } else if (state === 'Waiting' && reason === 'Pause') {
            this.showIcon('wait-pause');
        } else if (state === 'Waiting' && reason === 'Unpause') {
            this.showIcon('wait-unpause');
        }
    };

    /**
     * Show the big animated icon for one SyncPlay action.
     *
     * The icon node is replaced with a clone on every show so the CSS
     * animation restarts even when the same action repeats back to back.
     *
     * @param {string} action - SyncPlay action name ('pause', 'seek', ...).
     * @returns {void}
     */
    showIcon(action) {
        let primaryIconName = '';
        let secondaryIconName = '';
        let animationClass = 'oneShotPulse';
        let iconVisibilityTime = 1500;
        const syncPlayIcon = this.view.querySelector('#syncPlayIcon');

        switch (action) {
            case 'schedule-play':
                primaryIconName = 'sync spin';
                secondaryIconName = 'play_arrow centered';
                animationClass = 'infinitePulse';
                iconVisibilityTime = -1;
                this.hideOsd();
                break;
            case 'unpause':
                primaryIconName = 'play_circle_outline';
                break;
            case 'pause':
                primaryIconName = 'pause_circle_outline';
                this.showOsd();
                break;
            case 'seek':
                primaryIconName = 'update';
                animationClass = 'infinitePulse';
                iconVisibilityTime = -1;
                break;
            case 'buffering':
                primaryIconName = 'schedule';
                animationClass = 'infinitePulse';
                iconVisibilityTime = -1;
                break;
            case 'wait-pause':
                primaryIconName = 'schedule';
                secondaryIconName = 'pause shifted';
                animationClass = 'infinitePulse';
                iconVisibilityTime = -1;
                break;
            case 'wait-unpause':
                primaryIconName = 'schedule';
                secondaryIconName = 'play_arrow shifted';
                animationClass = 'infinitePulse';
                iconVisibilityTime = -1;
                break;
            default: {
                syncPlayIcon.style.visibility = 'hidden';
                return;
            }
        }

        syncPlayIcon.setAttribute('class', 'syncPlayIconCircle ' + animationClass);

        const primaryIcon = syncPlayIcon.querySelector('.primary-icon');
        primaryIcon.setAttribute('class', 'primary-icon material-icons ' + primaryIconName);

        const secondaryIcon = syncPlayIcon.querySelector('.secondary-icon');
        secondaryIcon.setAttribute('class', 'secondary-icon material-icons ' + secondaryIconName);

        const clone = syncPlayIcon.cloneNode(true);
        clone.style.visibility = 'visible';
        syncPlayIcon.parentNode.replaceChild(clone, syncPlayIcon);

        if (iconVisibilityTime < 0) {
            return;
        }

        this.#hideIconTimer = setTimeout(() => {
            clone.style.visibility = 'hidden';
            this.#hideIconTimer = null;
        }, iconVisibilityTime);
    }
}
