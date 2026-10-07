// SlopTank modification notice: changed by SlopTank on 2026-10-07.
import dom from '../../utils/dom';
import { playbackManager } from '../playback/playbackmanager';
import Events from '../../utils/events.ts';
import mediaInfo from '../mediainfo/mediainfo';
import layoutManager from '../layoutManager';
import focusManager from '../focusManager';
import globalize from '../../lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import itemHelper from '../itemHelper';

import './upnextdialog.scss';
import '../../elements/emby-button/emby-button';
import '../../styles/flexstyles.scss';

const transitionEndEventName = dom.whichTransitionEvent();
const dialogOwners = new WeakMap();

function getHtml() {
    let html = '';

    html += '<div class="flex flex-direction-column flex-grow">';

    html += '<h2 class="upNextDialog-nextVideoText" style="margin:.25em 0;">&nbsp;</h2>';

    html += '<h3 class="upNextDialog-title" style="margin:.25em 0 .5em;"></h3>';

    html += '<div class="flex flex-direction-row upNextDialog-mediainfo">';
    html += '</div>';

    html += '<div class="flex flex-direction-row upNextDialog-buttons" style="margin-top:1em;">';

    html += '<button type="button" is="emby-button" class="raised raised-mini btnStartNow upNextDialog-button">';
    html += globalize.translate('HeaderStartNow');
    html += '</button>';

    html += '<button type="button" is="emby-button" class="raised raised-mini btnHide upNextDialog-button">';
    html += globalize.translate('Hide');
    html += '</button>';

    // buttons
    html += '</div>';

    // main
    html += '</div>';

    return html;
}

function setNextVideoText() {
    const instance = this;

    const elem = instance.options.parent;

    const secondsRemaining = Math.max(Math.round(getTimeRemainingMs(instance) / 1000), 0);

    console.debug('up next seconds remaining: ' + secondsRemaining);

    const timeText = '<span class="upNextDialog-countdownText">' + globalize.translate('HeaderSecondsValue', secondsRemaining) + '</span>';

    let nextVideoText;
    if (instance.itemType === 'Episode') {
        nextVideoText = instance.showStaticNextText ?
            globalize.translate('HeaderNextEpisode') :
            globalize.translate('HeaderNextEpisodePlayingInValue', timeText);
    } else {
        nextVideoText = instance.showStaticNextText ?
            globalize.translate('HeaderNextVideo') :
            globalize.translate('HeaderNextVideoPlayingInValue', timeText);
    }

    elem.querySelector('.upNextDialog-nextVideoText').innerHTML = nextVideoText;
}

function fillItem(item) {
    const instance = this;

    const elem = instance.options.parent;

    elem.querySelector('.upNextDialog-mediainfo').innerHTML = mediaInfo.getPrimaryMediaInfoHtml(item, {
        criticRating: true,
        originalAirDate: false,
        starRating: true,
        subtitles: false
    });

    let title = itemHelper.getDisplayName(item);
    if (item.SeriesName) {
        title = item.SeriesName + ' - ' + title;
    }

    elem.querySelector('.upNextDialog-title').innerText = title || '';

    instance.itemType = item.Type;

    instance.show();
}

function clearCountdownTextTimeout(instance) {
    if (instance._countdownTextTimeout) {
        clearInterval(instance._countdownTextTimeout);
        instance._countdownTextTimeout = null;
    }
}

async function onStartNowClick() {
    const options = this.options;

    if (options) {
        const player = options.player;

        await this.hide();

        playbackManager.nextTrack(player);
    }
}

function init(instance, options) {
    // Render the card before reading autoplay preferences. A slow or failed
    // user lookup must not leave playback's Up Next state set while the card
    // remains empty or hidden.
    instance.showStaticNextText = true;
    dialogOwners.set(options.parent, instance);

    options.parent.innerHTML = getHtml();

    options.parent.classList.add('hide');
    options.parent.classList.add('upNextDialog');
    options.parent.classList.add('upNextDialog-hidden');

    fillItem.call(instance, options.nextItem);

    options.parent.querySelector('.btnHide').addEventListener('click', instance.hide.bind(instance));
    options.parent.querySelector('.btnStartNow').addEventListener('click', onStartNowClick.bind(instance));

    showStaticNextText(options.nextItem).then(showStaticText => {
        if (instance.options !== options) return;

        instance.showStaticNextText = showStaticText;
        if (showStaticText) {
            clearCountdownTextTimeout(instance);
            setNextVideoText.call(instance);
        } else {
            startComingUpNextHideTimer(instance);
        }
    }).catch(error => {
        if (instance.options !== options) return;

        // The visible static card is a safe fallback if user preferences are
        // temporarily unavailable. Keep useful response context while
        // avoiding logging the error object, which may contain credentials.
        console.warn('Up Next autoplay preferences unavailable', {
            status: error?.status ?? error?.statusCode,
            message: error?.message || error?.statusText || (typeof error === 'string' ? error : undefined),
            itemId: options.nextItem?.Id,
            serverId: options.nextItem?.ServerId
        });
    });
}

function clearHideAnimationEventListeners(instance, elem) {
    const resolve = instance._hideTransitionResolve;

    if (resolve) {
        dom.removeEventListener(elem, transitionEndEventName, resolve, {
            once: true
        });
        instance._hideTransitionResolve = null;
        resolve({ cancelled: true, target: elem });
    }

    instance._onHideAnimationComplete = null;
}

function onHideAnimationComplete(e) {
    const instance = this;
    const elem = e.target;
    const parent = instance.options?.parent;

    if (!parent || dialogOwners.get(parent) !== instance) return;

    elem.classList.add('hide');

    clearHideAnimationEventListeners(instance, elem);
    Events.trigger(instance, 'hide');
}

async function hideComingUpNext() {
    const instance = this;
    clearCountdownTextTimeout(this);

    if (!instance.options) {
        return;
    }

    const elem = instance.options.parent;

    if (!elem) {
        return;
    }

    clearHideAnimationEventListeners(this, elem);

    if (elem.classList.contains('upNextDialog-hidden')) {
        return;
    }

    const fn = onHideAnimationComplete.bind(instance);
    instance._onHideAnimationComplete = fn;

    let resolveTransition;
    const transitionEvent = await new Promise((resolve) => {
        resolveTransition = resolve;
        instance._hideTransitionResolve = resolve;
        dom.addEventListener(elem, transitionEndEventName, resolve, {
            once: true
        });

        // trigger a reflow to force it to animate again
        void elem.offsetWidth;

        elem.classList.add('upNextDialog-hidden');
    });

    if (instance._hideTransitionResolve === resolveTransition) {
        instance._hideTransitionResolve = null;
    }

    if (transitionEvent?.cancelled || dialogOwners.get(elem) !== instance) return;

    instance._onHideAnimationComplete?.(transitionEvent);
}

function getTimeRemainingMs(instance) {
    const options = instance.options;
    if (options) {
        const runtimeTicks = playbackManager.duration(options.player);

        if (runtimeTicks) {
            const timeRemainingTicks = runtimeTicks - playbackManager.currentTime(options.player) * 10000;

            return Math.round(timeRemainingTicks / 10000);
        }
    }

    return 0;
}

function startComingUpNextHideTimer(instance) {
    const timeRemainingMs = getTimeRemainingMs(instance);

    if (timeRemainingMs <= 0) {
        return;
    }

    setNextVideoText.call(instance);
    clearCountdownTextTimeout(instance);

    if (!instance.showStaticNextText) instance._countdownTextTimeout = setInterval(setNextVideoText.bind(instance), 400);
}

async function showStaticNextText(nextItem) {
    const apiClient = ServerConnections.getApiClient(nextItem);
    const currentUser = await apiClient.getCurrentUser();
    return !currentUser.Configuration.EnableNextEpisodeAutoPlay;
}

class UpNextDialog {
    constructor(options) {
        this.options = options;
        this.showStaticNextText = true; // stay static until autoplay preference lookup completes

        init(this, options);
    }
    show() {
        const elem = this.options.parent;

        clearHideAnimationEventListeners(this, elem);

        elem.classList.remove('hide');

        // trigger a reflow to force it to animate again
        void elem.offsetWidth;

        elem.classList.remove('upNextDialog-hidden');

        if (layoutManager.tv) {
            setTimeout(function () {
                focusManager.focus(elem.querySelector('.btnStartNow'));
            }, 50);
        }

        startComingUpNextHideTimer(this);
    }
    async hide() {
        await hideComingUpNext.bind(this)();
    }
    destroy() {
        const elem = this.options?.parent;
        if (elem) {
            const shouldTriggerHide = !elem.classList.contains('upNextDialog-hidden') || Boolean(this._onHideAnimationComplete);

            clearCountdownTextTimeout(this);
            clearHideAnimationEventListeners(this, elem);
            elem.classList.add('upNextDialog-hidden', 'hide');

            if (dialogOwners.get(elem) === this) dialogOwners.delete(elem);
            if (shouldTriggerHide) Events.trigger(this, 'hide');
        }

        this.options = null;
        this.showStaticNextText = false;
        this.itemType = null;
    }
}

export default UpNextDialog;
