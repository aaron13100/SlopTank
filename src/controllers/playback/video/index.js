// SlopTank modification notice: added or changed by SlopTank on 2026-07-18, 2026-07-19, 2026-07-22, 2026-07-23, 2026-07-24, 2026-07-28, 2026-08-01, 2026-08-03, 2026-08-09, 2026-08-11, 2026-08-28, 2026-09-08, 2026-09-09, 2026-09-23, 2026-09-24.
/**
 * Video OSD controller: the composition root for the video playback page.
 *
 * The work behind the OSD used to live in one 1824-line closure, which sat
 * over the M201 1000-line release gate and blocked every edit (including the
 * c209-sibling promise fix in audioTrackMenu.js). It is now this facade plus
 * seven collaborators, one per responsibility, all in this directory:
 *
 *   nowPlayingDetails   now-playing title, secondary info, rating and record buttons
 *   osdVisibility       OSD chrome show/hide, slide animation, idle auto-hide timer
 *   positionDisplay     seek slider, time texts, time-of-day progress, bubbles
 *   settingsOverlays    settings menu, stats overlay, subtitle-sync overlay
 *   audioTrackMenu      the OSD audio-track action sheet
 *   upNextControl       the 'up next' episode card
 *   videoInputControl   keyboard/remote/gamepad/pointer input, bind/unbind
 *
 * Each collaborator is constructed with a small options object of the
 * accessors and adapters it needs; none of them import each other or this
 * file, so none joins the app's existing import cycle. This file keeps the
 * player-binding lifecycle (bindToPlayer/releaseCurrentPlayer, the state-change
 * handlers, trickplay discovery) and the view wiring, and orchestrates the
 * collaborators through their small returned APIs.
 */
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { getTvShowsApi } from '@jellyfin/sdk/lib/utils/api/tv-shows-api';

import { PlayerEvent } from 'apps/stable/features/playback/constants/playerEvent';
import { AppFeature } from 'constants/appFeature';

import { playbackManager } from '../../../components/playback/playbackmanager';
import { loadPlaybackRate } from '../../../components/playback/playbackRatePreference';
import dom from '../../../utils/dom';
import datetime from '../../../scripts/datetime';
import Events from '../../../utils/events.ts';
import globalize from '../../../lib/globalize';
import { appHost } from '../../../components/apphost';
import layoutManager from '../../../components/layoutManager';
import * as userSettings from '../../../scripts/settings/userSettings';
import '../../../styles/scrollstyles.scss';
import '../../../elements/emby-slider/emby-slider';
import '../../../elements/emby-button/paper-icon-button-light';
import '../../../elements/emby-ratingbutton/emby-ratingbutton';
import '../../../styles/videoosd.scss';
import shell from '../../../scripts/shell';
import { appRouter } from '../../../components/router/appRouter';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { setBackdropTransparency, TRANSPARENCY_LEVEL } from '../../../components/backdrop/backdrop';
import SyncPlayIconControl from './SyncPlayIconControl';
import PersistentTitleControl from './PersistentTitleControl';
import { toApi } from '../../../utils/jellyfin-apiclient/compat';
import { canonicalizeLegacyGuidRoute } from '../../../components/router/permalinkCanonicalizer';
import { createPermalinkResume } from './permalinkResume';
import SubtitleTrackMenu from './SubtitleTrackMenu';
import EpisodePlaybackMenu from './EpisodePlaybackMenu';
import VolumeControl from './VolumeControl';
import TransportControl from './TransportControl';
import { selectTrickplayResolution, TrickplayDiscovery } from './trickplayDiscovery';
import { loadDynamicModule } from 'utils/dynamicImport';
import { getOpenedDialog } from './videoDialogState';
import { createSubtitleHotkey } from './subtitleHotkey';
import { currentTimeMs } from 'utils/clock';
import { createNowPlayingDetails } from './nowPlayingDetails';
import { createOsdVisibility } from './osdVisibility';
import { createPositionDisplay } from './positionDisplay';
import { createSettingsOverlays } from './settingsOverlays';
import { createAudioTrackMenu } from './audioTrackMenu';
import { createUpNextControl } from './upNextControl';
import { createVideoInputControl } from './videoInputControl';

export default function (view) {
    function updateDisplayItem(itemInfo) {
        const item = itemInfo.originalItem;
        currentItem = item;
        const displayItem = itemInfo.displayItem || item;
        nowPlayingDetails.update(displayItem, item);
        positionDisplay.setProgramTimes(displayItem);

        // Update trickplay data
        trickplayDiscovery.stop();

        const mediaSourceId = currentPlayer.streamInfo.mediaSource.Id;
        const maxWidth = window.screen.width * window.devicePixelRatio * 0.2;
        trickplayResolution = selectTrickplayResolution(item, mediaSourceId, maxWidth);
        if (!trickplayResolution && item.Id) {
            const itemId = item.Id;
            const apiClient = ServerConnections.getApiClient(item.ServerId);
            trickplayDiscovery.start(
                () => apiClient.getItems(apiClient.getCurrentUserId(), {
                    Ids: itemId,
                    Fields: [ 'Trickplay' ],
                    Limit: 1
                }).then(result => result.Items?.[0]),
                mediaSourceId,
                maxWidth,
                (refreshedItem, resolution) => {
                    if (currentItem?.Id !== itemId
                        || currentPlayer?.streamInfo.mediaSource.Id !== mediaSourceId) {
                        return;
                    }

                    currentItem.Trickplay = refreshedItem.Trickplay;
                    trickplayResolution = resolution;
                }
            );
        }
    }

    function updateNowPlayingInfo(player, state) {
        const item = state.NowPlayingItem;

        currentItem = item;
        canonicalizeVideoRoute(item);

        if (!item) {
            nowPlayingDetails.clear();
            volumeControl.setDisabled(true);
            nowPlayingPositionSlider.disabled = true;
            btnFastForward.disabled = true;
            btnRewind.disabled = true;
            view.querySelector('.btnSubtitles').classList.add('hide');
            view.querySelector('.btnAudio').classList.add('hide');
            episodePlaybackMenu.update(null);
            return;
        }

        positionDisplay.setProgressByTimeOfDay(item);
        episodePlaybackMenu.update(item);
        nowPlayingDetails.getDisplayItem(item).then(updateDisplayItem);
        volumeControl.setDisabled(false);
        nowPlayingPositionSlider.disabled = false;
        btnFastForward.disabled = false;
        btnRewind.disabled = false;

        if (playbackManager.subtitleTracks(player).length) {
            view.querySelector('.btnSubtitles').classList.remove('hide');
            settingsOverlays.toggleSubtitleSync();
        } else {
            view.querySelector('.btnSubtitles').classList.add('hide');
            settingsOverlays.toggleSubtitleSync('forceToHide');
        }

        if (playbackManager.audioTracks(player).length > 1) {
            view.querySelector('.btnAudio').classList.remove('hide');
        } else {
            view.querySelector('.btnAudio').classList.add('hide');
        }

        if (currentItem.Chapters?.length > 1) {
            view.querySelector('.btnPreviousChapter').classList.remove('hide');
            view.querySelector('.btnNextChapter').classList.remove('hide');
        } else {
            view.querySelector('.btnPreviousChapter').classList.add('hide');
            view.querySelector('.btnNextChapter').classList.add('hide');
        }
    }

    function onFullscreenChanged() {
        if (currentPlayer.forcedFullscreen && !playbackManager.isFullscreen(currentPlayer)) {
            appRouter.back();
            return;
        }

        updateFullscreenIcon();
    }

    function updateFullscreenIcon() {
        const button = view.querySelector('.btnFullscreen');
        const icon = button.querySelector('.material-icons');

        icon.classList.remove('fullscreen_exit', 'fullscreen');

        if (playbackManager.isFullscreen(currentPlayer)) {
            button.setAttribute('title', globalize.translate('ExitFullscreen') + ' (F)');
            icon.classList.add('fullscreen_exit');
        } else {
            button.setAttribute('title', globalize.translate('Fullscreen') + ' (F)');
            icon.classList.add('fullscreen');
        }
    }

    function onPlayerChange() {
        bindToPlayer(playbackManager.getCurrentPlayer());
    }

    function onStateChanged(event, state) {
        const player = this;

        if (state.NowPlayingItem) {
            isEnabled = true;
            updatePlayerStateInternal(event, player, state);
            transportControl.updatePlaylist();
            enableStopOnBack(true);
            transportControl.restorePlaybackRate(player, loadPlaybackRate());
        }
    }

    function onPlayPauseStateChanged() {
        if (isEnabled) {
            transportControl.updatePlayPauseState(this.paused());
            osd.resetIdle();
        }
    }

    function onVolumeChanged() {
        if (isEnabled) {
            const player = this;
            volumeControl.update({ isMuted: player.isMuted(),
                supportedCommands: playbackManager.getSupportedCommands(player), volumeLevel: player.getVolume() });
        }
    }

    function onPlaybackStart(e, state) {
        // A same-player next-item transition emits no playerchange; a size
        // overlay left open would preview onto the new item.
        subtitleTrackMenu.closeOverlays();
        episodePlaybackMenu.close();
        console.debug('nowplaying event: ' + e.type);
        const player = this;
        onStateChanged.call(player, e, state);
        upNextControl.reset();
    }

    function onPlaybackStopped(e, state) {
        currentRuntimeTicks = null;
        positionDisplay.setRuntimeTicks(null);
        upNextControl.reset();
        console.debug('nowplaying event: ' + e.type);

        if (state.NextMediaType !== 'Video') {
            view.removeEventListener('viewbeforehide', onViewHideStopPlayback);
            appRouter.back();
        }
    }

    function onMediaStreamsChanged() {
        const player = this;
        const state = playbackManager.getPlayerState(player);
        onStateChanged.call(player, {
            type: 'init'
        }, state);
    }

    function onBeginFetch() {
        view.querySelector('.osdMediaStatus').classList.remove('hide');
    }

    function onEndFetch() {
        view.querySelector('.osdMediaStatus').classList.add('hide');
    }

    function setPermalinkPreparing(isPreparing) {
        view.classList.toggle('videoOsd-isPreparing', isPreparing);
        view.toggleAttribute('aria-busy', isPreparing);
        view.querySelector('.videoOsdLoading').classList.toggle('hide', !isPreparing);
    }

    function onVideoReady() {
        setPermalinkPreparing(false);
    }

    // See permalinkResume.js: resume-from-permalink is a self-contained
    // responsibility (fetch the item, resolve the right start position and
    // paused/playing state, start playback) with only two dependencies back
    // into this controller, both passed in below.
    const permalinkResume = createPermalinkResume({ setPermalinkPreparing, canonicalizeVideoRoute });

    /**
     * Replaces the legacy GUID watch route with the item's canonical
     * permalink, in place, while playback continues.
     *
     * The rewrite goes through the router (appRouter.canonicalizeAddressBar)
     * and carries the state that lets ViewManagerPage recognise the
     * destination as the view already on screen, so this view is re-labelled
     * rather than rebuilt. Rebuilding it would dispatch `viewbeforehide`, on
     * which onViewHideStopPlayback stops the player -- that is exactly how
     * tidying the URL used to end the movie.
     *
     * @param {object} item The now-playing item to canonicalize the route for.
     */
    function canonicalizeVideoRoute(item) {
        if (!window.location.pathname.endsWith('/web/video')
            || !item?.Id
            || !item.ServerId
            || canonicalizingItemId === item.Id) {
            return;
        }

        canonicalizingItemId = item.Id;
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        void canonicalizeLegacyGuidRoute({
            api: toApi(apiClient),
            item,
            kind: 'watch',
            userId: apiClient.getCurrentUserId()
        });
    }

    function bindToPlayer(player) {
        if (player !== currentPlayer) {
            releaseCurrentPlayer();
            currentPlayer = player;
        }
        if (!player) return;
        const state = playbackManager.getPlayerState(player);
        onStateChanged.call(player, {
            type: 'init'
        }, state);
        Events.on(player, 'playbackstart', onPlaybackStart);
        Events.on(player, 'playbackstop', onPlaybackStopped);
        Events.on(player, PlayerEvent.PromptSkip, upNextControl.onPromptSkip);
        Events.on(player, 'volumechange', onVolumeChanged);
        Events.on(player, 'pause', onPlayPauseStateChanged);
        Events.on(player, 'unpause', onPlayPauseStateChanged);
        Events.on(player, 'firstvideoframe', onVideoReady);
        Events.on(player, 'videoready', onVideoReady);
        Events.on(player, 'timeupdate', onTimeUpdate);
        Events.on(player, 'fullscreenchange', onFullscreenChanged);
        Events.on(player, 'mediastreamschange', onMediaStreamsChanged);
        Events.on(player, 'beginFetch', onBeginFetch);
        Events.on(player, 'endFetch', onEndFetch);
        upNextControl.reset();
        osd.resetIdle();

        if (player.isFetching) {
            onBeginFetch();
        }
    }

    function releaseCurrentPlayer() {
        trickplayDiscovery.stop();
        settingsOverlays.destroyStats();
        settingsOverlays.destroySubtitleSync();
        subtitleTrackMenu.closeOverlays();
        episodePlaybackMenu.close();
        upNextControl.reset();
        const player = currentPlayer;

        if (player) {
            Events.off(player, 'playbackstart', onPlaybackStart);
            Events.off(player, 'playbackstop', onPlaybackStopped);
            Events.off(player, PlayerEvent.PromptSkip, upNextControl.onPromptSkip);
            Events.off(player, 'volumechange', onVolumeChanged);
            Events.off(player, 'pause', onPlayPauseStateChanged);
            Events.off(player, 'unpause', onPlayPauseStateChanged);
            Events.off(player, 'firstvideoframe', onVideoReady);
            Events.off(player, 'videoready', onVideoReady);
            Events.off(player, 'timeupdate', onTimeUpdate);
            Events.off(player, 'fullscreenchange', onFullscreenChanged);
            Events.off(player, 'mediastreamschange', onMediaStreamsChanged);
            currentPlayer = null;
        }
    }

    function onTimeUpdate() {
        // Test for 'currentItem' is required for Firefox since its player spams 'timeupdate' events even being at breakpoint
        if (isEnabled && currentItem) {
            const now = currentTimeMs();

            if (now - lastUpdateTime >= 700) {
                lastUpdateTime = now;
                const player = this;
                currentRuntimeTicks = playbackManager.duration(player);
                positionDisplay.setRuntimeTicks(currentRuntimeTicks);
                const currentTime = playbackManager.currentTime(player) * 10000;
                positionDisplay.updateTimeDisplay(currentTime, currentRuntimeTicks, playbackManager.playbackStartTime(player), playbackManager.getPlaybackRate(player), playbackManager.getBufferedRanges(player));
                const item = currentItem;
                refreshProgramInfoIfNeeded(player, item);
                upNextControl.showComingUpNextIfNeeded(player, item, currentTime, currentRuntimeTicks);
            }
        }
    }

    function refreshProgramInfoIfNeeded(player, item) {
        if (item.Type === 'TvChannel') {
            const program = item.CurrentProgram;

            if (program?.EndDate) {
                try {
                    const endDate = datetime.parseISO8601Date(program.EndDate);

                    if (currentTimeMs() >= endDate.getTime()) {
                        console.debug('program info needs to be refreshed');
                        const state = playbackManager.getPlayerState(player);
                        onStateChanged.call(player, {
                            type: 'init'
                        }, state);
                    }
                } catch (e) {
                    console.error('error parsing date: ' + program.EndDate, e);
                }
            }
        }
    }

    function updatePlayerStateInternal(event, player, state) {
        const playState = state.PlayState || {};
        transportControl.updatePlayPauseState(playState.IsPaused);
        const supportedCommands = playbackManager.getSupportedCommands(player);
        volumeControl.update({
            isMuted: playState.IsMuted,
            supportedCommands,
            volumeLevel: playState.VolumeLevel
        });

        if (nowPlayingPositionSlider && !nowPlayingPositionSlider.dragging) {
            nowPlayingPositionSlider.disabled = !playState.CanSeek;
        }

        btnFastForward.disabled = !playState.CanSeek;
        btnRewind.disabled = !playState.CanSeek;
        const nowPlayingItem = state.NowPlayingItem || {};
        positionDisplay.setPlaybackStartTimeTicks(playState.PlaybackStartTimeTicks);
        positionDisplay.updateTimeDisplay(playState.PositionTicks, nowPlayingItem.RunTimeTicks, playState.PlaybackStartTimeTicks, playState.PlaybackRate, playState.BufferedRanges || []);
        updateNowPlayingInfo(player, state);

        const isProgressClear = state.MediaSource && state.MediaSource.RunTimeTicks == null;
        nowPlayingPositionSlider.setIsClear(isProgressClear);

        if (nowPlayingItem.RunTimeTicks) {
            nowPlayingPositionSlider.setKeyboardSteps(userSettings.skipBackLength() * 1000000 / nowPlayingItem.RunTimeTicks,
                userSettings.skipForwardLength() * 1000000 / nowPlayingItem.RunTimeTicks);
        }

        if (supportedCommands.indexOf('ToggleFullscreen') === -1 || player.isLocalPlayer && layoutManager.tv && playbackManager.isFullscreen(player)) {
            view.querySelector('.btnFullscreen').classList.add('hide');
        } else {
            view.querySelector('.btnFullscreen').classList.remove('hide');
        }

        if (supportedCommands.indexOf('PictureInPicture') === -1) {
            view.querySelector('.btnPip').classList.add('hide');
        } else {
            view.querySelector('.btnPip').classList.remove('hide');
        }

        if (supportedCommands.indexOf('AirPlay') === -1) {
            view.querySelector('.btnAirPlay').classList.add('hide');
        } else {
            view.querySelector('.btnAirPlay').classList.remove('hide');
        }

        onFullscreenChanged();
    }

    function onViewHideStopPlayback() {
        if (playbackManager.isPlayingVideo()) {
            shell.disableFullscreen();

            videoInputControl.cancelPendingClick();
            const player = currentPlayer;
            view.removeEventListener('viewbeforehide', onViewHideStopPlayback);
            releaseCurrentPlayer();
            playbackManager.stop(player);
        }
    }

    function enableStopOnBack(enabled) {
        view.removeEventListener('viewbeforehide', onViewHideStopPlayback);

        if (enabled && playbackManager.isPlayingVideo(currentPlayer)) {
            view.addEventListener('viewbeforehide', onViewHideStopPlayback);
        }
    }

    shell.enableFullscreen();

    let currentPlayer;
    let isEnabled;
    let currentItem;
    let canonicalizingItemId;
    const self = this;
    let currentRuntimeTicks = 0;
    let lastUpdateTime = 0;
    let trickplayResolution = null;
    const trickplayDiscovery = new TrickplayDiscovery();
    let isViewSetup = false;
    const nowPlayingPositionSlider = view.querySelector('.osdPositionSlider');
    const btnRewind = view.querySelector('.btnRewind');
    const btnFastForward = view.querySelector('.btnFastForward');
    const headerElement = document.querySelector('.skinHeader');
    const osdBottomElement = view.querySelector('.videoOsdBottom-maincontrols');

    const showVideoToast = message => loadDynamicModule(() => import('../../../components/toast/toast'),
        '../../../components/toast/toast').then(({ default: toast }) => toast(message))
        .catch(error => console.error('[video/index] failed to show toast', error));

    // Collaborators. Most cross-references are lazy closures so construction
    // order does not matter: none of these bodies runs until a real event
    // fires, well after every collaborator below has been assigned.
    const subtitleHotkey = createSubtitleHotkey();

    const osd = createOsdVisibility({
        headerElement,
        osdBottomElement,
        canAutoHide: () => !videoInputControl.isMouseDown() && !getOpenedDialog()
            && !subtitleTrackMenu.hasOpenOverlay()
            && currentPlayer && !playbackManager.paused(currentPlayer),
        toggleSubtitleSync: (action) => settingsOverlays.toggleSubtitleSync(action)
    });

    const settingsOverlays = createSettingsOverlays({
        getPlayer: () => currentPlayer,
        playback: playbackManager,
        resetIdle: () => osd.resetIdle(),
        showToast: (message) => showVideoToast(message)
    });

    const nowPlayingDetails = createNowPlayingDetails({ view });

    const positionDisplay = createPositionDisplay({
        view,
        slider: nowPlayingPositionSlider,
        playback: playbackManager,
        getPlayer: () => currentPlayer,
        getItem: () => currentItem,
        getTrickplayResolution: () => trickplayResolution,
        showOsd: () => osd.showOsd()
    });

    const audioTrackMenu = createAudioTrackMenu({
        getPlayer: () => currentPlayer,
        playback: playbackManager,
        loadActionSheet: () => loadDynamicModule(() => import('../../../components/actionSheet/actionSheet'),
            '../../../components/actionSheet/actionSheet').then(({ default: actionsheet }) => actionsheet),
        resetIdle: () => osd.resetIdle()
    });

    const upNextControl = createUpNextControl({ view, playback: playbackManager, osd });

    const subtitleTrackMenu = new SubtitleTrackMenu({
        button: view.querySelector('.btnSubtitles'),
        getPlayer: () => currentPlayer,
        loadActionSheet: () => loadDynamicModule(() => import('../../../components/actionSheet/actionSheet'),
            '../../../components/actionSheet/actionSheet').then(({ default: actionSheet }) => actionSheet),
        loadSizer: () => loadDynamicModule(() => import('../../../components/subtitlesizer/subtitlesizer'),
            '../../../components/subtitlesizer/subtitlesizer').then(({ default: SubtitleSizer }) => SubtitleSizer),
        playback: playbackManager,
        resetIdle: () => osd.resetIdle(),
        settings: userSettings,
        showToast: showVideoToast,
        translate: globalize.translate,
        toggleSubtitleSync: (action) => settingsOverlays.toggleSubtitleSync(action)
    });

    const videoInputControl = createVideoInputControl({
        view,
        osd,
        playback: playbackManager,
        getPlayer: () => currentPlayer,
        getSubtitleSync: () => settingsOverlays.getSubtitleSync(),
        subtitleTrackMenu,
        subtitleHotkey,
        toggleStats: () => settingsOverlays.toggleStats(),
        osdBottomElement,
        nowPlayingPositionSlider,
        btnRewind,
        btnFastForward
    });

    const volumeControl = new VolumeControl({
        container: view.querySelector('.volumeButtons'), getPlayer: () => currentPlayer,
        hasPhysicalVolumeControl: player => player.isLocalPlayer
            && appHost.supports(AppFeature.PhysicalVolumeControl),
        playback: playbackManager, translate: globalize.translate
    });
    const episodePlaybackMenu = new EpisodePlaybackMenu({
        button: view.querySelector('.btnEpisodes'),
        panel: view.querySelector('.episodePlaybackMenu'),
        canPlay: item => playbackManager.canPlay(item),
        loadEpisodes: item => {
            const apiClient = ServerConnections.getApiClient(item.ServerId);
            return getTvShowsApi(toApi(apiClient)).getEpisodes({
                seriesId: item.SeriesId,
                userId: apiClient.getCurrentUserId(),
                fields: [ ItemFields.Overview ], isMissing: false, enableUserData: true
            }).then(response => response.data.Items || []);
        },
        onClose: () => osd.resetIdle(),
        onOpen: () => osd.stopOsdHideTimer(),
        onOutsideDismiss: () => osd.showOsd(),
        playEpisode: item => playbackManager.play({
            items: [ item ],
            startPositionTicks: item.UserData?.PlaybackPositionTicks || 0,
            fullscreen: true
        }),
        reportError: (translationKey, error) => {
            const status = error?.response?.status || error?.status;
            const rawDetail = error instanceof Error ? error.message : String(error);
            const detail = status && !rawDetail.includes(String(status)) ? `HTTP ${status}: ${rawDetail}` : rawDetail;
            const message = `${globalize.translate(translationKey)} (${detail})`;
            console.error(`[EpisodePlaybackMenu] ${message}`, error);
            showVideoToast(message);
        },
        translate: globalize.translate
    });
    const transportControl = new TransportControl({ playback: playbackManager,
        setElementTitle: dom.setElementTitle, translate: globalize.translate, view });

    positionDisplay.bind();
    videoInputControl.bindViewGestures();

    view.addEventListener('viewbeforeshow', function () {
        headerElement.classList.add('osdHeader');
        setBackdropTransparency(TRANSPARENCY_LEVEL.Full);
    });
    view.addEventListener('viewshow', function () {
        // A hard reload can dispatch viewshow twice while the router falls back
        // from restoring this legacy view to loading it. Setup must be
        // idempotent: playbackManager events do not de-duplicate listeners and
        // currentPlayer stays null until late in async playback startup.
        if (isViewSetup) {
            return;
        }

        isViewSetup = true;
        try {
            Events.on(playbackManager, 'playerchange', onPlayerChange);
            bindToPlayer(playbackManager.getCurrentPlayer());
            permalinkResume.resume();
            videoInputControl.bind();
            osd.showOsd();
        } catch (error) {
            isViewSetup = false;
            console.error('[videoOsd] viewshow handler failed, returning home: ', error);
            setBackdropTransparency(TRANSPARENCY_LEVEL.None); // reset state set in viewbeforeshow
            appRouter.goHome();
        }
    });
    view.addEventListener('viewbeforehide', function () {
        isViewSetup = false;
        settingsOverlays.disableStats();
        videoInputControl.unbind();
        osd.stopOsdHideTimer();
        headerElement.classList.remove('osdHeader');
        headerElement.classList.remove('osdHeader-hidden');
        Events.off(playbackManager, 'playerchange', onPlayerChange);
        releaseCurrentPlayer();
    });
    view.querySelector('.btnFullscreen').addEventListener('click', function () {
        playbackManager.toggleFullscreen(currentPlayer);
    });
    view.querySelector('.btnPip').addEventListener('click', function () {
        playbackManager.togglePictureInPicture(currentPlayer);
    });
    view.querySelector('.btnAirPlay').addEventListener('click', function () {
        playbackManager.toggleAirPlay(currentPlayer);
    });
    view.querySelector('.btnVideoOsdSettings').addEventListener('click', settingsOverlays.onSettingsButtonClick);
    view.addEventListener('viewhide', function () {
        headerElement.classList.remove('hide');
    });
    view.addEventListener('viewdestroy', function () {
        if (self.touchHelper) {
            self.touchHelper.destroy();
            self.touchHelper = null;
        }

        nowPlayingDetails.destroy();
        settingsOverlays.destroyStats();
        settingsOverlays.destroySubtitleSync();
        subtitleTrackMenu.destroy();
        episodePlaybackMenu.destroy();
        volumeControl.destroy();
    });

    view.querySelector('.btnPreviousTrack').addEventListener('click', function () {
        playbackManager.previousTrack(currentPlayer);
    });
    view.querySelector('.btnPreviousChapter').addEventListener('click', function () {
        playbackManager.previousChapter(currentPlayer);
    });
    view.querySelector('.btnPause').addEventListener('click', function () {
        playbackManager.playPause(currentPlayer);
    });
    view.querySelector('.btnNextChapter').addEventListener('click', function () {
        playbackManager.nextChapter(currentPlayer);
    });
    view.querySelector('.btnNextTrack').addEventListener('click', function () {
        playbackManager.nextTrack(currentPlayer);
    });
    btnRewind.addEventListener('click', function () {
        playbackManager.rewind(currentPlayer);
    });
    btnFastForward.addEventListener('click', function () {
        playbackManager.fastForward(currentPlayer);
    });
    view.querySelector('.btnAudio').addEventListener('click', audioTrackMenu.show);

    // HACK: Remove `emby-button` from the rating button to make it look like the other buttons
    view.querySelector('.btnUserRating').classList.remove('emby-button');

    new SyncPlayIconControl({ view, showOsd: osd.showOsd, hideOsd: osd.hideOsd }).bind();
    new PersistentTitleControl({ view }).bind();
}
