// SlopTank modification notice: added or changed by SlopTank on 2026-03-12, 2026-07-19, 2026-07-23, 2026-07-24, 2026-07-25, 2026-09-08, 2026-09-09, 2026-09-15, 2026-09-24.
/**
 * PlaybackManager: the app-wide playback facade and composition root.
 *
 * Every screen talks to the `playbackManager` singleton exported here. The
 * work behind its public API lives in collaborator modules, one per
 * responsibility; this file wires them together and owns the pieces that
 * must stay at the root:
 *  - the imports of infrastructure that sits in the app's existing import
 *    cycle (ServerConnections, alert, appHost, itemHelper, pluginManager,
 *    serverNotifications, the brightness OSD, skip segments and the apps/
 *    playback subscribers). Collaborators receive these through the shared
 *    context instead of importing them, so none of them joins that cycle.
 *  - the shared context every collaborator factory receives, and the
 *    explicit assignment of each collaborator's public members onto the
 *    manager, so the public surface stays one object with the same members.
 *  - the prototype methods below the constructor, unchanged.
 *
 * Collaborators (all in this directory): playerRegistry, playbackState,
 * playbackStreamInfo, playbackMediaSource, playbackItemResolver,
 * playbackStreamController, playbackTrackSelection, playerControls,
 * playbackSession, playbackLauncher, playQueueController, playbackLifecycle,
 * playerEvents, playbackReporting.
 */
import Events from '../../utils/events.ts';
import appSettings from '../../scripts/settings/appSettings';
import itemHelper from '../itemHelper';
import { pluginManager } from '../pluginManager';
import PlayQueueManager from './playqueuemanager';
import * as userSettings from '../../scripts/settings/userSettings';
import globalize from '../../lib/globalize';
import { appHost } from '../apphost';
import alert from '../alert';
import { PluginType } from '../../types/plugin.ts';
import { PlayerEvent } from 'apps/stable/features/playback/constants/playerEvent';
import { bindMediaSegmentManager } from 'apps/stable/features/playback/utils/mediaSegmentManager';
import { bindMediaSessionSubscriber } from 'apps/stable/features/playback/utils/mediaSessionSubscriber';
import { AppFeature } from 'constants/appFeature';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { bindSkipSegment } from './skipsegment.ts';
import { loadDynamicModule } from 'utils/dynamicImport';
import { createPlayerRegistry, enableLocalPlaylistManagement } from './playerRegistry';
import { createPlaybackState } from './playbackState';
import { createPlaybackStreamInfo } from './playbackStreamInfo';
import { createPlaybackMediaSource } from './playbackMediaSource';
import { createPlaybackItemResolver } from './playbackItemResolver';
import { createPlaybackStreamController } from './playbackStreamController';
import { createPlaybackTrackSelection } from './playbackTrackSelection';
import { createPlayerControls } from './playerControls';
import { createPlaybackSession } from './playbackSession';
import { createPlaybackLauncher } from './playbackLauncher';
import { createPlayQueueController } from './playQueueController';
import { createPlaybackLifecycle } from './playbackLifecycle';
import { createPlayerEvents } from './playerEvents';
import { createPlaybackReporting } from './playbackReporting';
import { savePlaybackRate } from './playbackRatePreference';

function normalizeName(t) {
    return t.toLowerCase().replace(' ', '');
}

/**
 * Shows the playback error alert for a translation key.
 * @param {string} errorCode Translation key for the message body.
 * @param {...string} args Substitution values for the key's placeholders.
 */
function showPlaybackInfoErrorMessage(errorCode, ...args) {
    alert({
        text: globalize.translate(errorCode, ...args),
        title: globalize.translate('HeaderPlaybackError')
    });
}

/**
 * The context every collaborator factory receives. Collaborators reach each
 * other only through it, and only at call time, so construction order does
 * not matter and no collaborator imports another.
 * @typedef {object} PlaybackContext
 * @property {PlaybackManager} manager The facade (public API, _currentPlayer,
 *   _playQueueManager, _playNextAfterEnded).
 * @property {object} serverConnections ServerConnections.
 * @property {object} appHost The app host (supports()).
 * @property {object} pluginManager The plugin manager (ofType()).
 * @property {(item: object) => boolean} isLocalItem itemHelper.isLocalItem.
 * @property {(translationKey: string, ...args: string[]) => void} showPlaybackError
 *   Shows the playback error alert.
 * @property {ReturnType<typeof createPlaybackState>} state
 * @property {ReturnType<typeof createPlayerRegistry>} registry
 * @property {ReturnType<typeof createPlaybackStreamInfo>} streamInfo
 * @property {ReturnType<typeof createPlaybackMediaSource>} mediaSource
 * @property {ReturnType<typeof createPlaybackItemResolver>} items
 * @property {ReturnType<typeof createPlaybackStreamController>} streams
 * @property {ReturnType<typeof createPlaybackTrackSelection>} tracks
 * @property {ReturnType<typeof createPlayerControls>} controls
 * @property {ReturnType<typeof createPlaybackSession>} session
 * @property {ReturnType<typeof createPlaybackLauncher>} launcher
 * @property {ReturnType<typeof createPlayQueueController>} queue
 * @property {ReturnType<typeof createPlaybackLifecycle>} lifecycle
 * @property {ReturnType<typeof createPlayerEvents>} events
 * @property {ReturnType<typeof createPlaybackReporting>} reporting
 */

export class PlaybackManager {
    constructor() {
        const self = this;

        this._playNextAfterEnded = true;
        this._playQueueManager = new PlayQueueManager();

        // The singleton below is constructed while this module is still being
        // evaluated inside the app's import cycle, so ServerConnections,
        // appHost, pluginManager and itemHelper may not be initialized yet.
        // Getters read the live import binding at call time, exactly when the
        // pre-split code dereferenced them; capturing the values here would
        // freeze an uninitialized binding into every collaborator.
        /** @type {PlaybackContext} */
        const context = {
            manager: self,
            get serverConnections() {
                return ServerConnections;
            },
            get appHost() {
                return appHost;
            },
            get pluginManager() {
                return pluginManager;
            },
            isLocalItem: (item) => itemHelper.isLocalItem(item),
            showPlaybackError: showPlaybackInfoErrorMessage
        };
        context.state = createPlaybackState(context);
        context.registry = createPlayerRegistry(context);
        context.streamInfo = createPlaybackStreamInfo(context);
        context.mediaSource = createPlaybackMediaSource(context);
        context.items = createPlaybackItemResolver(context);
        context.streams = createPlaybackStreamController(context);
        context.tracks = createPlaybackTrackSelection(context);
        context.controls = createPlayerControls(context);
        context.session = createPlaybackSession(context);
        context.launcher = createPlaybackLauncher(context);
        context.queue = createPlayQueueController(context);
        context.lifecycle = createPlaybackLifecycle(context);
        context.events = createPlayerEvents(context);
        context.reporting = createPlaybackReporting(context);

        const { state, registry, mediaSource, items, streams, tracks, controls, session, queue, reporting } = context;

        self.currentItem = state.currentItem;
        self.currentMediaSource = state.currentMediaSource;
        self.playMethod = state.playMethod;
        self.playSessionId = state.playSessionId;
        self.isPlaying = state.isPlaying;
        self.isPlayingMediaType = state.isPlayingMediaType;
        self.isPlayingLocally = state.isPlayingLocally;
        self.isPlayingVideo = state.isPlayingVideo;
        self.isPlayingAudio = state.isPlayingAudio;
        self.getPlayerState = state.getPlayerState;
        self.duration = state.duration;
        // Only used internally
        self.getCurrentTicks = state.getCurrentTicks;
        self.playbackStartTime = state.playbackStartTime;

        self.getPlayerInfo = registry.getPlayerInfo;
        self.setActivePlayer = registry.setActivePlayer;
        self.trySetActivePlayer = registry.trySetActivePlayer;
        self.getTargets = registry.getTargets;
        self.getPlayers = registry.getPlayers;
        self.canPlay = registry.canPlay;

        self.getPlaybackInfo = mediaSource.getPlaybackInfo;
        self.getPlaybackMediaSources = mediaSource.getPlaybackMediaSources;

        self.translateItemsForPlayback = items.translateItemsForPlayback;
        self.getItemsForPlayback = items.getItemsForPlayback;

        self.getMaxStreamingBitrate = streams.getMaxStreamingBitrate;
        self.enableAutomaticBitrateDetection = streams.enableAutomaticBitrateDetection;
        self.setMaxStreamingBitrate = streams.setMaxStreamingBitrate;
        self.seek = streams.seek;
        self.seekRelative = streams.seekRelative;

        self.playerHasSecondarySubtitleSupport = tracks.playerHasSecondarySubtitleSupport;
        self.trackHasSecondarySubtitleSupport = tracks.trackHasSecondarySubtitleSupport;
        self.secondarySubtitleTracks = tracks.secondarySubtitleTracks;
        self.getSubtitleStream = tracks.getSubtitleStream;
        self.changeAudioStream = tracks.changeAudioStream;
        self.changeSubtitleStream = tracks.changeSubtitleStream;
        self.getAudioStreamIndex = tracks.getAudioStreamIndex;
        self.setAudioStreamIndex = tracks.setAudioStreamIndex;
        self.getSubtitleStreamIndex = tracks.getSubtitleStreamIndex;
        self.getSecondarySubtitleStreamIndex = tracks.getSecondarySubtitleStreamIndex;
        self.setSubtitleStreamIndex = tracks.setSubtitleStreamIndex;
        self.setSecondarySubtitleStreamIndex = tracks.setSecondarySubtitleStreamIndex;
        self.isSubtitleStreamExternal = tracks.isSubtitleStreamExternal;

        self.toggleAspectRatio = controls.toggleAspectRatio;
        self.setAspectRatio = controls.setAspectRatio;
        self.getSupportedAspectRatios = controls.getSupportedAspectRatios;
        self.getAspectRatio = controls.getAspectRatio;
        self.increasePlaybackRate = controls.increasePlaybackRate;
        self.decreasePlaybackRate = controls.decreasePlaybackRate;
        self.getSupportedPlaybackRates = controls.getSupportedPlaybackRates;
        self.setVolume = controls.setVolume;
        self.getVolume = controls.getVolume;
        self.volumeUp = controls.volumeUp;
        self.volumeDown = controls.volumeDown;
        self.isFullscreen = controls.isFullscreen;
        self.toggleFullscreen = controls.toggleFullscreen;
        self.togglePictureInPicture = controls.togglePictureInPicture;
        self.toggleAirPlay = controls.toggleAirPlay;
        self.supportSubtitleOffset = controls.supportSubtitleOffset;
        self.enableShowingSubtitleOffset = controls.enableShowingSubtitleOffset;
        self.disableShowingSubtitleOffset = controls.disableShowingSubtitleOffset;
        self.isShowingSubtitleOffsetEnabled = controls.isShowingSubtitleOffsetEnabled;
        self.setSubtitleOffset = controls.setSubtitleOffset;
        self.getPlayerSubtitleOffset = controls.getPlayerSubtitleOffset;
        self.canHandleOffsetOnCurrentSubtitle = controls.canHandleOffsetOnCurrentSubtitle;

        self.play = session.play;

        self.getPlaylist = queue.getPlaylist;
        self.getItemFromPlaylistItemId = queue.getItemFromPlaylistItemId;
        self.setCurrentPlaylistItem = queue.setCurrentPlaylistItem;
        self.removeFromPlaylist = queue.removeFromPlaylist;
        self.movePlaylistItem = queue.movePlaylistItem;
        self.getCurrentPlaylistIndex = queue.getCurrentPlaylistIndex;
        self.getCurrentPlaylistItemId = queue.getCurrentPlaylistItemId;
        self.channelUp = queue.channelUp;
        self.channelDown = queue.channelDown;
        self.nextTrack = queue.nextTrack;
        self.previousTrack = queue.previousTrack;
        self.queue = queue.queue;
        self.queueNext = queue.queueNext;

        self.onAppClose = reporting.onAppClose;

        self.promptToSkip = function (mediaSegment, player) {
            player = player || self._currentPlayer;

            if (mediaSegment && this._skipSegment) {
                Events.trigger(player, PlayerEvent.PromptSkip, [mediaSegment]);
            }
        };

        let brightnessOsdLoaded;
        self.setBrightness = function (val, player) {
            player = player || self._currentPlayer;

            if (player) {
                if (!brightnessOsdLoaded) {
                    brightnessOsdLoaded = true;
                    // TODO: Have this trigger an event instead to get the osd out of here
                    loadDynamicModule(() => import('./brightnessosd'),
                        './brightnessosd').then();
                }
                player.setBrightness(val);
            }
        };

        self.getBrightness = function (player) {
            player = player || self._currentPlayer;

            if (player) {
                return player.getBrightness();
            }
        };

        Events.on(pluginManager, 'registered', function (e, plugin) {
            if (plugin.type === PluginType.MediaPlayer) {
                context.events.initMediaPlayer(plugin);
            }
        });

        pluginManager.ofType(PluginType.MediaPlayer).forEach(context.events.initMediaPlayer);

        if (appHost.supports(AppFeature.RemoteControl)) {
            loadDynamicModule(() => import('../../scripts/serverNotifications'),
                '../../scripts/serverNotifications').then(({ default: serverNotifications }) => {
                Events.on(serverNotifications, 'ServerShuttingDown', self.setDefaultPlayerActive.bind(self));
                Events.on(serverNotifications, 'ServerRestarting', self.setDefaultPlayerActive.bind(self));
            });
        }

        bindMediaSegmentManager(self);
        this._skipSegment = bindSkipSegment(self);
    }

    getCurrentPlayer() {
        return this._currentPlayer;
    }

    currentTime(player = this._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player) && !player.isLocalPlayer) {
            return player.currentTime();
        }

        return this.getCurrentTicks(player) / 10000;
    }

    getNextItem() {
        return this._playQueueManager.getNextItemInfo();
    }

    nextItem(player = this._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.nextItem();
        }

        const nextItem = this._playQueueManager.getNextItemInfo();

        if (!nextItem?.item) {
            return Promise.reject();
        }

        const apiClient = ServerConnections.getApiClient(nextItem.item.ServerId);
        return apiClient.getItem(apiClient.getCurrentUserId(), nextItem.item.Id);
    }

    canQueue(item) {
        if (item.Type === 'MusicAlbum' || item.Type === 'MusicArtist' || item.Type === 'MusicGenre') {
            return this.canQueueMediaType('Audio');
        }
        return this.canQueueMediaType(item.MediaType);
    }

    canQueueMediaType(mediaType) {
        if (this._currentPlayer) {
            return this._currentPlayer.canPlayMediaType(mediaType);
        }

        return false;
    }

    isMuted(player = this._currentPlayer) {
        if (player) {
            return player.isMuted();
        }

        return false;
    }

    setMute(mute, player = this._currentPlayer) {
        if (player) {
            player.setMute(mute);
        }
    }

    toggleMute(mute, player = this._currentPlayer) {
        if (player) {
            if (player.toggleMute) {
                player.toggleMute();
            } else {
                player.setMute(!player.isMuted());
            }
        }
    }

    toggleDisplayMirroring() {
        this.enableDisplayMirroring(!this.enableDisplayMirroring());
    }

    enableDisplayMirroring(enabled) {
        if (enabled != null) {
            const val = enabled ? '1' : '0';
            appSettings.set('displaymirror', val);
            return;
        }

        return (appSettings.get('displaymirror') || '') !== '0';
    }

    nextChapter(player = this._currentPlayer) {
        const item = this.currentItem(player);

        const ticks = this.getCurrentTicks(player);

        const nextChapter = (item.Chapters || []).filter(function (i) {
            return i.StartPositionTicks > ticks;
        })[0];

        if (nextChapter) {
            this.seek(nextChapter.StartPositionTicks, player);
        } else {
            this.nextTrack(player);
        }
    }

    previousChapter(player = this._currentPlayer) {
        const item = this.currentItem(player);

        let ticks = this.getCurrentTicks(player);

        // Go back 10 seconds
        ticks -= 100000000;

        // If there's no previous track, then at least rewind to beginning
        if (this.getCurrentPlaylistIndex(player) === 0) {
            ticks = Math.max(ticks, 0);
        }

        const previousChapters = (item.Chapters || []).filter(function (i) {
            return i.StartPositionTicks <= ticks;
        });

        if (previousChapters.length) {
            this.seek(previousChapters[previousChapters.length - 1].StartPositionTicks, player);
        } else {
            this.previousTrack(player);
        }
    }

    fastForward(player = this._currentPlayer) {
        if (player.fastForward != null) {
            player.fastForward(userSettings.skipForwardLength());
            return;
        }

        // Go back 15 seconds
        const offsetTicks = userSettings.skipForwardLength() * 10000;

        this.seekRelative(offsetTicks, player);
    }

    rewind(player = this._currentPlayer) {
        if (player.rewind != null) {
            player.rewind(userSettings.skipBackLength());
            return;
        }

        // Go back 15 seconds
        const offsetTicks = 0 - (userSettings.skipBackLength() * 10000);

        this.seekRelative(offsetTicks, player);
    }

    seekPercent(percent, player = this._currentPlayer) {
        let ticks = this.duration(player) || 0;

        percent /= 100;
        ticks *= percent;
        this.seek(parseInt(ticks, 10), player);
    }

    seekMs(ms, player = this._currentPlayer) {
        const ticks = ms * 10000;
        this.seek(ticks, player);
    }

    async playTrailers(item) {
        const player = this._currentPlayer;

        if (player?.playTrailers) {
            return player.playTrailers(item);
        }

        const apiClient = ServerConnections.getApiClient(item.ServerId);

        let items;

        if (item.LocalTrailerCount) {
            items = await apiClient.getLocalTrailers(apiClient.getCurrentUserId(), item.Id);
        }

        if (!items?.length) {
            items = (item.RemoteTrailers || []).map((t) => {
                return {
                    Name: t.Name || (item.Name + ' Trailer'),
                    Url: t.Url,
                    MediaType: 'Video',
                    Type: 'Trailer',
                    ServerId: apiClient.serverId()
                };
            });
        }

        if (items.length) {
            return this.play({
                items
            });
        }

        return Promise.reject();
    }

    getSubtitleUrl(textStream, serverId) {
        const apiClient = ServerConnections.getApiClient(serverId);

        return !textStream.IsExternalUrl ? apiClient.getUrl(textStream.DeliveryUrl) : textStream.DeliveryUrl;
    }

    stop(player) {
        player = player || this._currentPlayer;
        if (player) {
            if (enableLocalPlaylistManagement(player)) {
                this._playNextAfterEnded = false;
            }

            // TODO: remove second param
            return player.stop(true, true);
        }

        return Promise.resolve();
    }

    getBufferedRanges(player = this._currentPlayer) {
        if (player?.getBufferedRanges) {
            return player.getBufferedRanges();
        }

        return [];
    }

    playPause(player = this._currentPlayer) {
        if (player) {
            if (player.playPause) {
                return player.playPause();
            }

            if (player.paused()) {
                return this.unpause(player);
            } else {
                return this.pause(player);
            }
        }
    }

    paused(player = this._currentPlayer) {
        if (player) {
            return player.paused();
        }
    }

    pause(player = this._currentPlayer) {
        if (player) {
            player.pause();
        }
    }

    unpause(player = this._currentPlayer) {
        if (player) {
            player.unpause();
        }
    }

    setPlaybackRate(value, player = this._currentPlayer) {
        if (player?.setPlaybackRate) {
            player.setPlaybackRate(value);

            // Save the new playback rate in the browser session, to restore when playing a new video.
            savePlaybackRate(value);
        }
    }

    getPlaybackRate(player = this._currentPlayer) {
        if (player?.getPlaybackRate) {
            return player.getPlaybackRate();
        }

        return null;
    }

    instantMix(item, player = this._currentPlayer) {
        if (player?.instantMix) {
            return player.instantMix(item);
        }

        const apiClient = ServerConnections.getApiClient(item.ServerId);

        const options = {
            UserId: apiClient.getCurrentUserId(),
            Limit: 200
        };

        const instance = this;

        apiClient.getInstantMixFromItem(item.Id, options).then(function (result) {
            instance.play({
                items: result.Items
            });
        });
    }

    shuffle(shuffleItem, player = this._currentPlayer) {
        if (player?.shuffle) {
            return player.shuffle(shuffleItem);
        }

        return this.play({ items: [shuffleItem], shuffle: true });
    }

    audioTracks(player = this._currentPlayer) {
        if (player.audioTracks) {
            const result = player.audioTracks();
            if (result) {
                return result.sort(itemHelper.sortTracks);
            }
        }

        const mediaSource = this.currentMediaSource(player);

        const mediaStreams = mediaSource?.MediaStreams || [];
        return mediaStreams.filter(function (s) {
            return s.Type === 'Audio';
        }).sort(itemHelper.sortTracks);
    }

    subtitleTracks(player = this._currentPlayer) {
        if (player.subtitleTracks) {
            const result = player.subtitleTracks();
            if (result) {
                return result.sort(itemHelper.sortTracks);
            }
        }

        const mediaSource = this.currentMediaSource(player);

        const mediaStreams = mediaSource?.MediaStreams || [];
        return mediaStreams.filter(function (s) {
            return s.Type === 'Subtitle';
        }).sort(itemHelper.sortTracks);
    }

    getSupportedCommands(player) {
        player = player || this._currentPlayer || { isLocalPlayer: true };

        if (player.isLocalPlayer) {
            const list = [
                'GoHome',
                'GoToSettings',
                'VolumeUp',
                'VolumeDown',
                'Mute',
                'Unmute',
                'ToggleMute',
                'SetVolume',
                'SetAudioStreamIndex',
                'SetSubtitleStreamIndex',
                'SetMaxStreamingBitrate',
                'DisplayContent',
                'GoToSearch',
                'DisplayMessage',
                'SetRepeatMode',
                'SetShuffleQueue',
                'PlayMediaSource',
                'PlayTrailers'
            ];

            if (appHost.supports(AppFeature.Fullscreen)) {
                list.push('ToggleFullscreen');
            }

            if (player.supports) {
                if (player.supports('PictureInPicture')) {
                    list.push('PictureInPicture');
                }
                if (player.supports('AirPlay')) {
                    list.push('AirPlay');
                }
                if (player.supports('SetBrightness')) {
                    list.push('SetBrightness');
                }
                if (player.supports('SetAspectRatio')) {
                    list.push('SetAspectRatio');
                }
                if (player.supports('PlaybackRate')) {
                    list.push('PlaybackRate');
                }
            }

            return list;
        }

        const info = this.getPlayerInfo();
        return info ? info.supportedCommands : [];
    }

    setRepeatMode(value, player = this._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.setRepeatMode(value);
        }

        this._playQueueManager.setRepeatMode(value);
        Events.trigger(player, 'repeatmodechange');
    }

    getRepeatMode(player = this._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.getRepeatMode();
        }

        return this._playQueueManager.getRepeatMode();
    }

    setQueueShuffleMode(value, player = this._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.setQueueShuffleMode(value);
        }

        this._playQueueManager.setShuffleMode(value);
        Events.trigger(player, 'shufflequeuemodechange');
    }

    getQueueShuffleMode(player = this._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.getQueueShuffleMode();
        }

        return this._playQueueManager.getShuffleMode();
    }

    toggleQueueShuffleMode(player = this._currentPlayer) {
        let currentvalue;
        if (player && !enableLocalPlaylistManagement(player)) {
            currentvalue = player.getQueueShuffleMode();
            switch (currentvalue) {
                case 'Shuffle':
                    player.setQueueShuffleMode('Sorted');
                    break;
                case 'Sorted':
                    player.setQueueShuffleMode('Shuffle');
                    break;
                default:
                    throw new TypeError('current value for shufflequeue is invalid');
            }
        } else {
            this._playQueueManager.toggleShuffleMode();
        }
        Events.trigger(player, 'shufflequeuemodechange');
    }

    clearQueue(clearCurrentItem = false, player = this._currentPlayer) {
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.clearQueue(clearCurrentItem);
        }

        this._playQueueManager.clearPlaylist(clearCurrentItem);
        Events.trigger(player, 'playlistitemremove');
    }

    trySetActiveDeviceName(name) {
        name = normalizeName(name);

        const instance = this;
        instance.getTargets().then(function (result) {
            const target = result.filter(function (p) {
                return normalizeName(p.name) === name;
            })[0];

            if (target) {
                instance.trySetActivePlayer(target.playerName, target);
            }
        });
    }

    displayContent(options, player = this._currentPlayer) {
        if (player?.displayContent) {
            player.displayContent(options);
        }
    }

    beginPlayerUpdates(player) {
        if (player.beginPlayerUpdates) {
            player.beginPlayerUpdates();
        }
    }

    endPlayerUpdates(player) {
        if (player.endPlayerUpdates) {
            player.endPlayerUpdates();
        }
    }

    setDefaultPlayerActive() {
        this.setActivePlayer('localplayer');
    }

    removeActivePlayer(name) {
        const playerInfo = this.getPlayerInfo();
        if (playerInfo?.name === name) {
            this.setDefaultPlayerActive();
        }
    }

    removeActiveTarget(id) {
        const playerInfo = this.getPlayerInfo();
        if (playerInfo?.id === id) {
            this.setDefaultPlayerActive();
        }
    }

    sendCommand(cmd, player) {
        console.debug('MediaController received command: ' + cmd.Name);
        switch (cmd.Name) {
            case 'SetRepeatMode':
                this.setRepeatMode(cmd.Arguments.RepeatMode, player);
                break;
            case 'SetShuffleQueue':
                this.setQueueShuffleMode(cmd.Arguments.ShuffleMode, player);
                break;
            case 'VolumeUp':
                this.volumeUp(player);
                break;
            case 'VolumeDown':
                this.volumeDown(player);
                break;
            case 'Mute':
                this.setMute(true, player);
                break;
            case 'Unmute':
                this.setMute(false, player);
                break;
            case 'ToggleMute':
                this.toggleMute(player);
                break;
            case 'SetVolume':
                this.setVolume(cmd.Arguments.Volume, player);
                break;
            case 'SetAspectRatio':
                this.setAspectRatio(cmd.Arguments.AspectRatio, player);
                break;
            case 'PlaybackRate':
                this.setPlaybackRate(cmd.Arguments.PlaybackRate, player);
                break;
            case 'SetBrightness':
                this.setBrightness(cmd.Arguments.Brightness, player);
                break;
            case 'SetAudioStreamIndex':
                this.setAudioStreamIndex(parseInt(cmd.Arguments.Index, 10), player);
                break;
            case 'SetSubtitleStreamIndex':
                this.setSubtitleStreamIndex(parseInt(cmd.Arguments.Index, 10), player);
                break;
            case 'SetMaxStreamingBitrate':
                this.setMaxStreamingBitrate(parseInt(cmd.Arguments.Bitrate, 10), player);
                break;
            case 'ToggleFullscreen':
                this.toggleFullscreen(player);
                break;
            default:
                if (player.sendCommand) {
                    player.sendCommand(cmd);
                }
                break;
        }
    }
}

export const playbackManager = new PlaybackManager();
bindMediaSegmentManager(playbackManager);
bindMediaSessionSubscriber(playbackManager);

window.addEventListener('beforeunload', function () {
    try {
        playbackManager.onAppClose();
    } catch (err) {
        console.error('error in onAppClose: ' + err);
    }
});
