// SlopTank modification notice: added or changed by SlopTank on 2026-03-12, 2026-07-18, 2026-07-19, 2026-07-22, 2026-07-23, 2026-07-24, 2026-07-25, 2026-07-26, 2026-07-31, 2026-08-09, 2026-08-29, 2026-09-08, 2026-09-09.
import DOMPurify from 'dompurify';
import debounce from 'lodash-es/debounce';
import ResizeObserver from 'resize-observer-polyfill';
import Screenfull from 'screenfull';
import caveatFontUrl from '@fontsource/caveat/files/caveat-latin-400-normal.woff2';
import caveatBoldFontUrl from '@fontsource/caveat/files/caveat-latin-700-normal.woff2';
import cinzelFontUrl from '@fontsource/cinzel/files/cinzel-latin-400-normal.woff2';
import cinzelBoldFontUrl from '@fontsource/cinzel/files/cinzel-latin-700-normal.woff2';
import comicNeueFontUrl from '@fontsource/comic-neue/files/comic-neue-latin-400-normal.woff2';
import comicNeueBoldFontUrl from '@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff2';
import courierPrimeFontUrl from '@fontsource/courier-prime/files/courier-prime-latin-400-normal.woff2';
import courierPrimeBoldFontUrl from '@fontsource/courier-prime/files/courier-prime-latin-700-normal.woff2';
import notoSerifFontUrl from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2';
import notoSerifBoldFontUrl from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff2';
import robotoMonoFontUrl from '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff2';
import robotoMonoBoldFontUrl from '@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff2';

import { useCustomSubtitles } from 'apps/stable/features/playback/utils/subtitleStyles';
// Namespace import, not a default import: the module used to also export a
// hand-written object re-listing its functions, and any function added without
// being added to that list resolved to `undefined` here at runtime.
import * as subtitleAppearanceHelper from 'components/subtitlesettings/subtitleappearancehelper';
import { AppFeature } from 'constants/appFeature';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';
import { MediaError } from 'types/mediaError';

import browser from '../../scripts/browser';
import appSettings from '../../scripts/settings/appSettings';
import { appHost } from '../../components/apphost';
import loading from '../../components/loading/loading';
import dom from '../../utils/dom';
import { playbackManager } from '../../components/playback/playbackmanager';
import { appRouter } from '../../components/router/appRouter';
import {
    bindEventsToHlsPlayer,
    destroyHlsPlayer,
    destroyFlvPlayer,
    destroyCastPlayer,
    getCrossOriginValue,
    enableHlsJsPlayerForCodecs,
    applySrc,
    resetSrc,
    playWithPromise,
    onEndedInternal,
    saveVolume,
    seekOnPlaybackStart,
    onErrorInternal,
    handleHlsJsMediaError,
    getSavedVolume,
    isValidDuration,
    getBufferedRanges
} from '../../components/htmlMediaHelper';
import itemHelper from '../../components/itemHelper';
import globalize from '../../lib/globalize';
import profileBuilder, { canPlaySecondaryAudio } from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import { setBackdropTransparency, TRANSPARENCY_LEVEL } from '../../components/backdrop/backdrop';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import { includesAny } from '../../utils/container.ts';
import { isHls } from '../../utils/mediaSource.ts';
import { loadDynamicModule } from 'utils/dynamicImport';

/**
 * Returns resolved URL.
 * @param {string} url - URL.
 * @returns {string} Resolved URL or `url` if resolving failed.
 */
function resolveUrl(url) {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', url, true);
        xhr.onload = function () {
            resolve(xhr.responseURL || url);
        };
        xhr.onerror = function (e) {
            console.error(e);
            resolve(url);
        };
        xhr.send(null);
    });
}

function tryRemoveElement(elem) {
    const parentNode = elem.parentNode;
    if (parentNode) {
        // Seeing crashes in edge webview
        try {
            parentNode.removeChild(elem);
        } catch (err) {
            console.error(`error removing dialog element: ${err}`);
        }
    }
}

function enableNativeTrackSupport(mediaSource, track) {
    if (track?.DeliveryMethod === 'Embed') {
        return true;
    }

    if (browser.firefox && isHls(mediaSource)) {
        return false;
    }

    if (browser.ps4) {
        return false;
    }

    if (browser.web0s) {
        return false;
    }

    // Edge is randomly not rendering subtitles
    if (browser.edge) {
        return false;
    }

    if (browser.iOS && (browser.iosVersion || 10) < 10) {
        // works in the browser but not the native app
        return false;
    }

    if (track) {
        const format = (track.Codec || '').toLowerCase();
        if (format === 'ssa' || format === 'ass' || format === 'pgssub') {
            return false;
        }
    }

    return true;
}

function requireHlsPlayer(callback) {
    loadDynamicModule(() => import('hls.js/dist/hls.js'),
        'hls.js/dist/hls.js').then(({ default: hls }) => {
        hls.DefaultConfig.lowLatencyMode = false;
        hls.DefaultConfig.backBufferLength = Infinity;
        hls.DefaultConfig.liveBackBufferLength = 90;
        window.Hls = hls;
        callback();
    });
}

function getMediaStreamVideoTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Video';
    });
}

function getMediaStreamAudioTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Audio';
    });
}

function getMediaStreamTextTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Subtitle';
    });
}

function getTargetFps(referenceFrameRate) {
    if (typeof referenceFrameRate === 'number' && Number.isFinite(referenceFrameRate) && referenceFrameRate > 0) {
        return referenceFrameRate;
    }

    if (typeof referenceFrameRate === 'string') {
        const normalized = referenceFrameRate.trim();
        if (normalized.includes('/')) {
            const [numeratorPart, denominatorPart] = normalized.split('/');
            const numerator = Number(numeratorPart);
            const denominator = Number(denominatorPart);
            if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
                return numerator / denominator;
            }
        } else {
            const parsed = Number(normalized);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }
    }

    return 24;
}

function zoomIn(elem) {
    return new Promise(resolve => {
        const duration = 240;
        elem.style.animation = `htmlvideoplayer-zoomin ${duration}ms ease-in normal`;
        dom.addEventListener(elem, dom.whichAnimationEvent(), resolve, {
            once: true
        });
    });
}

function normalizeTrackEventText(text, useHtml) {
    const result = text
        .replace(/\\N/gi, '\n') // Correct newline characters
        .replace(/\r/gi, '') // Remove carriage return characters
        .replace(/{\\.*?}/gi, '') // Remove ass/ssa tags
        // Force LTR as the default direction
        .split('\n').map(val => `\u200E${val}`).join('\n');
    return useHtml ? result.replace(/\n/gi, '<br>') : result;
}

const ASS_FONT_FAMILIES = {
    typewriter: 'Courier Prime',
    print: 'Noto Serif',
    console: 'Roboto Mono',
    cursive: 'Caveat',
    casual: 'Comic Neue',
    smallcaps: 'Cinzel'
};

const ASS_USER_FONT_URLS = [
    caveatFontUrl,
    caveatBoldFontUrl,
    cinzelFontUrl,
    cinzelBoldFontUrl,
    comicNeueFontUrl,
    comicNeueBoldFontUrl,
    courierPrimeFontUrl,
    courierPrimeBoldFontUrl,
    notoSerifFontUrl,
    notoSerifBoldFontUrl,
    robotoMonoFontUrl,
    robotoMonoBoldFontUrl
];

/**
 * Apply user text overrides to an ASS event without touching any positioning,
 * animation, colour, or drawing commands. Inline font-size commands are
 * scaled from their authored value; explicit font/weight commands are
 * replaced by the user's current typography choices.
 * @param {string} text - Authored ASS event text.
 * @param {Object} appearance - Effective subtitle appearance.
 * @returns {string} Event text with appearance overrides applied.
 */
function getAssEventTextWithAppearance(text, appearance) {
    const multiplier = subtitleAppearanceHelper.getTextSizeMultiplier(appearance.textSize);
    let result = text.replace(/\\fs(\d+(?:\.\d+)?)/gi, (match, value) =>
        `\\fs${Math.round(Number(value) * multiplier * 100) / 100}`);
    const fontName = ASS_FONT_FAMILIES[appearance.font];
    const bold = appearance.textWeight === 'bold' ? 1 : 0;

    if (fontName) {
        result = result.replace(/\\fn[^\\}]*/gi, `\\fn${fontName}`);
    }
    result = result.replace(/\\b-?\d+/gi, `\\b${bold}`);

    const overrides = [
        fontName ? `\\fn${fontName}` : '',
        `\\b${bold}`
    ].join('');
    return `{${overrides}}${result}`;
}

function splitAssFields(value, fieldCount) {
    const fields = [];
    let remainder = value;
    for (let index = 1; index < fieldCount; index++) {
        const separator = remainder.indexOf(',');
        if (separator === -1) {
            return null;
        }
        fields.push(remainder.slice(0, separator));
        remainder = remainder.slice(separator + 1);
    }
    fields.push(remainder);
    return fields;
}

/**
 * Override only ASS typography while retaining the complete authored
 * composition. Style alignments/margins and event-level positioning,
 * animations, colours, drawings, and timing pass through byte-for-byte.
 * @param {string} content - Authored ASS/SSA document.
 * @param {Object} appearance - Effective subtitle appearance.
 * @returns {string} ASS/SSA document ready for libass.
 */
function getAssContentWithAppearance(content, appearance) {
    const multiplier = subtitleAppearanceHelper.getTextSizeMultiplier(appearance.textSize);
    const fontName = ASS_FONT_FAMILIES[appearance.font];
    const bold = appearance.textWeight === 'bold' ? '-1' : '0';
    let section = '';
    let format = [];

    return content.split(/\r?\n/).map(line => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
            section = trimmedLine.slice(1, -1).toLowerCase();
            format = [];
            return line;
        }

        const colonIndex = line.indexOf(':');
        const lineKey = colonIndex === -1 ?
            '' :
            line.slice(0, colonIndex).trim().toLowerCase();
        const lineValue = colonIndex === -1 ?
            '' :
            line.slice(colonIndex + 1).trimStart();

        if (lineKey === 'format') {
            format = lineValue.split(',').map(field => field.trim().toLowerCase());
            return line;
        }

        if ((section === 'v4+ styles' || section === 'v4 styles') && lineKey === 'style' && format.length) {
            const fields = splitAssFields(lineValue, format.length);
            if (!fields) {
                return line;
            }
            const fontSizeIndex = format.indexOf('fontsize');
            const fontNameIndex = format.indexOf('fontname');
            const boldIndex = format.indexOf('bold');
            if (fontSizeIndex !== -1) {
                const authoredSize = Number(fields[fontSizeIndex]);
                if (Number.isFinite(authoredSize)) {
                    fields[fontSizeIndex] = String(
                        Math.round(authoredSize * multiplier * 100) / 100
                    );
                }
            }
            if (fontName && fontNameIndex !== -1) {
                fields[fontNameIndex] = fontName;
            }
            if (boldIndex !== -1) {
                fields[boldIndex] = bold;
            }
            return `${line.slice(0, colonIndex + 1)} ${fields.join(',')}`;
        }

        if (section === 'events' && lineKey === 'dialogue' && format.length) {
            const fields = splitAssFields(lineValue, format.length);
            const textIndex = format.indexOf('text');
            if (!fields || textIndex === -1) {
                return line;
            }
            fields[textIndex] = getAssEventTextWithAppearance(fields[textIndex], appearance);
            return `${line.slice(0, colonIndex + 1)} ${fields.join(',')}`;
        }

        return line;
    }).join('\n');
}

function getTextTrackUrl(track, item, format) {
    if (itemHelper.isLocalItem(item) && track.Path) {
        return track.Path;
    }

    let url = playbackManager.getSubtitleUrl(track, item.ServerId);
    if (format) {
        url = url.replace('.vtt', format);
    }

    return url;
}

function getDefaultProfile() {
    return profileBuilder({});
}

const PRIMARY_TEXT_TRACK_INDEX = 0;
const SECONDARY_TEXT_TRACK_INDEX = 1;

export class HtmlVideoPlayer {
    /**
     * @type {string}
     */
    name;
    /**
     * @type {string}
     */
    type = PluginType.MediaPlayer;
    /**
     * @type {string}
     */
    id = 'htmlvideoplayer';
    /**
     * Let any players created by plugins take priority
     *
     * @type {number}
     */
    priority = 1;
    /**
     * @type {boolean}
     */
    isFetching = false;
    /**
     * @type {HTMLDivElement | null | undefined}
     */
    #videoDialog;
    /**
     * Active Document Picture-in-Picture window. The complete video container
     * is moved there so custom subtitles and appearance controls remain part
     * of the popout instead of leaving only the bare video element.
     * @type {Window | null}
     */
    #documentPictureInPictureWindow = null;
    /**
     * Original video-container placement restored when Document PiP closes.
     * @type {{ parent: Node, nextSibling: Node | null } | null}
     */
    #documentPictureInPictureRestorePoint = null;
    /**
     * @type {(() => void) | null}
     */
    #documentPictureInPicturePageHideHandler = null;
    /**
     * @type {HTMLElement | null}
     */
    #documentPictureInPictureAppearanceButton = null;
    /**
     * @type {Object | null}
     */
    #documentPictureInPictureAppearanceOverlay = null;
    /**
     * @type {boolean | null}
     */
    #documentPictureInPictureOriginalVideoControls = null;
    /**
     * @type {number | undefined}
     */
    #subtitleTrackIndexToSetOnPlaying;
    /**
     * @type {number | undefined}
     */
    #secondarySubtitleTrackIndexToSetOnPlaying;
    /**
     * @type {number | null}
     */
    #audioTrackIndexToSetOnPlaying;
    /**
     * @type {any | null | undefined}
     */
    #currentAssRenderers = [ null, null ];
    /**
     * Original ASS source keyed by renderer. Every live appearance update
     * derives from this immutable authored document, so dragging a slider
     * never compounds size or loses any positioning/animation directives.
     * @type {WeakMap<Object, { content: string, appearanceKey: string, authoredBottomPercentage: number | null }>}
     */
    #assRendererStates = new WeakMap();
    /**
     * @type {any | null | undefined}
     */
    #currentPgsRenderer;
    /**
     * @type {number | undefined}
     */
    #customTrackIndex;
    /**
     * @type {number | undefined}
     */
    #customSecondaryTrackIndex;
    /**
     * @type {boolean | undefined}
     */
    #showTrackOffset;
    /**
     * @type {number | undefined}
     */
    #currentTrackOffset;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #secondaryTrackOffset;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #videoSubtitlesElem;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #videoSecondarySubtitlesElem;
    /**
     * @type {any | null | undefined}
     */
    #currentTrackEvents;
    /**
     * @type {any | null | undefined}
     */
    #currentSecondaryTrackEvents;
    /**
     * @type {string[] | undefined}
     */
    #supportedFeatures;
    /**
     * @type {HTMLVideoElement | null | undefined}
     */
    #mediaElement;
    /**
     * @type {ResizeObserver | null | undefined}
     */
    #subtitleResizeObserver;
    /**
     * Last valid proportional subtitle baseline measured from the rendered
     * video height. Native ::cue rules consume the concrete pixel value
     * because not every browser caption compositor resolves CSS variables.
     * @type {number | null}
     */
    #subtitleFontSize = null;
    /**
     * Monotonic render generation per target text track (primary, secondary).
     * Bumped when a track (re)selection or teardown starts; every async
     * subtitle completion validates its captured generation before mutating
     * player state, so stale fetches/imports are discarded instead of
     * installing a superseded track or renderer. Per-track because primary
     * and secondary selections start and complete independently.
     * @type {number[]}
     */
    #subtitleRenderGenerations = [ 0, 0 ];
    /**
     * How the current primary subtitle is being rendered. 'pending' while an
     * async determination (burn-in probe, subtitle fetch, renderer import) is
     * in flight. Drives getSubtitleRenderingInfo() capability answers.
     * @type {'custom'|'native'|'ass'|'pgs'|'burned'|'none'|'pending'}
     */
    #subtitleRenderPath = 'none';
    /**
     * Transient appearance override plus sample line shown while the
     * in-player size overlay is open. Null when no preview is active.
     * @type {{ textSize?: string, verticalPosition?: string, font?: string, textWeight?: string, sampleText: string } | null}
     */
    #subtitleAppearancePreview = null;
    /**
     * Preview-owned sample line element. Never the same element as
     * #videoSubtitlesElem: the real renderer keeps sole ownership of its
     * fields, the preview keeps sole ownership of this one.
     * @type {HTMLElement | null | undefined}
     */
    #subtitlePreviewElem;
    /**
     * Interval keeping the preview line present/visible while previewing
     * (covers the paused and no-track cases where no timeupdate fires).
     * @type {ReturnType<typeof setInterval> | null | undefined}
     */
    #subtitlePreviewTimer;
    /**
     * Keeps independently rendered primary and secondary subtitle lanes from
     * colliding as their active cues change.
     * @type {ReturnType<typeof setInterval> | null | undefined}
     */
    #subtitleLayoutTimer;
    /**
     * Offset requested while no renderer/track/events existed to apply it
     * to; applied by whichever async completion installs one.
     * @type {number | null}
     */
    #pendingSubtitleOffset = null;
    /**
     * @type {number}
     */
    #fetchQueue = 0;
    /**
     * @type {string | undefined}
     */
    #currentSrc;
    /**
     * @type {boolean | undefined}
     */
    #started;
    /**
     * @type {boolean | undefined}
     */
    #timeUpdated;
    /**
     * @type {number | null | undefined}
     */
    #currentTime;
    /**
     * @type {number | undefined}
     */
    #videoFrameCallbackId;
    /**
     * @type {boolean | undefined}
     */
    #firstVideoFramePresented;
    /**
     * @type {boolean | undefined}
     */
    #initialMediaPrepared;

    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _flvPlayer;

    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _hlsPlayer;
    /**
     * @private (used in other files)
     * @type {any | null | undefined}
     */
    _castPlayer;
    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _currentPlayOptions;
    /**
     * @type {any | undefined}
     */
    #lastProfile;

    constructor() {
        if (browser.edgeUwp) {
            this.name = 'Windows Video Player';
        } else {
            this.name = 'Html Video Player';
        }
    }

    currentSrc() {
        return this.#currentSrc;
    }

    /**
     * @private
     */
    incrementFetchQueue() {
        if (this.#fetchQueue <= 0) {
            this.isFetching = true;
            Events.trigger(this, 'beginFetch');
        }

        this.#fetchQueue++;
    }

    /**
     * @private
     */
    decrementFetchQueue() {
        this.#fetchQueue--;

        if (this.#fetchQueue <= 0) {
            this.isFetching = false;
            Events.trigger(this, 'endFetch');
        }
    }

    /**
     * @private
     */
    updateVideoUrl(streamInfo) {
        const mediaSource = streamInfo.mediaSource;
        const item = streamInfo.item;

        // Huge hack alert. Safari doesn't seem to like if the segments aren't available right away when playback starts
        // This will start the transcoding process before actually feeding the video url into the player
        // Edit: Also seeing stalls from hls.js
        if (mediaSource && item && !mediaSource.RunTimeTicks && isHls(mediaSource) && streamInfo.playMethod === 'Transcode' && (browser.iOS || browser.osx)) {
            const hlsPlaylistUrl = streamInfo.url.replace('master.m3u8', 'live.m3u8');

            if (!streamInfo.alreadyOnVideoOsd) {
                loading.show();
            }

            console.debug(`prefetching hls playlist: ${hlsPlaylistUrl}`);

            return ServerConnections.getApiClient(item.ServerId).ajax({

                type: 'GET',
                url: hlsPlaylistUrl

            }).then(function () {
                console.debug(`completed prefetching hls playlist: ${hlsPlaylistUrl}`);

                loading.hide();
                streamInfo.url = hlsPlaylistUrl;
            }, function () {
                console.error(`error prefetching hls playlist: ${hlsPlaylistUrl}`);

                loading.hide();
            });
        } else {
            return Promise.resolve();
        }
    }

    async play(options) {
        this.#started = false;
        this.#timeUpdated = false;
        this.#firstVideoFramePresented = false;
        this.#initialMediaPrepared = false;

        this.#currentTime = null;

        if (options.resetSubtitleOffset !== false) this.resetSubtitleOffset();
        // A same-player next-item transition (stop(false)) never fires
        // playerchange or destroy(), so an open size preview would otherwise
        // survive into the next item.
        this.clearSubtitleAppearancePreview();

        const elem = await this.createMediaElement(options);
        this.#applyAspectRatio(options.aspectRatio || this.getAspectRatio());

        await this.updateVideoUrl(options);
        return this.setCurrentSrc(elem, options);
    }

    /**
     * @private
     */
    setSrcWithFlvJs(elem, options, url) {
        return loadDynamicModule(() => import('flv.js'),
                   'flv.js').then(({ default: flvjs }) => {
            const flvPlayer = flvjs.createPlayer({
                type: 'flv',
                url: url
            },
            {
                seekType: 'range',
                lazyLoad: false
            });

            flvPlayer.attachMediaElement(elem);
            flvPlayer.load();

            this._flvPlayer = flvPlayer;

            // This is needed in setCurrentTrackElement
            this.#currentSrc = url;

            return flvPlayer.play();
        });
    }

    /**
     * @private
     */
    setSrcWithHlsJs(elem, options, url) {
        return new Promise((resolve, reject) => {
            requireHlsPlayer(async () => {
                let maxBufferLength = 30;

                // Some browsers cannot handle huge fragments in high bitrate.
                // This issue usually happens when using HWA encoders with a high bitrate setting.
                // Limit the BufferLength to 6s, it works fine when playing 4k 120Mbps over HLS on chrome.
                // https://github.com/video-dev/hls.js/issues/876
                if ((browser.chrome || browser.edgeChromium || browser.firefox) && playbackManager.getMaxStreamingBitrate(this) >= 25000000) {
                    maxBufferLength = 6;
                }

                const includeCorsCredentials = await getIncludeCorsCredentials();

                const hls = new Hls({
                    startPosition: options.playerStartPositionTicks / 10000000,
                    manifestLoadingTimeOut: 20000,
                    maxBufferLength: maxBufferLength,
                    maxMaxBufferLength: maxBufferLength,
                    videoPreference: { preferHDR: true },
                    xhrSetup(xhr) {
                        xhr.withCredentials = includeCorsCredentials;
                    }
                });
                hls.loadSource(url);
                hls.attachMedia(elem);

                bindEventsToHlsPlayer(this, hls, elem, this.onError, resolve, reject);

                this._hlsPlayer = hls;

                // This is needed in setCurrentTrackElement
                this.#currentSrc = url;
            });
        });
    }

    /**
     * @private
     */
    async setCurrentSrc(elem, options) {
        elem.removeEventListener('error', this.onError);

        let val = options.url;
        console.debug(`playing url: ${val}`);

        // Convert to seconds
        const seconds = (options.playerStartPositionTicks || 0) / 10000000;
        if (seconds) {
            val += `#t=${seconds}`;
        }

        destroyHlsPlayer(this);
        destroyFlvPlayer(this);
        destroyCastPlayer(this);

        let secondaryTrackValid = true;

        this.#subtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSubtitleStreamIndex;
        if (this.#subtitleTrackIndexToSetOnPlaying != null && this.#subtitleTrackIndexToSetOnPlaying >= 0) {
            const initialSubtitleStream = options.mediaSource.MediaStreams[this.#subtitleTrackIndexToSetOnPlaying];
            if (!initialSubtitleStream || initialSubtitleStream.DeliveryMethod === 'Encode') {
                this.#subtitleTrackIndexToSetOnPlaying = -1;
                secondaryTrackValid = false;
            }
            // secondary track should not be shown if primary track is no longer a valid pair
            if (initialSubtitleStream && !playbackManager.trackHasSecondarySubtitleSupport(initialSubtitleStream, this)) {
                secondaryTrackValid = false;
            }
        } else {
            secondaryTrackValid = false;
        }

        this.#audioTrackIndexToSetOnPlaying = options.playMethod === 'Transcode' ? null : options.mediaSource.DefaultAudioStreamIndex;

        this._currentPlayOptions = options;

        if (secondaryTrackValid) {
            this.#secondarySubtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSecondarySubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSecondarySubtitleStreamIndex;
            if (this.#secondarySubtitleTrackIndexToSetOnPlaying != null && this.#secondarySubtitleTrackIndexToSetOnPlaying >= 0) {
                const initialSecondarySubtitleStream = options.mediaSource.MediaStreams[this.#secondarySubtitleTrackIndexToSetOnPlaying];
                if (!initialSecondarySubtitleStream || !playbackManager.trackHasSecondarySubtitleSupport(initialSecondarySubtitleStream, this)) {
                    this.#secondarySubtitleTrackIndexToSetOnPlaying = -1;
                }
            }
        } else {
            this.#secondarySubtitleTrackIndexToSetOnPlaying = -1;
        }

        const crossOrigin = getCrossOriginValue(options.mediaSource);
        if (crossOrigin) {
            elem.crossOrigin = crossOrigin;
        }

        if (enableHlsJsPlayerForCodecs(options.mediaSource, 'Video') && isHls(options.mediaSource)) {
            return this.setSrcWithHlsJs(elem, options, val);
        } else if (options.playMethod !== 'Transcode' && options.mediaSource.Container?.toUpperCase() === 'FLV') {
            return this.setSrcWithFlvJs(elem, options, val);
        } else {
            elem.autoplay = true;

            const includeCorsCredentials = await getIncludeCorsCredentials();
            if (includeCorsCredentials) {
                // Safari will not send cookies without this
                elem.crossOrigin = 'use-credentials';
            }

            return applySrc(elem, val, options).then(() => {
                this.#currentSrc = val;

                return playWithPromise(elem, this.onError);
            });
        }
    }

    setSubtitleStreamIndex(index) {
        this.setCurrentTrackElement(index);
    }

    setSecondarySubtitleStreamIndex(index) {
        this.setCurrentTrackElement(index, SECONDARY_TEXT_TRACK_INDEX);
    }

    resetSubtitleOffset() {
        this.#currentTrackOffset = 0;
        this.#secondaryTrackOffset = 0;
        this.#pendingSubtitleOffset = null;
        this.#showTrackOffset = false;
    }

    enableShowingSubtitleOffset() {
        this.#showTrackOffset = true;
    }

    disableShowingSubtitleOffset() {
        this.#showTrackOffset = false;
    }

    isShowingSubtitleOffsetEnabled() {
        return this.#showTrackOffset;
    }

    /**
     * @private
     */
    getTextTracks() {
        const videoElement = this.#mediaElement;
        if (videoElement) {
            return Array.from(videoElement.textTracks)
                .filter(function (trackElement) {
                    // get showing .vtt textTack
                    return trackElement.mode === 'showing';
                });
        } else {
            return null;
        }
    }

    setSubtitleOffset = debounce(this._setSubtitleOffset, 100);

    /**
     * @private
     */
    _setSubtitleOffset(offset) {
        const offsetValue = parseFloat(offset);
        const appliedTrackIndices = new Set();
        const transcodingOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000;

        this.#currentAssRenderers.forEach((renderer, index) => {
            if (!renderer) {
                return;
            }
            this.updateCurrentTrackOffset(offsetValue, index);
            renderer.timeOffset = transcodingOffset + offsetValue;
            renderer.setCurrentTime(this.#mediaElement?.currentTime + renderer.timeOffset);
            appliedTrackIndices.add(index);
        });

        if (this.#currentPgsRenderer) {
            this.updateCurrentTrackOffset(offsetValue, PRIMARY_TEXT_TRACK_INDEX);
            this.#currentPgsRenderer.timeOffset = transcodingOffset + offsetValue;
            appliedTrackIndices.add(PRIMARY_TEXT_TRACK_INDEX);
        }

        const trackElements = this.getTextTracks();
        trackElements?.forEach((trackElement, index) => {
            if (!appliedTrackIndices.has(index)) {
                this.setTextTrackSubtitleOffset(trackElement, offsetValue, index);
                appliedTrackIndices.add(index);
            }
        });

        if (this.#currentTrackEvents && !appliedTrackIndices.has(PRIMARY_TEXT_TRACK_INDEX)) {
            this.setTrackEventsSubtitleOffset(this.#currentTrackEvents, offsetValue, PRIMARY_TEXT_TRACK_INDEX);
            appliedTrackIndices.add(PRIMARY_TEXT_TRACK_INDEX);
        }
        if (this.#currentSecondaryTrackEvents && !appliedTrackIndices.has(SECONDARY_TEXT_TRACK_INDEX)) {
            this.setTrackEventsSubtitleOffset(this.#currentSecondaryTrackEvents, offsetValue, SECONDARY_TEXT_TRACK_INDEX);
            appliedTrackIndices.add(SECONDARY_TEXT_TRACK_INDEX);
        }
        if (this.#currentTrackEvents || this.#currentSecondaryTrackEvents) {
            this.refreshSubtitleTextAtTime(this.#mediaElement?.currentTime);
        }

        if (appliedTrackIndices.size === 0) {
            // Nothing applyable yet (subtitle still loading): retain the
            // request and let the completing install apply it, so slider
            // input during the loading window is not lost.
            this.#pendingSubtitleOffset = offsetValue;
            console.debug('No available track yet, retaining requested offset: ', offsetValue);
        }
    }

    /**
     * Apply an offset that was requested before any renderer/track/events
     * existed. Called by every async completion that installs one.
     * @private
     */
    applyPendingSubtitleOffset() {
        if (this.#pendingSubtitleOffset === null) {
            return;
        }

        const pending = this.#pendingSubtitleOffset;
        this.#pendingSubtitleOffset = null;
        this._setSubtitleOffset(pending);
    }

    /**
     * Whether the CURRENT subtitle rendering state can actually apply a
     * client-side timing offset. Truthful per rendering path, unlike the
     * external-only stream-metadata heuristic (embedded direct-play tracks
     * are client-rendered and offsetable).
     * @returns {boolean} True when an offset request would be applied or
     * retained for the loading subtitle.
     */
    canHandleSubtitleOffset() {
        return this.getSubtitleRenderingInfo().canAdjustOffset;
    }

    /**
     * @private
     */
    updateCurrentTrackOffset(offsetValue, currentTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        let offsetToCompare = this.#currentTrackOffset;
        if (this.isSecondaryTrack(currentTrackIndex)) {
            offsetToCompare = this.#secondaryTrackOffset;
        }

        let relativeOffset = offsetValue;
        const newTrackOffset = offsetValue;

        if (offsetToCompare) {
            relativeOffset -= offsetToCompare;
        }

        if (this.isSecondaryTrack(currentTrackIndex)) {
            this.#secondaryTrackOffset = newTrackOffset;
        } else {
            this.#currentTrackOffset = newTrackOffset;
        }

        // relative to currentTrackOffset
        return relativeOffset;
    }

    /**
     * @private
     * These browsers will not clear the existing active cue when setting an offset
     * for native TextTracks.
     * Any previous text tracks that are on the screen when the offset changes will remain next
     * to the new tracks until they reach the end time of the new offset's instance of the track.
     */
    requiresHidingActiveCuesOnOffsetChange() {
        return !!browser.firefox;
    }

    /**
     * @private
     */
    hideTextTrackWithActiveCues(currentTrack) {
        if (currentTrack.activeCues) {
            currentTrack.mode = 'hidden';
        }
    }

    /**
     * Forces the active cue to clear by disabling then re-enabling the track.
     * The track mode is reverted inside of a 0ms timeout to free up the track
     * and allow it to disable and clear the active cue.
     * @private
     */
    forceClearTextTrackActiveCues(currentTrack) {
        if (currentTrack.activeCues) {
            currentTrack.mode = 'disabled';
            setTimeout(() => {
                currentTrack.mode = 'showing';
            }, 0);
        }
    }

    /**
     * @private
     */
    setTextTrackSubtitleOffset(currentTrack, offsetValue, currentTrackIndex) {
        if (currentTrack.cues) {
            offsetValue = this.updateCurrentTrackOffset(offsetValue, currentTrackIndex);
            if (offsetValue === 0) {
                return;
            }

            const shouldClearActiveCues = this.requiresHidingActiveCuesOnOffsetChange();
            if (shouldClearActiveCues) {
                this.hideTextTrackWithActiveCues(currentTrack);
            }

            Array.from(currentTrack.cues)
                .forEach(function (cue) {
                    cue.startTime -= offsetValue;
                    cue.endTime -= offsetValue;
                });

            if (shouldClearActiveCues) {
                this.forceClearTextTrackActiveCues(currentTrack);
            }
        }
    }

    /**
     * @private
     */
    setTrackEventsSubtitleOffset(trackEvents, offsetValue, currentTrackIndex) {
        if (Array.isArray(trackEvents)) {
            offsetValue = this.updateCurrentTrackOffset(offsetValue, currentTrackIndex) * 1e7; // ticks
            if (offsetValue === 0) {
                return;
            }
            trackEvents.forEach(function (trackEvent) {
                trackEvent.StartPositionTicks -= offsetValue;
                trackEvent.EndPositionTicks -= offsetValue;
            });
        }
    }

    getSubtitleOffset() {
        return this.#currentTrackOffset;
    }

    isPrimaryTrack(textTrackIndex) {
        return textTrackIndex === PRIMARY_TEXT_TRACK_INDEX;
    }

    isSecondaryTrack(textTrackIndex) {
        return textTrackIndex === SECONDARY_TEXT_TRACK_INDEX;
    }

    /**
     * @private
     */
    isAudioStreamSupported(stream, deviceProfile, container) {
        const codec = (stream.Codec || '').toLowerCase();

        if (!codec) {
            return true;
        }

        if (!deviceProfile) {
            // This should never happen
            return true;
        }

        const profiles = deviceProfile.DirectPlayProfiles || [];

        return profiles.some(function (p) {
            return p.Type === 'Video'
                    && includesAny((p.Container || '').toLowerCase(), container)
                    && includesAny((p.AudioCodec || '').toLowerCase(), codec);
        });
    }

    /**
     * @private
     */
    getSupportedAudioStreams() {
        const profile = this.#lastProfile;

        const mediaSource = this._currentPlayOptions.mediaSource;
        const container = mediaSource.Container.toLowerCase();

        return getMediaStreamAudioTracks(mediaSource).filter((stream) => {
            return this.isAudioStreamSupported(stream, profile, container);
        });
    }

    setAudioStreamIndex(index) {
        const streams = this.getSupportedAudioStreams();

        if (streams.length < 2) {
            // If there's only one supported stream then trust that the player will handle it on it's own
            return;
        }

        let audioIndex = -1;

        for (const stream of streams) {
            audioIndex++;

            if (stream.Index === index) {
                break;
            }
        }

        if (audioIndex === -1) {
            return;
        }

        const elem = this.#mediaElement;
        if (!elem) {
            return;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/audioTracks

        /**
         * @type {ArrayLike<any>|any[]}
         */
        const elemAudioTracks = elem.audioTracks || [];
        console.debug(`found ${elemAudioTracks.length} audio tracks`);

        for (const [i, audioTrack] of Array.from(elemAudioTracks).entries()) {
            if (audioIndex === i) {
                console.debug(`setting audio track ${i} to enabled`);
                audioTrack.enabled = true;
            } else {
                console.debug(`setting audio track ${i} to disabled`);
                audioTrack.enabled = false;
            }
        }
    }

    stop(destroyPlayer) {
        const elem = this.#mediaElement;
        const src = this.#currentSrc;

        if (elem) {
            if (src) {
                elem.pause();
            }

            onEndedInternal(this, elem, this.onError);
        }

        this.destroyCustomTrack(elem);

        if (destroyPlayer) {
            this.destroy();
        }

        return Promise.resolve();
    }

    destroy() {
        this.setSubtitleOffset.cancel();
        this.clearSubtitleAppearancePreview();
        this.exitDocumentPictureInPicture();

        if (this.#subtitleResizeObserver) {
            this.#subtitleResizeObserver.disconnect();
            this.#subtitleResizeObserver = null;
        }

        destroyHlsPlayer(this);
        destroyFlvPlayer(this);

        setBackdropTransparency(TRANSPARENCY_LEVEL.None);
        document.body.classList.remove('hide-scroll');

        const videoElement = this.#mediaElement;

        if (videoElement) {
            if (this.#videoFrameCallbackId != null && typeof videoElement.cancelVideoFrameCallback === 'function') {
                videoElement.cancelVideoFrameCallback(this.#videoFrameCallbackId);
                this.#videoFrameCallbackId = undefined;
            }

            this.#mediaElement = null;

            this.destroyCustomTrack(videoElement);
            videoElement.removeEventListener('timeupdate', this.onTimeUpdate);
            videoElement.removeEventListener('ended', this.onEnded);
            videoElement.removeEventListener('volumechange', this.onVolumeChange);
            videoElement.removeEventListener('pause', this.onPause);
            videoElement.removeEventListener('canplay', this.onCanPlay);
            videoElement.removeEventListener('playing', this.onPlaying);
            videoElement.removeEventListener('play', this.onPlay);
            videoElement.removeEventListener('click', this.onClick);
            videoElement.removeEventListener('dblclick', this.onDblClick);
            videoElement.removeEventListener('waiting', this.onWaiting);
            videoElement.removeEventListener('error', this.onError); // bound in htmlMediaHelper

            resetSrc(videoElement);

            videoElement.parentNode.removeChild(videoElement);
        }

        const dlg = this.#videoDialog;
        if (dlg) {
            this.#videoDialog = null;
            dlg.parentNode.removeChild(dlg);
        }

        if (Screenfull.isEnabled) {
            Screenfull.exit();
        } else if (document.webkitIsFullScreen && document.webkitCancelFullscreen) {
            // iOS Safari
            document.webkitCancelFullscreen();
        }
    }

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onEnded = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        this.destroyCustomTrack(elem);
        onEndedInternal(this, elem, this.onError);
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onTimeUpdate = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        // get the player position and the transcoding offset
        const time = elem.currentTime;

        if (time && !this.#timeUpdated) {
            this.#timeUpdated = true;
            this.ensureValidVideo(elem);
        }

        this.#currentTime = time;

        this.refreshSubtitleTextAtTime(time);
        this.updateSecondarySubtitleLayout();

        Events.trigger(this, 'timeupdate');
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onVolumeChange = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        saveVolume(elem.volume);
        Events.trigger(this, 'volumechange');
    };

    /**
     * @private
     */
    onNavigatedToOsd = () => {
        const dlg = this.#videoDialog;
        if (dlg) {
            dlg.classList.remove('videoPlayerContainer-onTop');

            this.onStartedAndNavigatedToOsd();
        }
    };

    /**
     * @private
     */
    onStartedAndNavigatedToOsd() {
        // If this causes a failure during navigation we end up in an awkward UI state
        this.setCurrentTrackElement(this.#subtitleTrackIndexToSetOnPlaying);

        if (this.#audioTrackIndexToSetOnPlaying != null && this.canSetAudioStreamIndex()) {
            this.setAudioStreamIndex(this.#audioTrackIndexToSetOnPlaying);
        }

        if (this.#secondarySubtitleTrackIndexToSetOnPlaying != null && this.#secondarySubtitleTrackIndexToSetOnPlaying >= 0) {
            /**
             * Using a 0ms timeout to set the secondary subtitles because of some weird race condition when
             * setting both primary and secondary tracks at the same time.
             * The `TextTrack` content and cues will somehow get mixed up and each track will play a mix of both languages.
             * Putting this in a timeout fixes it completely.
             */
            setTimeout(() => this.setSecondarySubtitleStreamIndex(this.#secondarySubtitleTrackIndexToSetOnPlaying), 0);
        }
    }

    /**
     * Keep permalink preparation visible until the browser has submitted an
     * actual video frame for display. The playing event can fire before the
     * frame at the resumed position has been painted.
     * @private
     */
    waitForFirstVideoFrame(elem) {
        if (this.#firstVideoFramePresented || elem !== this.#mediaElement) {
            return;
        }

        const onFramePresented = () => {
            if (this.#firstVideoFramePresented || elem !== this.#mediaElement) {
                return;
            }

            this.#firstVideoFramePresented = true;
            this.#videoFrameCallbackId = undefined;
            Events.trigger(this, 'firstvideoframe');
        };

        if (typeof elem.requestVideoFrameCallback === 'function') {
            this.#videoFrameCallbackId = elem.requestVideoFrameCallback(onFramePresented);
        } else {
            requestAnimationFrame(onFramePresented);
        }
    }

    /**
     * Apply the resume seek as soon as the media is playable. If autoplay was
     * blocked, the OSD can stop saying "Preparing" and expose Play once the
     * seek is ready; otherwise it waits for the first painted frame.
     * @private
     */
    prepareInitialMedia(elem) {
        if (this.#initialMediaPrepared || elem !== this.#mediaElement) {
            return;
        }

        this.#initialMediaPrepared = true;
        const onMediaReady = () => {
            this.#currentAssRenderers.forEach((renderer, index) => {
                if (!renderer) {
                    return;
                }
                const trackOffset = this.isSecondaryTrack(index) ?
                    this.#secondaryTrackOffset :
                    this.#currentTrackOffset;
                renderer.timeOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000 + (trackOffset || 0);
                renderer.resize();
                renderer.resetRenderAheadCache(false);
            });

            this.waitForFirstVideoFrame(elem);
            if (elem.paused) {
                if (elem.seeking) {
                    elem.addEventListener('seeked', () => {
                        Events.trigger(this, 'videoready');
                    }, { once: true });
                } else {
                    Events.trigger(this, 'videoready');
                }
            }
        };
        const startPositionTicks = this._currentPlayOptions.playerStartPositionTicks;
        seekOnPlaybackStart(this, elem, startPositionTicks, onMediaReady);
        if (!startPositionTicks) {
            onMediaReady();
        }
    }

    /**
     * @private
     */
    onCanPlay = (e) => {
        if (this._currentPlayOptions?.alreadyOnVideoOsd) {
            this.prepareInitialMedia(e.target);
        }
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onPlaying = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        if (!this.#started) {
            this.#started = true;
            elem.removeAttribute('controls');

            loading.hide();

            this.prepareInitialMedia(elem);

            if (this._currentPlayOptions.fullscreen) {
                if (this._currentPlayOptions.alreadyOnVideoOsd) {
                    this.onNavigatedToOsd();
                } else {
                    appRouter.showVideoOsd(this._currentPlayOptions.item).then(this.onNavigatedToOsd);
                }
            } else {
                setBackdropTransparency(TRANSPARENCY_LEVEL.Backdrop);
                this.#videoDialog.classList.remove('videoPlayerContainer-onTop');

                this.onStartedAndNavigatedToOsd();
            }
        }
        Events.trigger(this, 'playing');
    };

    /**
     * @private
     */
    onPlay = () => {
        Events.trigger(this, 'unpause');
    };

    /**
     * @private
     */
    ensureValidVideo(elem) {
        if (elem !== this.#mediaElement) {
            return;
        }

        if (elem.videoWidth === 0 && elem.videoHeight === 0) {
            const mediaSource = this._currentPlayOptions?.mediaSource;

            // Only trigger this if there is media info
            // Avoid triggering in situations where it might not actually have a video stream (audio only live tv channel)
            if (!mediaSource || mediaSource.RunTimeTicks) {
                onErrorInternal(this, MediaError.NO_MEDIA_ERROR);
            }
        }
    }

    /**
     * @private
     */
    onClick = () => {
        Events.trigger(this, 'click');
    };

    /**
     * @private
     */
    onDblClick = () => {
        Events.trigger(this, 'dblclick');
    };

    /**
     * @private
     */
    onPause = () => {
        Events.trigger(this, 'pause');
    };

    onWaiting = () => {
        Events.trigger(this, 'waiting');
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onError = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        const errorCode = elem.error ? (elem.error.code || 0) : 0;
        const errorMessage = elem.error ? (elem.error.message || '') : '';
        console.error(`media element error: ${errorCode} ${errorMessage}`);

        let type;

        switch (errorCode) {
            case 1:
                // MEDIA_ERR_ABORTED
                // This will trigger when changing media while something is playing
                return;
            case 2:
                // MEDIA_ERR_NETWORK
                type = MediaError.NETWORK_ERROR;
                break;
            case 3:
                // MEDIA_ERR_DECODE
                if (this._hlsPlayer) {
                    handleHlsJsMediaError(this);
                    return;
                } else {
                    type = MediaError.MEDIA_DECODE_ERROR;
                }
                break;
            case 4:
                // MEDIA_ERR_SRC_NOT_SUPPORTED
                type = MediaError.MEDIA_NOT_SUPPORTED;
                break;
            default:
                // seeing cases where Edge is firing error events with no error code
                // example is start playing something, then immediately change src to something else
                return;
        }

        onErrorInternal(this, type);
    };

    /**
     * @private
     */
    destroyCustomRenderedTrackElements(targetTrackIndex) {
        if (this.isPrimaryTrack(targetTrackIndex)) {
            if (this.#videoSubtitlesElem) {
                tryRemoveElement(this.#videoSubtitlesElem);
                this.#videoSubtitlesElem = null;
            }
        } else if (this.isSecondaryTrack(targetTrackIndex)) {
            if (this.#videoSecondarySubtitlesElem) {
                tryRemoveElement(this.#videoSecondarySubtitlesElem);
                this.#videoSecondarySubtitlesElem = null;
            }
        } else {
            // destroy all
            const subtitlesContainer = this.#videoSubtitlesElem?.parentNode
                || this.#videoSecondarySubtitlesElem?.parentNode;
            if (subtitlesContainer) {
                tryRemoveElement(subtitlesContainer);
            }
            this.#videoSubtitlesElem = null;
            this.#videoSecondarySubtitlesElem = null;
        }
    }

    /**
     * @private
     */
    destroyNativeTracks(videoElement, targetTrackIndex) {
        if (videoElement) {
            const destroySingleTrack = typeof targetTrackIndex === 'number';
            const allTracks = videoElement.textTracks || []; // get list of tracks
            for (let index = 0; index < allTracks.length; index++) {
                const track = allTracks[index];
                // Skip all other tracks if we are targeting just one
                if (destroySingleTrack && targetTrackIndex !== index) {
                    continue;
                }
                if (track.label.includes('manualTrack')) {
                    track.mode = 'disabled';
                }
            }
        }
    }

    /**
     * @private
     */
    destroyStoredTrackInfo(targetTrackIndex) {
        if (this.isPrimaryTrack(targetTrackIndex)) {
            this.#customTrackIndex = -1;
            this.#currentTrackEvents = null;
        } else if (this.isSecondaryTrack(targetTrackIndex)) {
            this.#customSecondaryTrackIndex = -1;
            this.#currentSecondaryTrackEvents = null;
        } else { // destroy all
            this.#customTrackIndex = -1;
            this.#customSecondaryTrackIndex = -1;
            this.#currentTrackEvents = null;
            this.#currentSecondaryTrackEvents = null;
        }
    }

    /**
     * Invalidate in-flight async subtitle work for a target track (or both).
     * Returns the new generation an async completion must capture and later
     * validate via isCurrentSubtitleRenderGeneration.
     * @private
     * @param {number} [targetTrackIndex] - Target track, or undefined for both.
     * @returns {number} The new generation for the (primary-if-both) target.
     */
    bumpSubtitleRenderGeneration(targetTrackIndex) {
        if (this.isSecondaryTrack(targetTrackIndex)) {
            return ++this.#subtitleRenderGenerations[SECONDARY_TEXT_TRACK_INDEX];
        }
        if (this.isPrimaryTrack(targetTrackIndex)) {
            return ++this.#subtitleRenderGenerations[PRIMARY_TEXT_TRACK_INDEX];
        }
        this.#subtitleRenderGenerations[SECONDARY_TEXT_TRACK_INDEX]++;
        return ++this.#subtitleRenderGenerations[PRIMARY_TEXT_TRACK_INDEX];
    }

    /**
     * @private
     * @param {number} targetTrackIndex - Target track the work was started for.
     * @param {number} generation - Generation captured when the work started.
     * @returns {boolean} False when the work has been superseded.
     */
    isCurrentSubtitleRenderGeneration(targetTrackIndex, generation) {
        const index = this.isSecondaryTrack(targetTrackIndex) ? SECONDARY_TEXT_TRACK_INDEX : PRIMARY_TEXT_TRACK_INDEX;
        return this.#subtitleRenderGenerations[index] === generation;
    }

    /**
     * Record how the primary subtitle is now being rendered and notify open
     * overlays, whose capability messaging follows the installed path.
     * @private
     * @param {'custom'|'native'|'ass'|'pgs'|'burned'|'none'|'pending'} path - Installed rendering path.
     */
    setSubtitleRenderPath(path) {
        if (this.#subtitleRenderPath === path) {
            return;
        }

        this.#subtitleRenderPath = path;
        Events.trigger(this, 'subtitlerenderpathchange', [ path ]);
    }

    /**
     * Describe the current primary-subtitle rendering path and which
     * client-side adjustments it actually supports. The single capability
     * source of truth for menus/overlays -- they never re-derive this from
     * stream metadata.
     * @returns {{ path: string, canAdjustSize: boolean, canAdjustOffset: boolean }} Capability answer.
     */
    getSubtitleRenderingInfo() {
        const path = this.#subtitleRenderPath;
        return {
            path,
            // 'none' can adjust size: the preview line still renders and the
            // choice persists for the next enabled subtitle. Native ::cue
            // font-size is known broken on Firefox (the same knowledge that
            // forces Firefox to custom rendering in useCustomSubtitles).
            canAdjustSize: path === 'custom' || path === 'ass' || path === 'none' || path === 'pending'
                || (path === 'native' && !browser.firefox),
            canAdjustOffset: path === 'custom' || path === 'native' || path === 'ass'
                || path === 'pgs' || path === 'pending'
        };
    }

    /**
     * @private
     */
    destroyCustomTrack(videoElement, targetTrackIndex) {
        this.bumpSubtitleRenderGeneration(targetTrackIndex);
        if (!this.isSecondaryTrack(targetTrackIndex)) {
            this.setSubtitleRenderPath('none');
        }
        this.destroyCustomRenderedTrackElements(targetTrackIndex);
        this.destroyNativeTracks(videoElement, targetTrackIndex);
        this.destroyStoredTrackInfo(targetTrackIndex);

        const destroyAssRenderer = index => {
            const renderer = this.#currentAssRenderers[index];
            if (renderer) {
                renderer.dispose();
                this.#assRendererStates.delete(renderer);
                this.#currentAssRenderers[index] = null;
            }
        };
        if (typeof targetTrackIndex === 'number') {
            destroyAssRenderer(targetTrackIndex);
        } else {
            destroyAssRenderer(PRIMARY_TEXT_TRACK_INDEX);
            destroyAssRenderer(SECONDARY_TEXT_TRACK_INDEX);
        }

        if (!this.isSecondaryTrack(targetTrackIndex)) {
            const pgsRenderer = this.#currentPgsRenderer;
            if (pgsRenderer) {
                pgsRenderer.dispose();
            }
            this.#currentPgsRenderer = null;
        }

        if (typeof targetTrackIndex !== 'number' || this.isSecondaryTrack(targetTrackIndex)) {
            this.stopSecondarySubtitleLayoutTimer();
        } else {
            this.updateSecondarySubtitleLayout();
        }
    }

    /**
     * @private
     */
    fetchSubtitlesUwp(track) {
        return Windows.Storage.StorageFile.getFileFromPathAsync(track.Path).then(function (storageFile) {
            return Windows.Storage.FileIO.readTextAsync(storageFile);
        }).then(function (text) {
            return JSON.parse(text);
        });
    }

    /**
     * @private
     */
    async fetchSubtitles(track, item) {
        if (window.Windows && itemHelper.isLocalItem(item)) {
            return this.fetchSubtitlesUwp(track, item);
        }

        this.incrementFetchQueue();
        try {
            const response = await fetch(getTextTrackUrl(track, item, '.js'));

            if (!response.ok) {
                throw new Error(response);
            }

            return response.json();
        } finally {
            this.decrementFetchQueue();
        }
    }

    /**
     * @private
     */
    setTrackForDisplay(videoElement, track, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        if (!track) {
            // Destroy all tracks by passing undefined if there is no valid primary track
            this.destroyCustomTrack(videoElement, this.isSecondaryTrack(targetTextTrackIndex) ? targetTextTrackIndex : undefined);
            return;
        }

        let targetTrackIndex = this.#customTrackIndex;
        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            targetTrackIndex = this.#customSecondaryTrackIndex;
        }

        // skip if already playing this track
        if (targetTrackIndex === track.Index) {
            return;
        }

        this.resetSubtitleOffset();
        const item = this._currentPlayOptions.item;

        this.destroyCustomTrack(videoElement, targetTextTrackIndex);

        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            this.#customSecondaryTrackIndex = track.Index;
        } else {
            this.#customTrackIndex = track.Index;
        }
        this.renderTracksEvents(videoElement, track, item, targetTextTrackIndex);
    }

    /**
     * @private
     */
    renderSsaAss(videoElement, track, item, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        const rendererIndex = this.isSecondaryTrack(targetTextTrackIndex) ?
            SECONDARY_TEXT_TRACK_INDEX :
            PRIMARY_TEXT_TRACK_INDEX;
        const generation = this.#subtitleRenderGenerations[rendererIndex];
        if (this.isPrimaryTrack(rendererIndex)) {
            this.setSubtitleRenderPath('pending');
        }
        const supportedFonts = ['application/vnd.ms-opentype', 'application/x-truetype-font', 'font/otf', 'font/ttf', 'font/woff', 'font/woff2'];
        // libass runs in a worker and cannot use browser/system font-family
        // names by itself. Supply the actual files behind every appearance
        // menu option so \fn overrides render instead of silently falling
        // back to the authored font.
        const availableFonts = [];
        const attachments = this._currentPlayOptions.mediaSource.MediaAttachments || [];
        const apiClient = ServerConnections.getApiClient(item);
        attachments.forEach(i => {
            // we only require font files and ignore embedded media attachments like covers as there are cases where ffmpeg fails to extract those
            if (supportedFonts.includes(i.MimeType)) {
                // embedded font url
                availableFonts.push(apiClient.getUrl(i.DeliveryUrl));
            }
        });
        const fallbackFontList = apiClient.getUrl('/FallbackFont/Fonts', {
            ApiKey: apiClient.accessToken()
        });
        const authoredContentPromise = fetch(getTextTrackUrl(track, item)).then(response => {
            if (!response.ok) {
                throw new Error(response.statusText);
            }
            return response.text();
        });
        const htmlVideoPlayer = this;
        const isCurrentRequest = () => this.isCurrentSubtitleRenderGeneration(rendererIndex, generation);
        loadDynamicModule(() => import('@jellyfin/libass-wasm'),
            '@jellyfin/libass-wasm').then(({ default: SubtitlesOctopus }) => {
            if (!isCurrentRequest()) {
                return;
            }

            const mediaSource = this._currentPlayOptions.mediaSource;
            const videoStream = getMediaStreamVideoTracks(mediaSource)[0];
            let renderer;

            const options = {
                video: videoElement,
                subUrl: getTextTrackUrl(track, item),
                fonts: availableFonts,
                workerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker.js`,
                legacyWorkerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker-legacy.js`,
                onError() {
                    // HACK: Clear JavascriptSubtitlesOctopus: it gets disposed when an error occurs
                    if (htmlVideoPlayer.#currentAssRenderers[rendererIndex] === renderer) {
                        htmlVideoPlayer.#currentAssRenderers[rendererIndex] = null;
                    }
                    if (htmlVideoPlayer.isPrimaryTrack(rendererIndex)) {
                        htmlVideoPlayer.setSubtitleRenderPath('none');
                    }

                    // HACK: Give JavascriptSubtitlesOctopus time to dispose itself
                    setTimeout(() => {
                        onErrorInternal(this, MediaError.ASS_RENDER_ERROR);
                    }, 0);
                },
                onReady() {
                    if (!isCurrentRequest() || renderer !== htmlVideoPlayer.#currentAssRenderers[rendererIndex]) {
                        return;
                    }
                    // The constructor may run its first resize before video
                    // metadata and the final flex layout agree. Normalize the
                    // canvas through libass's own video-position calculation
                    // once the renderer is ready, so the first painted frame
                    // and every later ResizeObserver/window resize share the
                    // same letterboxed coordinate origin.
                    renderer.resize();
                    htmlVideoPlayer.captureAssRendererState(
                        renderer,
                        rendererIndex,
                        generation,
                        authoredContentPromise
                    );
                },
                timeOffset: (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000,

                // new octopus options; override all, even defaults
                renderMode: 'wasm-blend',
                dropAllAnimations: false,
                libassMemoryLimit: 40,
                libassGlyphLimit: 40,
                targetFps: getTargetFps(videoStream?.ReferenceFrameRate),
                prescaleFactor: 0.8,
                prescaleHeightLimit: 1080,
                maxRenderHeight: 2160,
                resizeVariation: 0.2,
                renderAhead: 90
            };

            const createAssRenderer = () => {
                if (!isCurrentRequest()) {
                    return;
                }

                const currentRenderer = this.#currentAssRenderers[rendererIndex];
                if (currentRenderer) {
                    currentRenderer.dispose();
                    this.#assRendererStates.delete(currentRenderer);
                }

                renderer = new SubtitlesOctopus(options);
                this.#currentAssRenderers[rendererIndex] = renderer;
                renderer.canvasParent?.classList.toggle(
                    'libassjs-canvas-parent-secondary',
                    this.isSecondaryTrack(rendererIndex)
                );
                if (this.isPrimaryTrack(rendererIndex)) {
                    this.setSubtitleRenderPath('ass');
                    this.updateSecondarySubtitleLayout();
                } else {
                    this.startSecondarySubtitleLayoutTimer();
                }
                this.applyPendingSubtitleOffset();
            };

            Promise.all([
                apiClient.getNamedConfiguration('encoding'),
                // Worker in Tizen 5 doesn't resolve relative path with async request
                resolveUrl(options.workerUrl),
                resolveUrl(options.legacyWorkerUrl),
                // Asset modules emit relative URLs in production. Resolve
                // them in the main document before handing them to the
                // worker, otherwise it treats them as /web/libraries/* and
                // tears down the renderer on the first 404.
                Promise.all(ASS_USER_FONT_URLS.map(resolveUrl))
            ]).then(([config, workerUrl, legacyWorkerUrl, bundledFontUrls]) => {
                if (!isCurrentRequest()) {
                    return;
                }

                options.workerUrl = workerUrl;
                options.legacyWorkerUrl = legacyWorkerUrl;
                availableFonts.push(...bundledFontUrls);

                if (config.EnableFallbackFont) {
                    apiClient.getJSON(fallbackFontList).then((fontFiles = []) => {
                        if (!isCurrentRequest()) {
                            return;
                        }

                        fontFiles.forEach(font => {
                            const fontUrl = apiClient.getUrl(`/FallbackFont/Fonts/${encodeURIComponent(font.Name)}`, {
                                ApiKey: apiClient.accessToken()
                            });
                            availableFonts.push(fontUrl);
                        });
                        createAssRenderer();
                    }).catch((error) => {
                        console.warn('Failed to load fallback fonts for ASS renderer', error);
                        createAssRenderer();
                    });
                } else {
                    createAssRenderer();
                }
            }).catch((error) => {
                if (!isCurrentRequest()) {
                    return;
                }

                console.error('Failed to initialize ASS renderer', error);
                if (this.isPrimaryTrack(rendererIndex)) {
                    this.setSubtitleRenderPath('none');
                }
                this.#pendingSubtitleOffset = null;
                onErrorInternal(this, MediaError.ASS_RENDER_ERROR);
            });
        }).catch((error) => {
            if (!isCurrentRequest()) {
                return;
            }

            console.error('Failed to load ASS renderer module', error);
            if (this.isPrimaryTrack(rendererIndex)) {
                this.setSubtitleRenderPath('none');
            }
            this.#pendingSubtitleOffset = null;
            onErrorInternal(this, MediaError.ASS_RENDER_ERROR);
        });
    }

    /**
     * Capture the immutable authored ASS source after libass is ready. It is
     * the source for every live user override.
     * @private
     */
    captureAssRendererState(renderer, rendererIndex, generation, authoredContentPromise) {
        const isCurrentRenderer = () =>
            this.isCurrentSubtitleRenderGeneration(rendererIndex, generation)
            && this.#currentAssRenderers[rendererIndex] === renderer;

        authoredContentPromise.then(content => {
            if (!isCurrentRenderer()) {
                return;
            }
            this.#assRendererStates.set(renderer, {
                content,
                appearanceKey: '',
                authoredBottomPercentage:
                    subtitleAppearanceHelper.getAssSubtitleBottomPercentage(content)
            });
            this.applyAssRendererAppearance(renderer);
        }).catch(error => {
            if (isCurrentRenderer()) {
                console.warn('Failed to load ASS source for appearance controls', error);
            }
        });
    }

    /**
     * Apply the current user appearance to libass while retaining authored
     * alignment, margins, positions, animation, colours, and other ASS
     * semantics. A vertical-position choice translates the completed canvas
     * as a nudge around the normal -3 setting instead of flattening all cues
     * to one edge.
     * @private
     */
    applyAssRendererAppearance(renderer) {
        const state = this.#assRendererStates.get(renderer);
        if (!state) {
            return;
        }

        const appearance = this.getEffectiveAppearanceSettings();
        const multiplier = subtitleAppearanceHelper.getTextSizeMultiplier(appearance.textSize);
        const appearanceKey = JSON.stringify([
            multiplier,
            appearance.font || '',
            appearance.textWeight || 'normal'
        ]);
        if (state.appearanceKey !== appearanceKey) {
            state.appearanceKey = appearanceKey;
            renderer.setTrack(getAssContentWithAppearance(state.content, appearance));
        }

        this.setAssRendererVerticalPosition(renderer);

        renderer.setCurrentTime((this.#mediaElement?.currentTime || 0) + renderer.timeOffset);
        this.updateSecondarySubtitleLayout();
    }

    /**
     * Apply the authored-composition nudge plus an optional collision offset.
     * @private
     * @param {Object} renderer - Active libass renderer.
     * @param {number} [additionalOffset=0] - Secondary-lane collision offset in CSS pixels.
     * @returns {void}
     */
    setAssRendererVerticalPosition(renderer, additionalOffset = 0) {
        const appearance = this.getEffectiveAppearanceSettings();
        const positionOffsetPercentage =
            subtitleAppearanceHelper.getAssSubtitleVerticalOffsetPercentage(
                appearance.verticalPosition,
                appearance.textSize);
        const renderedHeight = renderer.canvasParent?.getBoundingClientRect().height
            || this.#mediaElement?.getBoundingClientRect().height
            || 0;
        // The authored 94% baseline is stable even when the selectable range
        // changes. Moving toward the top translates the complete ASS canvas,
        // retaining every cue's relative authored alignment and position.
        const authoredPositionOffset =
            positionOffsetPercentage * renderedHeight / 100;
        const totalOffset = authoredPositionOffset + additionalOffset;
        if (renderer.canvasParent) {
            // SubtitlesOctopus compensates for canvasParent movement during
            // resize by adding the inverse amount to canvas.style.top. That
            // silently cancels a parent transform after seeks, transcode
            // changes, or any ResizeObserver callback. Keep the parent fixed
            // and translate the canvas, whose transform the renderer leaves
            // untouched while recalculating its top/left/size.
            renderer.canvasParent.style.transform = '';
        }
        if (renderer.canvas) {
            renderer.canvas.style.transform =
                totalOffset === 0 ? '' : `translateY(${totalOffset}px)`;
        }
    }

    /**
     * Return the screen bounds of the libass event that is actually visible
     * at the playhead. libass's render-ahead state provides the cue bitmaps,
     * avoiding an expensive full-canvas pixel scan four times per second.
     * @private
     * @param {Object} renderer - Active libass renderer.
     * @returns {{ top: number, right: number, bottom: number, left: number } | null} Active cue bounds.
     */
    getActiveAssCueBounds(renderer) {
        const event = renderer?.oneshotState?.displayedEvent;
        const currentTime = (this.#mediaElement?.currentTime || 0) + (renderer?.timeOffset || 0);
        if (!event?.items?.length
            || currentTime < event.eventStart
            || currentTime >= event.eventFinish) {
            return null;
        }

        const canvas = renderer.canvas;
        const canvasBounds = canvas?.getBoundingClientRect();
        if (!canvasBounds?.width || !canvasBounds.height || !canvas.width || !canvas.height) {
            return null;
        }

        const scaleX = canvasBounds.width / canvas.width;
        const scaleY = canvasBounds.height / canvas.height;
        const bounds = {
            top: Number.POSITIVE_INFINITY,
            right: Number.NEGATIVE_INFINITY,
            bottom: Number.NEGATIVE_INFINITY,
            left: Number.POSITIVE_INFINITY
        };
        event.items.forEach(item => {
            bounds.top = Math.min(bounds.top, canvasBounds.top + item.y * scaleY);
            bounds.right = Math.max(bounds.right, canvasBounds.left + (item.x + item.w) * scaleX);
            bounds.bottom = Math.max(bounds.bottom, canvasBounds.top + (item.y + item.h) * scaleY);
            bounds.left = Math.min(bounds.left, canvasBounds.left + item.x * scaleX);
        });
        return bounds;
    }

    /**
     * Keep the secondary cue in a separate visible lane whenever independently
     * rendered tracks would otherwise paint over one another.
     * @private
     * @returns {void}
     */
    updateSecondarySubtitleLayout() {
        const videoBounds = this.#mediaElement?.getBoundingClientRect();
        if (!videoBounds?.width || !videoBounds.height) {
            return;
        }

        const primaryAssRenderer = this.#currentAssRenderers[PRIMARY_TEXT_TRACK_INDEX];
        const secondaryAssRenderer = this.#currentAssRenderers[SECONDARY_TEXT_TRACK_INDEX];
        if (primaryAssRenderer) {
            this.setAssRendererVerticalPosition(primaryAssRenderer);
        }
        if (secondaryAssRenderer) {
            this.setAssRendererVerticalPosition(secondaryAssRenderer);
        }
        if (this.#videoSecondarySubtitlesElem) {
            this.#videoSecondarySubtitlesElem.style.transform = '';
        }

        const getVisibleElementBounds = element => {
            if (!element
                || element.classList.contains('hide')
                || !element.textContent?.trim()) {
                return null;
            }
            return element.getBoundingClientRect();
        };
        const primaryBounds = primaryAssRenderer ?
            this.getActiveAssCueBounds(primaryAssRenderer) :
            getVisibleElementBounds(this.#videoSubtitlesElem);
        const secondaryBounds = secondaryAssRenderer ?
            this.getActiveAssCueBounds(secondaryAssRenderer) :
            getVisibleElementBounds(this.#videoSecondarySubtitlesElem);
        if (!primaryBounds || !secondaryBounds) {
            return;
        }

        const gap = Math.max(6, (this.#subtitleFontSize || videoBounds.height * 0.045) * 0.3);
        const offset = subtitleAppearanceHelper.getSecondarySubtitleOffset(
            primaryBounds,
            secondaryBounds,
            videoBounds,
            gap
        );
        if (secondaryAssRenderer) {
            this.setAssRendererVerticalPosition(secondaryAssRenderer, offset);
        } else if (this.#videoSecondarySubtitlesElem) {
            this.#videoSecondarySubtitlesElem.style.transform =
                offset === 0 ? '' : `translateY(${offset}px)`;
        }
    }

    /**
     * @private
     * @returns {void}
     */
    startSecondarySubtitleLayoutTimer() {
        if (!this.#subtitleLayoutTimer) {
            this.#subtitleLayoutTimer = setInterval(
                () => this.updateSecondarySubtitleLayout(),
                250
            );
        }
        this.updateSecondarySubtitleLayout();
    }

    /**
     * @private
     * @returns {void}
     */
    stopSecondarySubtitleLayoutTimer() {
        if (this.#subtitleLayoutTimer) {
            clearInterval(this.#subtitleLayoutTimer);
            this.#subtitleLayoutTimer = null;
        }
        if (this.#videoSecondarySubtitlesElem) {
            this.#videoSecondarySubtitlesElem.style.transform = '';
        }
        const secondaryAssRenderer = this.#currentAssRenderers[SECONDARY_TEXT_TRACK_INDEX];
        if (secondaryAssRenderer) {
            this.setAssRendererVerticalPosition(secondaryAssRenderer);
        }
    }

    /**
     * @private
     */
    renderPgs(videoElement, track, item) {
        const generation = this.#subtitleRenderGenerations[PRIMARY_TEXT_TRACK_INDEX];
        this.setSubtitleRenderPath('pending');
        loadDynamicModule(() => import('libpgs'),
            'libpgs').then((libpgs) => {
            // A stale completion must not install a renderer over a
            // superseded selection or a torn-down player.
            if (!this.isCurrentSubtitleRenderGeneration(PRIMARY_TEXT_TRACK_INDEX, generation) || !this.#mediaElement) {
                return;
            }

            const aspectRatio = this.getAspectRatio() === 'auto' ? 'contain' : this.getAspectRatio();
            const options = {
                video: videoElement,
                subUrl: getTextTrackUrl(track, item),
                workerUrl: `${appRouter.baseUrl()}/libraries/libpgs.worker.js`,
                timeOffset: (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000,
                aspectRatio
            };
            this.#currentPgsRenderer = new libpgs.PgsRenderer(options);
            this.setSubtitleRenderPath('pgs');
            this.applyPendingSubtitleOffset();
        }).catch((error) => {
            if (!this.isCurrentSubtitleRenderGeneration(PRIMARY_TEXT_TRACK_INDEX, generation)) {
                return;
            }

            console.error('Failed to load PGS renderer module', error);
            this.setSubtitleRenderPath('none');
            this.#pendingSubtitleOffset = null;
        });
    }

    /**
     * Find or create the shared subtitle container that both the custom
     * renderer and the appearance preview render into.
     * @private
     * @param {HTMLVideoElement} [videoElement] - Rendering target; the preview path omits it and falls back to the current media element.
     * @returns {HTMLElement | null} The container, or null before playback owns a surface.
     */
    getOrCreateSubtitlesContainer(videoElement) {
        let subtitlesContainer = this.#videoSubtitlesElem?.parentNode
            || this.#videoSecondarySubtitlesElem?.parentNode
            || this.#subtitlePreviewElem?.parentNode;
        if (subtitlesContainer) {
            return subtitlesContainer;
        }

        const parent = (videoElement || this.#mediaElement)?.parentNode;
        if (!parent) {
            return null;
        }

        subtitlesContainer = parent.querySelector('.videoSubtitles');
        if (subtitlesContainer) {
            return subtitlesContainer;
        }

        subtitlesContainer = parent.ownerDocument.createElement('div');
        subtitlesContainer.classList.add('videoSubtitles');
        parent.appendChild(subtitlesContainer);
        return subtitlesContainer;
    }

    /**
     * @private
     */
    renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex) {
        const generation = this.#subtitleRenderGenerations[
            this.isSecondaryTrack(targetTextTrackIndex) ? SECONDARY_TEXT_TRACK_INDEX : PRIMARY_TEXT_TRACK_INDEX
        ];
        if (!this.isSecondaryTrack(targetTextTrackIndex)) {
            this.setSubtitleRenderPath('pending');
        }
        this.fetchSubtitles(track, item).then((subtitleData) => {
            // Exit if the video element was destroyed while fetching, or the
            // selection changed (a same-index next item still bumps the
            // generation, so index comparison alone would accept stale data)
            if (!this.#mediaElement || !this.isCurrentSubtitleRenderGeneration(targetTextTrackIndex, generation)) return;

            const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            const subtitleVerticalPosition = parseInt(subtitleAppearance.verticalPosition, 10);

            if (!this.#videoSubtitlesElem && !this.isSecondaryTrack(targetTextTrackIndex)) {
                const subtitlesContainer = this.getOrCreateSubtitlesContainer(videoElement);
                if (!subtitlesContainer) return;
                const subtitlesElement = document.createElement('div');
                subtitlesElement.classList.add('videoSubtitlesInner');
                subtitlesContainer.appendChild(subtitlesElement);
                this.#videoSubtitlesElem = subtitlesElement;
                this.setSubtitleAppearance(subtitlesContainer, this.#videoSubtitlesElem);
                this.#currentTrackEvents = subtitleData.TrackEvents;
                this.setSubtitleRenderPath('custom');
                this.applyPendingSubtitleOffset();
            } else if (!this.#videoSecondarySubtitlesElem && this.isSecondaryTrack(targetTextTrackIndex)) {
                const subtitlesContainer = this.getOrCreateSubtitlesContainer(videoElement);
                if (!subtitlesContainer) return;
                const secondarySubtitlesElement =
                    subtitlesContainer.ownerDocument.createElement('div');
                secondarySubtitlesElement.classList.add('videoSecondarySubtitlesInner');
                // determine the order of the subtitles
                if (subtitleVerticalPosition < 0) {
                    subtitlesContainer.insertBefore(secondarySubtitlesElement, subtitlesContainer.firstChild);
                } else {
                    subtitlesContainer.appendChild(secondarySubtitlesElement);
                }
                this.#videoSecondarySubtitlesElem = secondarySubtitlesElement;
                this.setSubtitleAppearance(subtitlesContainer, this.#videoSecondarySubtitlesElem);
                this.#currentSecondaryTrackEvents = subtitleData.TrackEvents;
                this.applyPendingSubtitleOffset();
                this.startSecondarySubtitleLayoutTimer();
            }
            // Track selection can finish while playback is paused (including
            // inside Document PiP). Paint the cue at the parked playhead now
            // instead of waiting indefinitely for a future timeupdate.
            this.refreshSubtitleTextAtTime(videoElement.currentTime);
        }).catch((error) => {
            if (!this.isCurrentSubtitleRenderGeneration(targetTextTrackIndex, generation)) {
                return;
            }

            console.error(`Failed to fetch subtitles for custom rendering (track ${track.Index})`, error);
            if (!this.isSecondaryTrack(targetTextTrackIndex)) {
                this.setSubtitleRenderPath('none');
                this.#pendingSubtitleOffset = null;
            }
        });
    }

    /**
     * The persisted appearance settings with the transient in-player preview
     * (if one is active) merged on top. Every appearance application flows
     * through this single merge point.
     * @private
     * @returns {Object} Effective subtitle appearance settings.
     */
    getEffectiveAppearanceSettings() {
        const settings = userSettings.getSubtitleAppearanceSettings();
        if (this.#subtitleAppearancePreview) {
            const appearancePreview = { ...this.#subtitleAppearancePreview };
            delete appearancePreview.sampleText;
            Object.assign(settings, appearancePreview);
        }
        return settings;
    }

    /**
     * @private
     */
    setSubtitleAppearance(elem, innerElem) {
        subtitleAppearanceHelper.applyStyles({
            text: innerElem,
            window: elem
        }, this.getEffectiveAppearanceSettings());
    }

    /**
     * Reapply the effective subtitle appearance without restarting playback.
     * Native cues, custom subtitle elements, and the preview line consume the
     * same proportional font-size variable and multiplier mapping.
     * @returns {void}
     */
    updateSubtitleAppearance() {
        const subtitlesContainer = this.#videoSubtitlesElem?.parentNode
            || this.#videoSecondarySubtitlesElem?.parentNode
            || this.#subtitlePreviewElem?.parentNode;

        if (subtitlesContainer && this.#videoSubtitlesElem) {
            this.setSubtitleAppearance(subtitlesContainer, this.#videoSubtitlesElem);
        }
        if (subtitlesContainer && this.#videoSecondarySubtitlesElem) {
            this.setSubtitleAppearance(subtitlesContainer, this.#videoSecondarySubtitlesElem);
        }
        if (subtitlesContainer && this.#subtitlePreviewElem) {
            this.setSubtitleAppearance(subtitlesContainer, this.#subtitlePreviewElem);
        }

        this.#currentAssRenderers.forEach(renderer => {
            if (renderer) {
                this.applyAssRendererAppearance(renderer);
            }
        });
        this.updateNativeCuePositions();
        this.setCueAppearance();
    }

    /**
     * Apply the same bounded top-to-bottom position to browser-native cues.
     * Percentage positioning with centered line alignment keeps both
     * endpoints visible even for multiline cues, and can be changed while
     * playback is paused.
     * @private
     */
    updateNativeCuePositions() {
        const appearance = this.getEffectiveAppearanceSettings();
        const position = subtitleAppearanceHelper.getSubtitleVerticalPosition(
            appearance.verticalPosition,
            appearance.textSize);
        for (const track of this.getTextTracks() || []) {
            for (const cue of track.cues || []) {
                if ('snapToLines' in cue) {
                    cue.snapToLines = false;
                }
                if ('line' in cue) {
                    cue.line = position.centerPercentage;
                }
                if ('lineAlign' in cue) {
                    cue.lineAlign = 'center';
                }
            }
        }
    }

    /**
     * Enter or update the transient appearance preview: the given values
     * override the persisted appearance until cleared, and a sample line is
     * kept visible wherever real subtitles appear whenever no real cue is on
     * screen. Nothing is persisted; pair every call with
     * clearSubtitleAppearancePreview().
     * @param {{ textSize?: string|number, verticalPosition?: string|number, font?: string, textWeight?: string, sampleText: string }} preview - Transient appearance overrides plus translated sample line.
     * @returns {void}
     */
    setSubtitleAppearancePreview(preview) {
        this.#subtitleAppearancePreview = {
            ...preview,
            textSize: preview.textSize == null ? undefined : String(preview.textSize),
            verticalPosition: preview.verticalPosition == null ? undefined : String(preview.verticalPosition)
        };

        if (!this.#subtitlePreviewTimer) {
            // The tick keeps the sample line present across the paused and
            // no-track cases (no timeupdate events) and recreates it if a
            // track teardown removed the shared container.
            this.#subtitlePreviewTimer = setInterval(() => this.updateSubtitlePreviewLine(), 250);
        }

        this.updateSubtitlePreviewLine();
        this.updateSubtitleAppearance();
    }

    /**
     * Exit the transient appearance preview and restore the persisted
     * appearance. Safe to call when no preview is active.
     * @returns {void}
     */
    clearSubtitleAppearancePreview() {
        if (this.#subtitlePreviewTimer) {
            clearInterval(this.#subtitlePreviewTimer);
            this.#subtitlePreviewTimer = null;
        }

        if (!this.#subtitleAppearancePreview) {
            return;
        }

        this.#subtitleAppearancePreview = null;

        const previewElem = this.#subtitlePreviewElem;
        if (previewElem) {
            const container = previewElem.parentNode;
            tryRemoveElement(previewElem);
            this.#subtitlePreviewElem = null;
            // The container is shared with the real renderer; remove it only
            // when the preview was its last remaining content.
            if (container && container.childNodes.length === 0) {
                tryRemoveElement(container);
            }
        }

        this.updateSubtitleAppearance();
    }

    /**
     * Host in-player appearance controls beside the video and custom subtitle
     * renderer so the controls follow them into Document Picture-in-Picture.
     * @returns {HTMLElement} The active video player container.
     */
    getSubtitleAppearanceOverlayHost() {
        if (this.#documentPictureInPictureWindow) {
            // This component is lazy-loaded, so its stylesheet may have
            // arrived after PiP opened. Refresh the copied styles before the
            // panel is created in the PiP document.
            this.copyDocumentPictureInPictureStyles(
                this.#documentPictureInPictureWindow.document
            );
            return this.#videoDialog || this.#documentPictureInPictureWindow.document.body;
        }
        // In normal playback this must remain above (not inside) the player's
        // animation stacking context, otherwise the OSD page can intercept
        // presses even though the panel is visibly painted over the video.
        return document.body;
    }

    /**
     * Keep the preview sample line present and correctly shown/hidden: shown
     * while no real cue text is visible, hidden while one is. This includes
     * primary and secondary DOM, native, and ASS rendering paths.
     * @private
     * @returns {void}
     */
    updateSubtitlePreviewLine() {
        const preview = this.#subtitleAppearancePreview;
        if (!preview) {
            return;
        }

        if (!this.#subtitlePreviewElem?.isConnected) {
            const subtitlesContainer = this.getOrCreateSubtitlesContainer();
            if (!subtitlesContainer) {
                return;
            }

            const previewElement = document.createElement('div');
            // videoSubtitlesInner so the sample inherits exactly the styling
            // real custom cues get; the extra class only marks ownership.
            previewElement.classList.add('videoSubtitlesInner', 'videoSubtitlesPreviewLine');
            subtitlesContainer.appendChild(previewElement);
            this.#subtitlePreviewElem = previewElement;
            this.setSubtitleAppearance(subtitlesContainer, previewElement);
        }

        this.#subtitlePreviewElem.textContent = preview.sampleText;
        const appearance = this.getEffectiveAppearanceSettings();
        const position = subtitleAppearanceHelper.getSubtitleVerticalPosition(
            appearance.verticalPosition,
            appearance.textSize
        );
        // Native VTTCue positions are centre anchors. ASS keeps the selected
        // track's authored lower margin. The shared DOM preview needs a
        // renderer-specific correction for either path.
        let previewTransform = this.#subtitleRenderPath === 'native'
            && position.fraction !== 0 ?
            `translateY(${position.fraction * 50}%)` :
            '';

        const primaryAssRenderer = this.#currentAssRenderers[PRIMARY_TEXT_TRACK_INDEX];
        const assState = primaryAssRenderer ?
            this.#assRendererStates.get(primaryAssRenderer) :
            null;
        const videoBounds = this.#mediaElement?.getBoundingClientRect();
        if (this.#subtitleRenderPath === 'ass'
            && assState
            && videoBounds?.height) {
            if (assState.authoredBottomPercentage !== null) {
                const assPositionOffset =
                    subtitleAppearanceHelper.getAssSubtitleVerticalOffsetPercentage(
                        appearance.verticalPosition,
                        appearance.textSize
                    );
                // The libass canvas moves from the authored 94% baseline. The
                // DOM preview already sits at the selected lower edge, so its
                // correction is authored edge + ASS nudge - selected edge.
                const offset = (
                    assState.authoredBottomPercentage
                    + assPositionOffset
                    - position.percentage
                ) * videoBounds.height / 100;
                if (Math.abs(offset) >= 0.01) {
                    previewTransform = `translateY(${offset}px)`;
                }
            }
        }
        this.#subtitlePreviewElem.style.transform = previewTransform;

        const customCueVisible = [
            this.#videoSubtitlesElem,
            this.#videoSecondarySubtitlesElem
        ].some(element => element
            && !element.classList.contains('hide')
            && !!element.textContent?.trim());
        const nativeCueVisible = this.#subtitleRenderPath === 'native'
            && (this.getTextTracks() || [])
                .some(track => track.activeCues?.length > 0);
        const assCueVisible = this.#currentAssRenderers
            .some(renderer => this.getActiveAssCueBounds(renderer));
        this.#subtitlePreviewElem.classList.toggle(
            'hide',
            customCueVisible || nativeCueVisible || assCueVisible
        );
    }

    /**
     * Observe the rendered video height and publish the shared subtitle
     * baseline on the player container. Invalid zero-size observations retain
     * the most recent valid value.
     * @private
     * @param {HTMLVideoElement} videoElement - Active video element.
     * @returns {void}
     */
    observeSubtitleSize(videoElement) {
        if (this.#subtitleResizeObserver) {
            this.#subtitleResizeObserver.disconnect();
        }

        const applyVideoHeight = videoHeight => {
            const fontSize = subtitleAppearanceHelper.getSubtitleFontSize(videoHeight);
            if (fontSize !== null) {
                this.#subtitleFontSize = fontSize;
                this.#videoDialog?.style.setProperty('--subtitle-font-size', `${fontSize}px`);
                this.#currentAssRenderers.forEach(renderer => {
                    if (renderer) {
                        this.applyAssRendererAppearance(renderer);
                    }
                });
                // Native cues receive a concrete pixel value, so their rule
                // must be regenerated when the rendered video height changes.
                this.setCueAppearance();
            }
        };

        this.#subtitleResizeObserver = new ResizeObserver(entries => {
            const videoEntry = entries.find(entry => entry.target === videoElement);
            if (videoEntry) {
                applyVideoHeight(videoEntry.contentRect.height);
            }
        });
        this.#subtitleResizeObserver.observe(videoElement);
        applyVideoHeight(videoElement.getBoundingClientRect().height);
    }

    /**
     * @private
     */
    getCueCss(appearance, selector) {
        return `${selector}::cue {
                ${appearance.text.map((s) => s.value !== undefined && s.value !== '' ? `${s.name}:${s.value}!important;` : '').join('')}
            }`;
    }

    /**
     * @private
     */
    setCueAppearance() {
        const elementId = `${this.id}-cuestyle`;

        let styleElem = document.querySelector(`#${elementId}`);
        if (!styleElem) {
            styleElem = document.createElement('style');
            styleElem.id = elementId;
            document.getElementsByTagName('head')[0].appendChild(styleElem);
        }

        styleElem.innerHTML = this.getCueCss(
            subtitleAppearanceHelper.getStyles(
                this.getEffectiveAppearanceSettings(),
                false,
                this.#subtitleFontSize
            ),
            '.htmlvideoplayer'
        );
    }

    /**
     * @private
     */
    async renderTracksEvents(videoElement, track, item, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        if (!itemHelper.isLocalItem(item) || track.IsExternal) {
            const format = (track.Codec || '').toLowerCase();
            if (format === 'ssa' || format === 'ass') {
                this.renderSsaAss(videoElement, track, item, targetTextTrackIndex);
                return;
            }
            if (format === 'pgssub') {
                this.renderPgs(videoElement, track, item);
                return;
            }

            if (useCustomSubtitles()) {
                this.renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex);
                return;
            }
        }

        let trackElement = null;
        const updatingTrack = videoElement.textTracks && videoElement.textTracks.length > (this.isSecondaryTrack(targetTextTrackIndex) ? 1 : 0);
        if (updatingTrack) {
            trackElement = videoElement.textTracks[targetTextTrackIndex];
            // This throws an error in IE, but is fine in chrome
            // In IE it's not necessary anyway because changing the src seems to be enough
            try {
                trackElement.mode = 'showing';
                while (trackElement.cues.length) {
                    trackElement.removeCue(trackElement.cues[0]);
                }
            } catch (e) {
                console.error('error removing cue from textTrack', e);
            }

            trackElement.mode = 'disabled';
        } else {
            // There is a function addTextTrack but no function for removeTextTrack
            // Therefore we add ONE element and replace its cue data
            trackElement = videoElement.addTextTrack('subtitles', 'manualTrack', 'und');
        }

        // download the track json
        const generation = this.#subtitleRenderGenerations[
            this.isSecondaryTrack(targetTextTrackIndex) ? SECONDARY_TEXT_TRACK_INDEX : PRIMARY_TEXT_TRACK_INDEX
        ];
        if (!this.isSecondaryTrack(targetTextTrackIndex)) {
            this.setSubtitleRenderPath('pending');
        }
        this.fetchSubtitles(track, item).then(data => {
            // Exit if the video element was destroyed while fetching, or the
            // selection changed: a stale completion would repopulate the
            // shared TextTrack with a superseded track's cues.
            if (!this.#mediaElement || !this.isCurrentSubtitleRenderGeneration(targetTextTrackIndex, generation)) return;

            console.debug(`downloaded ${data.TrackEvents.length} track events`);

            const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            const cuePosition = subtitleAppearanceHelper.getSubtitleVerticalPosition(
                subtitleAppearance.verticalPosition,
                subtitleAppearance.textSize);

            // add some cues to show the text
            // in safari, the cues need to be added before setting the track mode to showing
            for (const trackEvent of data.TrackEvents) {
                const TrackCue = window.VTTCue || window.TextTrackCue;
                const text = normalizeTrackEventText(trackEvent.Text, false);
                const cue = new TrackCue(trackEvent.StartPositionTicks / 10000000, trackEvent.EndPositionTicks / 10000000, text);

                cue.snapToLines = false;
                cue.line = cuePosition.centerPercentage;
                cue.lineAlign = 'center';

                trackElement.addCue(cue);
            }

            trackElement.mode = 'showing';
            if (!this.isSecondaryTrack(targetTextTrackIndex)) {
                this.setSubtitleRenderPath('native');
            }
            this.applyPendingSubtitleOffset();
        }).catch((error) => {
            if (!this.isCurrentSubtitleRenderGeneration(targetTextTrackIndex, generation)) {
                return;
            }

            console.error(`Failed to fetch subtitles for native rendering (track ${track.Index})`, error);
            if (!this.isSecondaryTrack(targetTextTrackIndex)) {
                this.setSubtitleRenderPath('none');
                this.#pendingSubtitleOffset = null;
            }
        });
    }

    /**
     * @private
     */
    updateSubtitleText(timeMs) {
        const allTrackEvents = [this.#currentTrackEvents, this.#currentSecondaryTrackEvents];
        const subtitleTextElements = [this.#videoSubtitlesElem, this.#videoSecondarySubtitlesElem];

        for (let i = 0; i < allTrackEvents.length; i++) {
            const trackEvents = allTrackEvents[i];
            const subtitleTextElement = subtitleTextElements[i];

            if (trackEvents && subtitleTextElement) {
                const ticks = timeMs * 10000;
                let selectedTrackEvent;
                for (const trackEvent of trackEvents) {
                    if (trackEvent.StartPositionTicks <= ticks && trackEvent.EndPositionTicks >= ticks) {
                        selectedTrackEvent = trackEvent;
                        break;
                    }
                }

                if (selectedTrackEvent?.Text) {
                    subtitleTextElement.innerHTML = DOMPurify.sanitize(
                        normalizeTrackEventText(selectedTrackEvent.Text, true));
                    subtitleTextElement.classList.remove('hide');
                } else {
                    subtitleTextElement.classList.add('hide');
                }
            }
        }

        if (this.#subtitleAppearancePreview) {
            this.updateSubtitlePreviewLine();
        }
    }

    /**
     * Re-render custom subtitle cues at a media position. This is called both
     * by playback time updates and by timeline mutations such as offset
     * changes, which must refresh even while playback is paused.
     * @private
     * @param {number | undefined} timeSeconds - Current media position in seconds.
     * @returns {void}
     */
    refreshSubtitleTextAtTime(timeSeconds) {
        const currentPlayOptions = this._currentPlayOptions;
        // Not sure yet how this is coming up null since we never null it out, but it is causing app crashes
        if (!currentPlayOptions || typeof timeSeconds !== 'number') {
            return;
        }

        let timeMs = timeSeconds * 1000;
        timeMs += ((currentPlayOptions.transcodingOffsetTicks || 0) / 10000);
        this.updateSubtitleText(timeMs);
    }

    /**
     * @private
     */
    setCurrentTrackElement(streamIndex, targetTextTrackIndex) {
        console.debug(`setting new text track index to: ${streamIndex}`);

        // Bump at request initiation so whichever async completion belongs to
        // the LATEST request wins, regardless of resolution order.
        const generation = this.bumpSubtitleRenderGeneration(targetTextTrackIndex);
        const mediaStreamTextTracks = getMediaStreamTextTracks(this._currentPlayOptions.mediaSource);

        let track = streamIndex === -1 ? null : mediaStreamTextTracks.filter(function (t) {
            return t.Index === streamIndex;
        })[0];

        // This play method can only check if it is real direct play, and will mark Remux as Transcode as well
        const isDirectPlay = this._currentPlayOptions.playMethod === 'DirectPlay';
        const burnInWhenTranscoding = appSettings.alwaysBurnInSubtitleWhenTranscoding();

        let sessionPromise;
        if (!isDirectPlay && burnInWhenTranscoding) {
            const apiClient = ServerConnections.getApiClient(this._currentPlayOptions.item.ServerId);
            sessionPromise = apiClient.getSessions({
                deviceId: apiClient.deviceId()
            }).then(function (sessions) {
                return sessions[0] || {};
            }, function () {
                return Promise.resolve({});
            });
        } else {
            sessionPromise = Promise.resolve({});
        }

        const player = this;

        sessionPromise.then((s) => {
            // A newer selection superseded this one while the session probe
            // was in flight; acting now would install the wrong track.
            if (!player.isCurrentSubtitleRenderGeneration(targetTextTrackIndex, generation)) {
                return;
            }

            if (!s.TranscodingInfo || s.TranscodingInfo.IsVideoDirect) {
                // restore recorded delivery method if any
                mediaStreamTextTracks.forEach((t) => {
                    t.DeliveryMethod = t.realDeliveryMethod ?? t.DeliveryMethod;
                });
                player.setTrackForDisplay(player.#mediaElement, track, targetTextTrackIndex);
                if (enableNativeTrackSupport(player._currentPlayOptions?.mediaSource, track)) {
                    if (streamIndex !== -1) {
                        player.setCueAppearance();
                    }
                } else {
                    // null these out to disable the player's native display (handled below)
                    streamIndex = -1;
                    track = null;
                }
            } else {
                // record the original delivery method and set all delivery method to encode
                // this is needed for subtitle track switching to properly reload the video stream
                mediaStreamTextTracks.forEach((t) => {
                    t.realDeliveryMethod = t.DeliveryMethod;
                    t.DeliveryMethod = 'Encode';
                });
                // unset stream when switching to transcode: the server burns
                // the subtitle into the picture, where client-side size and
                // offset genuinely cannot apply.
                player.setTrackForDisplay(player.#mediaElement, null, -1);
                if (!player.isSecondaryTrack(targetTextTrackIndex) && streamIndex !== -1) {
                    player.setSubtitleRenderPath('burned');
                    player.#pendingSubtitleOffset = null;
                }
            }
        });
    }

    /**
     * @private
     */
    createMediaElement(options) {
        const dlg = document.querySelector('.videoPlayerContainer');

        if (!dlg) {
            return loadDynamicModule(() => import('./style.scss'),
                       './style.scss').then(() => {
                if (options.fullscreen && !options.alreadyOnVideoOsd) loading.show();

                const playerDlg = document.createElement('div');
                playerDlg.setAttribute('dir', 'ltr');
                playerDlg.classList.add('videoPlayerContainer');
                if (options.fullscreen && !options.alreadyOnVideoOsd) {
                    playerDlg.classList.add('videoPlayerContainer-onTop');
                }

                let html = '';
                const cssClass = 'htmlvideoplayer';

                // Can't autoplay in these browsers so we need to use the full controls, at least until playback starts
                if (!appHost.supports(AppFeature.HtmlVideoAutoplay)) {
                    html += '<video class="' + cssClass + '" preload="metadata" autoplay="autoplay" controls="controls" webkit-playsinline playsinline>';
                } else if (browser.web0s) {
                    // in webOS, setting preload auto allows resuming videos
                    html += '<video class="' + cssClass + '" preload="auto" autoplay="autoplay" webkit-playsinline playsinline>';
                } else {
                    // Chrome 35 won't play with preload none
                    html += '<video class="' + cssClass + '" preload="metadata" autoplay="autoplay" webkit-playsinline playsinline>';
                }

                html += '</video>';

                playerDlg.innerHTML = html;
                const videoElement = playerDlg.querySelector('video');

                // TODO: Move volume control to PlaybackManager. Player should just be a wrapper that translates commands into API calls.
                if (!appHost.supports(AppFeature.PhysicalVolumeControl)) {
                    videoElement.volume = getSavedVolume();
                }

                videoElement.addEventListener('timeupdate', this.onTimeUpdate);
                videoElement.addEventListener('ended', this.onEnded);
                videoElement.addEventListener('volumechange', this.onVolumeChange);
                videoElement.addEventListener('pause', this.onPause);
                videoElement.addEventListener('canplay', this.onCanPlay);
                videoElement.addEventListener('playing', this.onPlaying);
                videoElement.addEventListener('play', this.onPlay);
                videoElement.addEventListener('click', this.onClick);
                videoElement.addEventListener('dblclick', this.onDblClick);
                videoElement.addEventListener('waiting', this.onWaiting);
                if (options.backdropUrl) {
                    videoElement.poster = options.backdropUrl;
                }

                document.body.insertBefore(playerDlg, document.body.firstChild);
                this.#videoDialog = playerDlg;
                this.#mediaElement = videoElement;
                this.observeSubtitleSize(videoElement);

                delete this.forcedFullscreen;

                if (options.fullscreen) {
                    // At this point, we must hide the scrollbar placeholder, so it's not being displayed while the item is being loaded
                    document.body.classList.add('hide-scroll');

                    // Enter fullscreen in the webOS browser to hide the top bar
                    if (!window.NativeShell && browser.web0s && Screenfull.isEnabled) {
                        Screenfull.request().then(() => {
                            this.forcedFullscreen = true;
                        });
                        return videoElement;
                    }

                    // don't animate on smart tv's, too slow
                    if (!browser.slow && browser.supportsCssAnimation()) {
                        return zoomIn(playerDlg).then(function () {
                            return videoElement;
                        });
                    }
                }

                return videoElement;
            });
        } else {
            if (options.alreadyOnVideoOsd) {
                dlg.classList.remove('videoPlayerContainer-onTop');
            }

            if (options.fullscreen) {
                // we need to hide scrollbar when starting playback from page with animated background
                document.body.classList.add('hide-scroll');

                // Enter fullscreen in the webOS browser to hide the top bar
                if (!this.forcedFullscreen && !window.NativeShell && browser.web0s && Screenfull.isEnabled) {
                    Screenfull.request().then(() => {
                        this.forcedFullscreen = true;
                    });
                }
            }

            const videoElement = dlg.querySelector('video');
            this.#videoDialog = dlg;
            this.#mediaElement = videoElement;
            this.observeSubtitleSize(videoElement);
            if (options.backdropUrl) {
                // update backdrop image
                videoElement.poster = options.backdropUrl;
            }

            return Promise.resolve(videoElement);
        }
    }

    /**
     * @private
     */
    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'video';
    }

    /**
     * @private
     */
    supportsPlayMethod(playMethod, item) {
        if (appHost.supportsPlayMethod) {
            return appHost.supportsPlayMethod(playMethod, item);
        }

        return true;
    }

    /**
     * @private
     */
    getDeviceProfile(item, options) {
        return HtmlVideoPlayer.getDeviceProfileInternal(item, options).then((profile) => {
            this.#lastProfile = profile;
            return profile;
        });
    }

    /**
     * @private
     */
    static getDeviceProfileInternal(item, options) {
        if (appHost.getDeviceProfile) {
            return appHost.getDeviceProfile(item, options);
        }

        return getDefaultProfile();
    }

    /**
     * @private
     */
    static getSupportedFeatures() {
        const list = [];

        const video = document.createElement('video');
        if (
            // Chromium's Document PiP can carry the custom subtitle renderer
            // and its controls along with the video.
            typeof window.documentPictureInPicture?.requestWindow === 'function'
            // Check non-standard Safari PiP support
            || typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture') && typeof video.webkitSetPresentationMode === 'function'
            // Check non-standard Windows PiP support
            || (window.Windows
                && Windows.UI.ViewManagement.ApplicationView.getForCurrentView()
                    .isViewModeSupported(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay))
            // Check standard PiP support
            || document.pictureInPictureEnabled
        ) {
            list.push('PictureInPicture');
        }

        if (browser.safari || browser.iOS || browser.iPad) {
            list.push('AirPlay');
        }

        if (typeof video.playbackRate === 'number') {
            list.push('PlaybackRate');
        }

        list.push('SetBrightness');
        list.push('SetAspectRatio');
        list.push('SecondarySubtitles');

        return list;
    }

    supports(feature) {
        if (!this.#supportedFeatures) {
            this.#supportedFeatures = HtmlVideoPlayer.getSupportedFeatures();
        }

        return this.#supportedFeatures.includes(feature);
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            if (val != null) {
                mediaElement.currentTime = val / 1000;
                return;
            }

            const currentTime = this.#currentTime;
            if (currentTime) {
                return currentTime * 1000;
            }

            return (mediaElement.currentTime || 0) * 1000;
        }
    }

    duration() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            const duration = mediaElement.duration;
            if (isValidDuration(duration)) {
                return duration * 1000;
            }
        }

        return null;
    }

    canSetAudioStreamIndex() {
        const video = this.#mediaElement;
        if (video) {
            return canPlaySecondaryAudio(video);
        }

        return false;
    }

    static onPictureInPictureError(err) {
        console.error(`Picture in picture error: ${err}`);
    }

    /**
     * Copy the app's loaded styles into a Document PiP browsing context. A
     * moved element keeps its classes but resolves CSS against its new
     * document, so without this the video, subtitles, and controls are
     * unstyled.
     * @private
     * @param {Document} targetDocument - PiP document receiving the player.
     */
    copyDocumentPictureInPictureStyles(targetDocument) {
        targetDocument.querySelectorAll('[data-sloptank-pip-style]')
            .forEach(element => {
                element.remove();
            });

        for (const source of document.querySelectorAll('link[rel="stylesheet"], style')) {
            const copy = source.cloneNode(true);
            copy.setAttribute('data-sloptank-pip-style', '');
            if (source instanceof HTMLLinkElement && copy instanceof HTMLLinkElement) {
                copy.href = source.href;
            }
            targetDocument.head.appendChild(copy);
        }

        const baseStyle = targetDocument.createElement('style');
        baseStyle.setAttribute('data-sloptank-pip-style', '');
        baseStyle.textContent = `
            html, body {
                width: 100%;
                height: 100%;
                margin: 0;
                overflow: hidden;
                background: #000;
            }
            .videoPlayerContainer {
                width: 100vw;
                height: 100vh;
            }
            .videoPlayerContainer > video[controls]::-webkit-media-controls {
                display: flex !important;
            }
            .documentPipSubtitleAppearanceButton {
                position: fixed;
                top: .75em;
                right: .75em;
                z-index: 1300;
                width: 2.6em;
                height: 2.6em;
                padding: 0;
                border: 1px solid rgba(255, 255, 255, .45);
                border-radius: 50%;
                color: #fff;
                background: rgba(20, 20, 20, .72);
                font: 600 1em/1 sans-serif;
                cursor: pointer;
            }
            .documentPipSubtitleAppearanceButton:hover,
            .documentPipSubtitleAppearanceButton:focus-visible {
                background: rgba(45, 45, 45, .95);
            }
        `;
        targetDocument.head.appendChild(baseStyle);
    }

    /**
     * Open the appearance panel from the compact control inside Document PiP.
     * @private
     * @returns {Promise<void>}
     */
    async openDocumentPictureInPictureAppearance() {
        this.#documentPictureInPictureAppearanceOverlay?.destroy();

        const { default: SubtitleSizer } =
            await loadDynamicModule(() => import('../../components/subtitlesizer/subtitlesizer'), '../../components/subtitlesizer/subtitlesizer');
        if (!this.#documentPictureInPictureWindow || !this.#videoDialog) {
            return;
        }

        this.#documentPictureInPictureAppearanceOverlay = new SubtitleSizer({
            player: this,
            settings: userSettings,
            translate: globalize.translate,
            onClose: () => {
                this.#documentPictureInPictureAppearanceOverlay = null;
            }
        });
    }

    /**
     * Put the complete video surface in a Document PiP window. This retains
     * DOM-, canvas-, and image-rendered subtitles plus the appearance panel.
     * @private
     * @returns {Promise<void>}
     */
    async enterDocumentPictureInPicture() {
        const documentPictureInPicture = window.documentPictureInPicture;
        const videoDialog = this.#videoDialog;
        const video = this.#mediaElement;
        if (!documentPictureInPicture?.requestWindow || !videoDialog || !video) {
            return;
        }

        const rect = video.getBoundingClientRect();
        const pipWindow = await documentPictureInPicture.requestWindow({
            width: Math.max(320, Math.round(rect.width)),
            height: Math.max(180, Math.round(rect.height))
        });

        // Playback can be torn down while the user-agent is opening the
        // window. Do not move a stale player into it.
        if (this.#videoDialog !== videoDialog || this.#mediaElement !== video) {
            pipWindow.close();
            return;
        }

        this.#documentPictureInPictureWindow = pipWindow;
        this.#documentPictureInPictureRestorePoint = {
            parent: videoDialog.parentNode,
            nextSibling: videoDialog.nextSibling
        };
        this.copyDocumentPictureInPictureStyles(pipWindow.document);
        pipWindow.document.body.appendChild(videoDialog);
        this.#documentPictureInPictureOriginalVideoControls = video.controls;
        video.controls = true;

        const appearanceButton = pipWindow.document.createElement('button');
        appearanceButton.type = 'button';
        appearanceButton.classList.add('documentPipSubtitleAppearanceButton');
        appearanceButton.title = globalize.translate('HeaderSubtitleAppearance');
        appearanceButton.setAttribute(
            'aria-label',
            globalize.translate('HeaderSubtitleAppearance')
        );
        appearanceButton.textContent = 'Aa';
        appearanceButton.addEventListener('click', () => {
            this.openDocumentPictureInPictureAppearance().catch(
                HtmlVideoPlayer.onPictureInPictureError
            );
        });
        videoDialog.appendChild(appearanceButton);
        this.#documentPictureInPictureAppearanceButton = appearanceButton;

        this.#documentPictureInPicturePageHideHandler = () => {
            this.restoreDocumentPictureInPicturePlayer();
        };
        pipWindow.addEventListener(
            'pagehide',
            this.#documentPictureInPicturePageHideHandler,
            { once: true }
        );
    }

    /**
     * Move the player back to its exact original DOM position.
     * @private
     */
    restoreDocumentPictureInPicturePlayer() {
        const pipWindow = this.#documentPictureInPictureWindow;
        const restorePoint = this.#documentPictureInPictureRestorePoint;
        const videoDialog = this.#videoDialog;
        const video = this.#mediaElement;

        if (pipWindow && this.#documentPictureInPicturePageHideHandler) {
            pipWindow.removeEventListener(
                'pagehide',
                this.#documentPictureInPicturePageHideHandler
            );
        }

        this.#documentPictureInPictureWindow = null;
        this.#documentPictureInPictureRestorePoint = null;
        this.#documentPictureInPicturePageHideHandler = null;
        this.#documentPictureInPictureAppearanceOverlay?.destroy();
        this.#documentPictureInPictureAppearanceOverlay = null;
        this.#documentPictureInPictureAppearanceButton?.remove();
        this.#documentPictureInPictureAppearanceButton = null;
        if (video && this.#documentPictureInPictureOriginalVideoControls != null) {
            video.controls = this.#documentPictureInPictureOriginalVideoControls;
        }
        this.#documentPictureInPictureOriginalVideoControls = null;

        if (videoDialog && restorePoint?.parent) {
            const nextSibling = restorePoint.nextSibling
                && Array.from(restorePoint.parent.childNodes).includes(restorePoint.nextSibling) ?
                restorePoint.nextSibling :
                null;
            restorePoint.parent.insertBefore(videoDialog, nextSibling);
        }
    }

    /**
     * Close Document PiP and restore the player. Idempotent.
     * @private
     */
    exitDocumentPictureInPicture() {
        const pipWindow = this.#documentPictureInPictureWindow;
        if (!pipWindow) {
            return;
        }

        this.restoreDocumentPictureInPicturePlayer();
        if (!pipWindow.closed) {
            pipWindow.close();
        }
    }

    async setPictureInPictureEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (typeof window.documentPictureInPicture?.requestWindow === 'function') {
            if (isEnabled) {
                try {
                    await this.enterDocumentPictureInPicture();
                } catch (error) {
                    HtmlVideoPlayer.onPictureInPictureError(error);
                }
            } else {
                this.exitDocumentPictureInPicture();
            }
        } else if (document.pictureInPictureEnabled) {
            if (video) {
                if (isEnabled) {
                    await video.requestPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                } else {
                    await document.exitPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                }
            }
        } else if (window.Windows) {
            this.isPip = isEnabled;
            if (isEnabled) {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay);
            } else {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.default);
            }
        } else if (video?.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === 'function') {
            video.webkitSetPresentationMode(isEnabled ? 'picture-in-picture' : 'inline');
        }
    }

    isPictureInPictureEnabled() {
        if (this.#documentPictureInPictureWindow
                && !this.#documentPictureInPictureWindow.closed) {
            return true;
        } else if (document.pictureInPictureEnabled) {
            return !!document.pictureInPictureElement;
        } else if (window.Windows) {
            return this.isPip || false;
        } else {
            const video = this.#mediaElement;
            if (video) {
                return video.webkitPresentationMode === 'picture-in-picture';
            }
        }

        return false;
    }

    isAirPlayEnabled() {
        if (document.AirPlayEnabled) {
            return !!document.AirplayElement;
        }

        return false;
    }

    setAirPlayEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (document.AirPlayEnabled) {
            if (video) {
                if (isEnabled) {
                    video.requestAirPlay().catch(function(err) {
                        console.error('Error requesting AirPlay', err);
                    });
                } else {
                    document.exitAirPLay().catch(function(err) {
                        console.error('Error exiting AirPlay', err);
                    });
                }
            }
        } else {
            video.webkitShowPlaybackTargetPicker();
        }
    }

    setBrightness(val) {
        const elem = this.#mediaElement;

        if (elem) {
            val = Math.max(0, val);
            val = Math.min(100, val);

            let rawValue = val;
            rawValue = Math.max(20, rawValue);

            const cssValue = rawValue >= 100 ? 'none' : (rawValue / 100);
            elem.style['-webkit-filter'] = `brightness(${cssValue})`;
            elem.style.filter = `brightness(${cssValue})`;
            elem.brightnessValue = val;
            Events.trigger(this, 'brightnesschange');
        }
    }

    getBrightness() {
        const elem = this.#mediaElement;
        if (elem) {
            const val = elem.brightnessValue;
            return val == null ? 100 : val;
        }
    }

    seekable() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            const seekable = mediaElement.seekable;
            if (seekable?.length) {
                let start = seekable.start(0);
                let end = seekable.end(0);

                if (!isValidDuration(start)) {
                    start = 0;
                }
                if (!isValidDuration(end)) {
                    end = 0;
                }

                return (end - start) > 0;
            }

            return false;
        }
    }

    pause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.pause();
        }
    }

    // This is a retry after error
    resume() {
        this.unpause();
    }

    unpause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }

    paused() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.paused;
        }

        return false;
    }

    setPlaybackRate(value) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.playbackRate = value;
        }
    }

    getPlaybackRate() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.playbackRate;
        }
        return null;
    }

    getSupportedPlaybackRates() {
        return [{
            name: '0.5x',
            id: 0.5
        }, {
            name: '0.75x',
            id: 0.75
        }, {
            name: '1x',
            id: 1.0
        }, {
            name: '1.25x',
            id: 1.25
        }, {
            name: '1.5x',
            id: 1.5
        }, {
            name: '1.75x',
            id: 1.75
        }, {
            name: '2x',
            id: 2.0
        }, {
            name: '2.5x',
            id: 2.5
        }, {
            name: '3x',
            id: 3.0
        }, {
            name: '3.5x',
            id: 3.5
        }, {
            name: '4.0x',
            id: 4.0
        }];
    }

    setVolume(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.volume = Math.pow(val / 100, 3);
        }
    }

    getVolume() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return Math.min(Math.round(Math.pow(mediaElement.volume, 1 / 3) * 100), 100);
        }
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.muted = mute;
        }
    }

    isMuted() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.muted;
        }
        return false;
    }

    #applyAspectRatio(val = this.getAspectRatio()) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            if (val === 'auto') {
                mediaElement.style.removeProperty('object-fit');
            } else {
                mediaElement.style['object-fit'] = val;
            }
        }

        if (this.#currentPgsRenderer) {
            this.#currentPgsRenderer.aspectRatio = val === 'auto' ? 'contain' : val;
        }
    }

    setAspectRatio(val) {
        appSettings.aspectRatio(val);
        this.#applyAspectRatio(val);
    }

    getAspectRatio() {
        return appSettings.aspectRatio() || 'auto';
    }

    getSupportedAspectRatios() {
        return [{
            name: globalize.translate('Auto'),
            id: 'auto'
        }, {
            name: globalize.translate('AspectRatioCover'),
            id: 'cover'
        }, {
            name: globalize.translate('AspectRatioFill'),
            id: 'fill'
        }];
    }

    togglePictureInPicture() {
        return this.setPictureInPictureEnabled(!this.isPictureInPictureEnabled());
    }

    toggleAirPlay() {
        return this.setAirPlayEnabled(!this.isAirPlayEnabled());
    }

    getBufferedRanges() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return getBufferedRanges(this, mediaElement);
        }

        return [];
    }

    getStats() {
        const mediaElement = this.#mediaElement;
        const playOptions = this._currentPlayOptions || [];

        const categories = [];

        if (!mediaElement) {
            return Promise.resolve({
                categories: categories
            });
        }

        const mediaCategory = {
            stats: [],
            type: 'media'
        };
        categories.push(mediaCategory);

        if (playOptions.url) {
            //  create an anchor element (note: no need to append this element to the document)
            let link = document.createElement('a');
            //  set href to any path
            link.setAttribute('href', playOptions.url);
            const protocol = (link.protocol || '').replace(':', '');

            if (protocol) {
                mediaCategory.stats.push({
                    label: globalize.translate('LabelProtocol'),
                    value: protocol
                });
            }

            link = null;
        }

        if (this._hlsPlayer) {
            mediaCategory.stats.push({
                label: globalize.translate('LabelStreamType'),
                value: 'HLS'
            });
        } else {
            mediaCategory.stats.push({
                label: globalize.translate('LabelStreamType'),
                value: 'Video'
            });
        }

        const videoCategory = {
            stats: [],
            type: 'video'
        };
        categories.push(videoCategory);

        const devicePixelRatio = window.devicePixelRatio || 1;
        const rect = mediaElement.getBoundingClientRect ? mediaElement.getBoundingClientRect() : {};
        let height = Math.round(rect.height * devicePixelRatio);
        let width = Math.round(rect.width * devicePixelRatio);

        // Don't show player dimensions on smart TVs because the app UI could be lower resolution than the video and this causes users to think there is a problem
        if (width && height && !browser.tv) {
            videoCategory.stats.push({
                label: globalize.translate('LabelPlayerDimensions'),
                value: `${width}x${height}`
            });
        }

        height = mediaElement.videoHeight;
        width = mediaElement.videoWidth;

        if (width && height) {
            videoCategory.stats.push({
                label: globalize.translate('LabelVideoResolution'),
                value: `${width}x${height}`
            });
        }

        if (mediaElement.getVideoPlaybackQuality) {
            const playbackQuality = mediaElement.getVideoPlaybackQuality();

            const droppedVideoFrames = playbackQuality.droppedVideoFrames || 0;
            videoCategory.stats.push({
                label: globalize.translate('LabelDroppedFrames'),
                value: droppedVideoFrames
            });

            const corruptedVideoFrames = playbackQuality.corruptedVideoFrames || 0;
            videoCategory.stats.push({
                label: globalize.translate('LabelCorruptedFrames'),
                value: corruptedVideoFrames
            });
        }

        const audioCategory = {
            stats: [],
            type: 'audio'
        };
        categories.push(audioCategory);

        const sinkId = mediaElement.sinkId;
        if (sinkId) {
            audioCategory.stats.push({
                label: 'Sink Id:',
                value: sinkId
            });
        }

        return Promise.resolve({
            categories: categories
        });
    }
}

export default HtmlVideoPlayer;
