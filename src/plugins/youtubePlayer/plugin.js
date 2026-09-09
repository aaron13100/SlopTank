// SlopTank modification notice: added or changed by SlopTank on 2026-07-18, 2026-07-23, 2026-09-08, 2026-09-09.
import browser from '../../scripts/browser';
import loading from '../../components/loading/loading';
import { playbackManager } from '../../components/playback/playbackmanager';
import { setBackdropTransparency, TRANSPARENCY_LEVEL } from '../../components/backdrop/backdrop';
import globalize from '../../lib/globalize';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import { loadDynamicModule } from 'utils/dynamicImport';

/* globals YT */

const errorCodes = {
    2: 'YoutubeBadRequest',
    5: 'YoutubePlaybackError',
    100: 'YoutubeNotFound',
    101: 'YoutubeDenied',
    150: 'YoutubeDenied'
};

function zoomIn(elem, iterations) {
    const keyframes = [
        { transform: 'scale3d(.2, .2, .2)  ', opacity: '.6', offset: 0 },
        { transform: 'none', opacity: '1', offset: 1 }
    ];

    const timing = { duration: 240, iterations: iterations };
    return elem.animate(keyframes, timing);
}

/**
 * Wires the user-facing ways out of the trailer overlay: the overlay close
 * button, the Escape key and browser back. With YouTube's own chrome owning
 * the player controls there is no app OSD fronting the iframe, so the
 * plugin itself must provide the exit affordances. The document/window
 * handlers are removed in destroy().
 * @param {YoutubePlayer} instance
 * @param {HTMLElement} closeButton
 */
function bindCloseControls(instance, closeButton) {
    const stopPlayback = function () {
        playbackManager.stop(instance);
    };
    instance.closeControlHandlers = {
        onKeyDown: function (e) {
            if (e.key === 'Escape') {
                stopPlayback();
            }
        },
        onPopState: stopPlayback
    };
    closeButton.addEventListener('click', stopPlayback);
    document.addEventListener('keydown', instance.closeControlHandlers.onKeyDown);
    window.addEventListener('popstate', instance.closeControlHandlers.onPopState);
}

function createMediaElement(instance, options) {
    return new Promise(function (resolve) {
        const dlg = document.querySelector('.youtubePlayerContainer');

        if (!dlg) {
            loadDynamicModule(() => import('./style.scss'),
                './style.scss').then(() => {
                loading.show();

                const playerDlg = document.createElement('div');

                playerDlg.classList.add('youtubePlayerContainer');

                if (options.fullscreen) {
                    playerDlg.classList.add('onTop');
                }

                playerDlg.innerHTML = '<div id="player"></div>';
                const videoElement = playerDlg.querySelector('#player');

                const closeButton = document.createElement('button');
                closeButton.type = 'button';
                closeButton.classList.add('youtubePlayerCloseButton', 'paper-icon-button-light');
                closeButton.title = globalize.translate('ButtonClose');
                closeButton.setAttribute('aria-label', closeButton.title);
                closeButton.innerHTML = '<span class="material-icons close" aria-hidden="true"></span>';
                playerDlg.appendChild(closeButton);
                bindCloseControls(instance, closeButton);

                document.body.insertBefore(playerDlg, document.body.firstChild);
                instance.videoDialog = playerDlg;

                if (options.fullscreen) {
                    document.body.classList.add('hide-scroll');
                }

                if (options.fullscreen && playerDlg.animate && !browser.slow) {
                    zoomIn(playerDlg, 1).onfinish = function () {
                        resolve(videoElement);
                    };
                } else {
                    resolve(videoElement);
                }
            });
        } else {
            // we need to hide scrollbar when starting playback from page with animated background
            if (options.fullscreen) {
                document.body.classList.add('hide-scroll');
                dlg.classList.add('onTop');
            }

            // After YT.Player.destroy() the placeholder element may be
            // gone; recreate it so replays and dead-trailer retries always
            // have a target element to attach to.
            let videoElement = dlg.querySelector('#player');
            if (!videoElement) {
                videoElement = document.createElement('div');
                videoElement.id = 'player';
                dlg.insertBefore(videoElement, dlg.firstChild);
            }

            resolve(videoElement);
        }
    });
}

/**
 * Calls a YouTube iframe API player method if it is actually available.
 * The iframe API attaches playback methods to the player object
 * asynchronously (only once the embedded player reports ready); until then
 * only construction-time members exist. Observed live: closing the overlay
 * while the player was still loading threw "stopVideo is not a function"
 * from an unguarded call. A partially initialized player is treated the
 * same as no player.
 * @param {object|null} player The YT.Player instance (possibly not ready).
 * @param {string} method The API method name to invoke.
 * @param {any[]} [args] Arguments for the method.
 * @returns {any} The method's return value, or undefined when unavailable.
 */
function invokePlayerMethod(player, method, args) {
    if (player && typeof player[method] === 'function') {
        return player[method].apply(player, args || []);
    }
}

function onVideoResize() {
    const instance = this;
    const player = instance.currentYoutubePlayer;
    const dlg = instance.videoDialog;
    if (player && dlg) {
        invokePlayerMethod(player, 'setSize', [dlg.offsetWidth, dlg.offsetHeight]);
    }
}

function clearTimeUpdateInterval(instance) {
    if (instance.timeUpdateInterval) {
        clearInterval(instance.timeUpdateInterval);
    }
    instance.timeUpdateInterval = null;
}

function onEndedInternal(instance) {
    clearTimeUpdateInterval(instance);
    const resizeListener = instance.resizeListener;
    if (resizeListener) {
        window.removeEventListener('resize', resizeListener);
        window.removeEventListener('orientationChange', resizeListener);
        instance.resizeListener = null;
    }

    const stopInfo = {
        src: instance._currentSrc
    };

    Events.trigger(instance, 'stopped', [stopInfo]);

    instance._currentSrc = null;
    invokePlayerMethod(instance.currentYoutubePlayer, 'destroy');
    instance.currentYoutubePlayer = null;
}

// 4. The API will call this function when the video player is ready.
function onPlayerReady(event) {
    event.target.playVideo();
}

function onTimeUpdate() {
    Events.trigger(this, 'timeupdate');
}

function onPlaying(instance, playOptions, resolve) {
    if (!instance.started) {
        instance.started = true;
        resolve();
        clearTimeUpdateInterval(instance);
        instance.timeUpdateInterval = setInterval(onTimeUpdate.bind(instance), 500);

        // Fullscreen trailers keep the dialog on top and let YouTube's own
        // chrome (controls: 1) drive playback. The app's video OSD is
        // deliberately NOT shown for this player: it cannot control the
        // iframe's captions or quality, and its overlay would collide with
        // the native YouTube controls.
        if (!playOptions.fullscreen) {
            setBackdropTransparency(TRANSPARENCY_LEVEL.Backdrop);
            instance.videoDialog.classList.remove('onTop');
        }

        loading.hide();
    }
}

function setCurrentSrc(instance, elem, options) {
    return new Promise(function (resolve, reject) {
        instance._currentSrc = options.url;
        const params = new URLSearchParams(options.url.split('?')[1]); /* eslint-disable-line compat/compat */
        // 3. This function creates an <iframe> (and YouTube player)
        //    after the API code downloads.
        window.onYouTubeIframeAPIReady = function () {
            instance.currentYoutubePlayer = new YT.Player('player', {
                height: instance.videoDialog.offsetHeight,
                width: instance.videoDialog.offsetWidth,
                videoId: params.get('v'),
                events: {
                    'onReady': onPlayerReady,
                    'onStateChange': function (event) {
                        if (event.data === YT.PlayerState.PLAYING) {
                            onPlaying(instance, options, resolve);
                        } else if (event.data === YT.PlayerState.ENDED) {
                            onEndedInternal(instance);
                        } else if (event.data === YT.PlayerState.PAUSED) {
                            Events.trigger(instance, 'pause');
                        }
                    },
                    'onError': (e) => reject(errorCodes[e.data] || 'ErrorDefault')
                },
                playerVars: {
                    // YouTube's own chrome owns the trailer control
                    // surface: the iframe is a black box to the app OSD
                    // (captions/quality are not scriptable), so the native
                    // controls are the only layer that can drive them.
                    controls: 1,
                    // Auto-captions default OFF; the CC button turns them on.
                    // eslint-disable-next-line @typescript-eslint/naming-convention -- YouTube iframe API parameter name
                    cc_load_policy: 0,
                    enablejsapi: 1,
                    modestbranding: 1,
                    rel: 0,
                    showinfo: 0,
                    // Native controls include a working fullscreen toggle.
                    fs: 1,
                    playsinline: 1
                }
            });

            let resizeListener = instance.resizeListener;
            if (resizeListener) {
                window.removeEventListener('resize', resizeListener);
                window.addEventListener('resize', resizeListener);
            } else {
                resizeListener = instance.resizeListener = onVideoResize.bind(instance);
                window.addEventListener('resize', resizeListener);
            }
            window.removeEventListener('orientationChange', resizeListener);
            window.addEventListener('orientationChange', resizeListener);
        };

        if (!window.YT) {
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
        } else {
            window.onYouTubeIframeAPIReady();
        }
    });
}

class YoutubePlayer {
    constructor() {
        this.name = 'Youtube Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'youtubeplayer';

        // Let any players created by plugins take priority
        this.priority = 1;
    }
    play(options) {
        this.started = false;
        const instance = this;

        return createMediaElement(this, options).then(function (elem) {
            return setCurrentSrc(instance, elem, options);
        });
    }
    stop(destroyPlayer) {
        const src = this._currentSrc;

        if (src) {
            invokePlayerMethod(this.currentYoutubePlayer, 'stopVideo');
            onEndedInternal(this);
        }

        // Destroy even when there is no current src: after a natural ENDED
        // the src is already cleared, but the overlay dialog is still up
        // and a user-requested stop must still tear it down.
        if (destroyPlayer) {
            this.destroy();
        }

        return Promise.resolve();
    }
    destroy() {
        setBackdropTransparency(TRANSPARENCY_LEVEL.None);
        document.body.classList.remove('hide-scroll');

        const closeControlHandlers = this.closeControlHandlers;
        if (closeControlHandlers) {
            this.closeControlHandlers = null;
            document.removeEventListener('keydown', closeControlHandlers.onKeyDown);
            window.removeEventListener('popstate', closeControlHandlers.onPopState);
        }

        const dlg = this.videoDialog;
        if (dlg) {
            this.videoDialog = null;

            dlg.parentNode.removeChild(dlg);
        }
    }
    canPlayMediaType(mediaType) {
        mediaType = (mediaType || '').toLowerCase();

        return mediaType === 'audio' || mediaType === 'video';
    }
    canPlayItem() {
        // Does not play server items
        return false;
    }
    canPlayUrl(url) {
        return url.toLowerCase().indexOf('youtube.com') !== -1;
    }
    getDeviceProfile() {
        return Promise.resolve({});
    }
    currentSrc() {
        return this._currentSrc;
    }
    setSubtitleStreamIndex() {
        // not supported
    }
    canSetAudioStreamIndex() {
        return false;
    }
    setAudioStreamIndex() {
        // not supported
    }
    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        const currentYoutubePlayer = this.currentYoutubePlayer;

        if (currentYoutubePlayer) {
            if (val != null) {
                invokePlayerMethod(currentYoutubePlayer, 'seekTo', [val / 1000, true]);
                return;
            }

            return (invokePlayerMethod(currentYoutubePlayer, 'getCurrentTime') || 0) * 1000;
        }
    }
    duration() {
        const currentYoutubePlayer = this.currentYoutubePlayer;

        if (currentYoutubePlayer) {
            return (invokePlayerMethod(currentYoutubePlayer, 'getDuration') || 0) * 1000;
        }
        return null;
    }
    pause() {
        const currentYoutubePlayer = this.currentYoutubePlayer;

        if (currentYoutubePlayer) {
            invokePlayerMethod(currentYoutubePlayer, 'pauseVideo');

            const instance = this;

            // This needs a delay before the youtube player will report the correct player state
            setTimeout(function () {
                Events.trigger(instance, 'pause');
            }, 200);
        }
    }
    unpause() {
        const currentYoutubePlayer = this.currentYoutubePlayer;

        if (currentYoutubePlayer) {
            invokePlayerMethod(currentYoutubePlayer, 'playVideo');

            const instance = this;

            // This needs a delay before the youtube player will report the correct player state
            setTimeout(function () {
                Events.trigger(instance, 'unpause');
            }, 200);
        }
    }
    paused() {
        const currentYoutubePlayer = this.currentYoutubePlayer;

        if (currentYoutubePlayer) {
            return invokePlayerMethod(currentYoutubePlayer, 'getPlayerState') === 2;
        }

        return false;
    }
    volume(val) {
        if (val != null) {
            return this.setVolume(val);
        }

        return this.getVolume();
    }
    setVolume(val) {
        if (val != null) {
            invokePlayerMethod(this.currentYoutubePlayer, 'setVolume', [val]);
        }
    }
    getVolume() {
        return invokePlayerMethod(this.currentYoutubePlayer, 'getVolume');
    }
    setMute(mute) {
        invokePlayerMethod(this.currentYoutubePlayer, mute ? 'mute' : 'unMute');
    }
    isMuted() {
        return invokePlayerMethod(this.currentYoutubePlayer, 'isMuted');
    }
}

export default YoutubePlayer;
