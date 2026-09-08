import appSettings from '../../scripts/settings/appSettings';
import * as userSettings from '../../scripts/settings/userSettings';
import { playbackManager } from '../../components/playback/playbackmanager';
import globalize from '../../lib/globalize';
import CastSenderApi from './castSenderApi';
import CastTransport from './castTransport';
import alert from '../../components/alert';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import { getItems } from '../../utils/jellyfin-apiclient/getItems.ts';
import { getTextSizeMultiplier } from '../../components/subtitlesettings/subtitleappearancehelper';

const PlayerName = 'Google Cast';

/*
 * Some async CastSDK function are completed with callbacks.
 * sendConnectionResult turns this into completion as a promise.
 */
let _currentResolve = null;
let _currentReject = null;
function sendConnectionResult(isOk) {
    const resolve = _currentResolve;
    const reject = _currentReject;

    _currentResolve = null;
    _currentReject = null;

    if (isOk) {
        if (resolve) {
            resolve();
        }
    } else if (reject) {
        reject();
    } else {
        playbackManager.removeActivePlayer(PlayerName);
    }
}

const messageNamespace = 'urn:x-cast:com.connectsdk';

class SlopTankCastBridge {
    constructor() {
        this.transport = new CastTransport({
            namespace: messageNamespace,
            getApplicationId: this.getApplicationId.bind(this),
            onSession: this.onSessionConnected.bind(this),
            onSessionEnded: this.onSessionEnded.bind(this),
            onReceiverAvailability: this.onReceiverAvailability.bind(this),
            onMessage: this.onMessage.bind(this),
            onMedia: () => {},
            onError: this.onError.bind(this)
        });
        this.ensureInitialized();
    }

    getApplicationId() {
        const apiClient = ServerConnections.currentApiClient();
        const userId = apiClient.getCurrentUserId();
        return apiClient.getUser(userId).then(user => user.Configuration.CastReceiverId);
    }

    get isInitialized() {
        return this.transport.isInitialized;
    }

    get isConnected() {
        return this.transport.isConnected;
    }

    get hasReceivers() {
        return this.transport.hasReceivers;
    }

    get session() {
        return this.transport.session;
    }

    ensureInitialized() {
        return this.transport.start().then(() => {
            console.debug('[chromecastPlayer] init success');
        }).catch(error => {
            console.warn('[chromecastPlayer] initialization failed:', error.message);
        });
    }

    onError(error) {
        console.debug('[chromecastPlayer] error:', error);
    }

    onMessage(namespace, message) {
        if (typeof (message) === 'string') {
            try {
                message = JSON.parse(message);
            } catch {
                console.warn('[chromecastPlayer] receiver sent invalid JSON');
                return;
            }
        }

        if (message.type === 'playbackerror') {
            const errorCode = message.data;
            setTimeout(function () {
                alertText(globalize.translate('MessagePlaybackError' + errorCode), globalize.translate('HeaderPlaybackError'));
            }, 300);
        } else if (message.type === 'connectionerror') {
            setTimeout(function () {
                alertText(globalize.translate('MessageChromecastConnectionError'), globalize.translate('HeaderError'));
            }, 300);
        } else if (message.type) {
            Events.trigger(this, message.type, [message.data]);
        }
    }

    onReceiverAvailability(isAvailable) {
        if (isAvailable) {
            console.debug('[chromecastPlayer] receiver found');
        } else {
            console.debug('[chromecastPlayer] receiver list empty');
        }
    }

    onSessionEnded() {
        document.removeEventListener('volumeupbutton', onVolumeUpKeyDown, false);
        document.removeEventListener('volumedownbutton', onVolumeDownKeyDown, false);
        console.debug('[chromecastPlayer] session ended');
        sendConnectionResult(false);
    }

    launchApp() {
        console.debug('[chromecastPlayer] launching app...');
        this.transport.requestConnection().catch(error => {
            console.debug('[chromecastPlayer] launch error:', error);
            sendConnectionResult(false);
        });
    }

    onSessionConnected(session) {
        document.addEventListener('volumeupbutton', onVolumeUpKeyDown, false);
        document.addEventListener('volumedownbutton', onVolumeDownKeyDown, false);
        console.debug('[chromecastPlayer] session connected: ' + session.sessionId);
        Events.trigger(this, 'connect');
        this.sendMessage({
            options: {},
            command: 'Identify'
        });
    }

    stopApp() {
        this.transport.stop().catch(this.onError.bind(this));
    }

    /**
     * Loads media into a running receiver application
     * @param {Number} mediaIndex - An index number to indicate current media content
     * @returns Promise
     */
    loadMedia(options, command) {
        if (!this.session) {
            console.debug('[chromecastPlayer] no session');
            return Promise.reject(new Error('no session'));
        }

        // convert items to smaller stubs to send minimal amount of information
        options.items = options.items.map(function (i) {
            return {
                Id: i.Id,
                ServerId: i.ServerId,
                Name: i.Name,
                Type: i.Type,
                MediaType: i.MediaType,
                IsFolder: i.IsFolder
            };
        });

        return this.sendMessage({
            options: options,
            command: command
        });
    }

    sendMessage(message) {
        let receiverName = null;

        const session = this.session;

        if (session?.receiver?.friendlyName) {
            receiverName = session.receiver.friendlyName;
        }

        let apiClient;
        if (message.options?.ServerId) {
            apiClient = ServerConnections.getApiClient(message.options.ServerId);
        } else if (message.options?.items?.length) {
            apiClient = ServerConnections.getApiClient(message.options.items[0].ServerId);
        } else {
            apiClient = ServerConnections.currentApiClient();
        }

        /* If serverAddress is localhost,this address can not be used for the cast receiver device.
         * Use the local address (ULA, Unique Local Address) in that case.
	 */
        const serverAddress = apiClient.serverAddress();
        // eslint-disable-next-line compat/compat
        const hostname = (new URL(serverAddress)).hostname;
        const isLocalhost = hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]';
        const serverLocalAddress = isLocalhost ? apiClient.serverInfo().LocalAddress : serverAddress;

        message = Object.assign(message, {
            userId: apiClient.getCurrentUserId(),
            deviceId: apiClient.deviceId(),
            accessToken: apiClient.accessToken(),
            serverAddress: serverLocalAddress,
            serverId: apiClient.serverId(),
            serverVersion: apiClient.serverVersion(),
            receiverName: receiverName
        });

        console.debug('[chromecastPlayer] message{' + message.command + '; ' + serverAddress + ' -> ' + serverLocalAddress + '}');

        const bitrateSetting = appSettings.maxChromecastBitrate();
        if (bitrateSetting) {
            message.maxBitrate = bitrateSetting;
        }

        if (message.options?.items) {
            // The receiver only understands the legacy named textSize
            // presets; translate the locally persisted numeric multiplier to
            // the nearest preset at this wire boundary (derived at send time,
            // never stored, so there is no second source of truth).
            const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            message.subtitleAppearance = {
                ...subtitleAppearance,
                textSize: getNearestLegacyTextSize(subtitleAppearance.textSize)
            };
            message.subtitleBurnIn = appSettings.get('subtitleburnin') || '';
        }

        return this.sendMessageInternal(message);
    }

    sendMessageInternal(message) {
        return this.transport.send(messageNamespace, message).then(() => {
            console.debug('[chromecastPlayer] message sent');
        });
    }
}

function alertText(text, title) {
    alert({
        text,
        title
    });
}

function onVolumeUpKeyDown() {
    playbackManager.volumeUp();
}

function onVolumeDownKeyDown() {
    playbackManager.volumeDown();
}

function normalizeImages(state) {
    if (state?.NowPlayingItem) {
        const item = state.NowPlayingItem;

        if ((!item.ImageTags?.Primary) && item.PrimaryImageTag) {
            item.ImageTags = item.ImageTags || {};
            item.ImageTags.Primary = item.PrimaryImageTag;
        }
        if (item.BackdropImageTag && item.BackdropItemId === item.Id) {
            item.BackdropImageTags = [item.BackdropImageTag];
        }
        if (item.BackdropImageTag && item.BackdropItemId !== item.Id) {
            item.ParentBackdropImageTags = [item.BackdropImageTag];
            item.ParentBackdropItemId = item.BackdropItemId;
        }
    }
}

function getItemsForPlayback(apiClient, query) {
    const userId = apiClient.getCurrentUserId();

    if (query.Ids && query.Ids.split(',').length === 1) {
        return apiClient.getItem(userId, query.Ids.split(',')).then(function (item) {
            return {
                Items: [item],
                TotalRecordCount: 1
            };
        });
    } else {
        query.Limit = query.Limit || 100;
        query.ExcludeLocationTypes = 'Virtual';
        query.EnableTotalRecordCount = false;

        return getItems(apiClient, userId, query);
    }
}

/*
 * relay castPlayer events to ChromecastPlayer events and include state info
 */
function bindEventForRelay(instance, eventName) {
    Events.on(instance._castPlayer, eventName, function (e, data) {
        console.debug('[chromecastPlayer] ' + eventName);
        // skip events without data
        if (data?.ItemId) {
            const state = instance.getPlayerStateInternal(data);
            Events.trigger(instance, eventName, [state]);
        }
    });
}

function initializeChromecast() {
    const instance = this;
    instance._castPlayer = new SlopTankCastBridge();

    // To allow the native android app to override
    document.dispatchEvent(new CustomEvent('chromecastloaded', {
        detail: {
            player: instance
        }
    }));

    Events.on(instance._castPlayer, 'connect', function () {
        if (_currentResolve) {
            sendConnectionResult(true);
        } else {
            playbackManager.setActivePlayer(PlayerName, instance.getCurrentTargetInfo());
        }

        console.debug('[chromecastPlayer] connect');
        // Reset this so that statechange will fire
        instance.lastPlayerData = null;
    });

    Events.on(instance._castPlayer, 'playbackstart', function (e, data) {
        console.debug('[chromecastPlayer] playbackstart');

        instance._castPlayer.ensureInitialized();

        const state = instance.getPlayerStateInternal(data);
        Events.trigger(instance, 'playbackstart', [state]);

        // be prepared that after this media item a next one may follow. See playbackManager
        instance._playNextAfterEnded = true;
    });

    Events.on(instance._castPlayer, 'playbackstop', function (e, data) {
        console.debug('[chromecastPlayer] playbackstop');

        let state = instance.getPlayerStateInternal(data);

        if (!instance._playNextAfterEnded) {
            // mark that no next media items are to be processed.
            state.nextItem = null;
            state.NextMediaType = null;
        }
        Events.trigger(instance, 'playbackstop', [state]);

        state = instance.lastPlayerData.PlayState || {};
        const volume = state.VolumeLevel || 0.5;
        const mute = state.IsMuted || false;

        // Reset this so the next query doesn't make it appear like content is playing.
        instance.lastPlayerData = {
            PlayState: {
                VolumeLevel: volume,
                IsMuted: mute
            }
        };
    });

    Events.on(instance._castPlayer, 'playbackprogress', function (e, data) {
        console.debug('[chromecastPlayer] positionchange');
        const state = instance.getPlayerStateInternal(data);

        Events.trigger(instance, 'timeupdate', [state]);
    });

    bindEventForRelay(instance, 'timeupdate');
    bindEventForRelay(instance, 'pause');
    bindEventForRelay(instance, 'unpause');
    bindEventForRelay(instance, 'volumechange');
    bindEventForRelay(instance, 'repeatmodechange');
    bindEventForRelay(instance, 'shufflequeuemodechange');

    Events.on(instance._castPlayer, 'playstatechange', function (e, data) {
        console.debug('[chromecastPlayer] playstatechange');

        // Updates the player and nowPlayingBar state to the current 'pause' state.
        const state = instance.getPlayerStateInternal(data);
        Events.trigger(instance, 'pause', [state]);
    });
}

/**
 * Map any persisted textSize value (numeric multiplier or legacy preset) to
 * the nearest legacy preset name the cast receiver understands.
 * @param {string|number} textSize - Persisted subtitle text-size value.
 * @returns {string} Legacy preset name ('' means 100%).
 */
function getNearestLegacyTextSize(textSize) {
    const multiplier = getTextSizeMultiplier(textSize);
    const presets = [
        { name: 'smaller', multiplier: 0.75 },
        { name: '', multiplier: 1 },
        { name: 'large', multiplier: 1.25 },
        { name: 'larger', multiplier: 1.5 },
        { name: 'extralarge', multiplier: 2 }
    ];
    let nearest = presets[0];
    for (const preset of presets) {
        if (Math.abs(preset.multiplier - multiplier) < Math.abs(nearest.multiplier - multiplier)) {
            nearest = preset;
        }
    }
    return nearest.name;
}

class ChromecastPlayer {
    constructor() {
        // playbackManager needs this
        this.name = PlayerName;
        this.type = PluginType.MediaPlayer;
        this.id = 'chromecast';
        this.isLocalPlayer = false;
        // Subtitle appearance is transmitted with each play message (see
        // getNearestLegacyTextSize above); the in-player size menu keys its
        // preset fallback off this flag.
        this.supportsSubtitleAppearanceSettings = true;
        this.lastPlayerData = {};

        new CastSenderApi().load().then(() => {
            Events.on(ServerConnections, 'localusersignedin', () => {
                initializeChromecast.call(this);
            });

            if (ServerConnections.currentUserId) {
                initializeChromecast.call(this);
            }
        }).catch(err => {
            // Without this the SDK failure was invisible: the plugin stayed
            // loaded, getTargets() kept returning [], and nothing was logged.
            console.warn('[chromecastPlayer] Cast SDK unavailable, casting disabled:', err.message);
        });
    }

    /*
     * Cast button handling: select and connect to chromecast receiver
     */
    tryPair() {
        const castPlayer = this._castPlayer;

        if (!castPlayer.isConnected && castPlayer.isInitialized) {
            return new Promise(function (resolve, reject) {
                _currentResolve = resolve;
                _currentReject = reject;
                castPlayer.launchApp();
            });
        } else {
            _currentResolve = null;
            _currentReject = null;
            return Promise.reject(new Error('tryPair failed'));
        }
    }

    getTargets() {
        const targets = [];

        if (this._castPlayer?.hasReceivers) {
            targets.push(this.getCurrentTargetInfo());
        }

        return Promise.resolve(targets);
    }

    // This is a privately used method
    getCurrentTargetInfo() {
        let appName = null;

        const castPlayer = this._castPlayer;

        if (castPlayer.session?.receiver?.friendlyName) {
            appName = castPlayer.session.receiver.friendlyName;
        }

        return {
            name: PlayerName,
            id: PlayerName,
            playerName: PlayerName,
            playableMediaTypes: ['Audio', 'Video'],
            isLocalPlayer: false,
            appName: PlayerName,
            deviceName: appName,
            deviceType: 'cast',
            supportedCommands: [
                'VolumeUp',
                'VolumeDown',
                'Mute',
                'Unmute',
                'ToggleMute',
                'SetVolume',
                'SetAudioStreamIndex',
                'SetSubtitleStreamIndex',
                'DisplayContent',
                'SetRepeatMode'
            ]
        };
    }

    getPlayerStateInternal(data) {
        let triggerStateChange = false;
        if (data && !this.lastPlayerData) {
            triggerStateChange = true;
        }

        data = data || this.lastPlayerData;
        this.lastPlayerData = data;

        normalizeImages(data);

        if (triggerStateChange) {
            Events.trigger(this, 'statechange', [data]);
        }

        return data;
    }

    playWithCommand(options, command) {
        if (!options.items) {
            const apiClient = ServerConnections.getApiClient(options.serverId);
            const instance = this;

            return apiClient.getItem(apiClient.getCurrentUserId(), options.ids[0]).then(function (item) {
                options.items = [item];
                return instance.playWithCommand(options, command);
            });
        }

        if (options.items.length > 1 && options?.ids) {
            // Use the original request id array for sorting the result in the proper order
            options.items.sort(function (a, b) {
                return options.ids.indexOf(a.Id) - options.ids.indexOf(b.Id);
            });
        }

        return this._castPlayer.loadMedia(options, command);
    }

    seek(position) {
        position = parseInt(position, 10);

        position = position / 10000000;

        this._castPlayer.sendMessage({
            options: {
                position: position
            },
            command: 'Seek'
        });
    }

    setAudioStreamIndex(index) {
        this._castPlayer.sendMessage({
            options: {
                index: index
            },
            command: 'SetAudioStreamIndex'
        });
    }

    setSubtitleStreamIndex(index) {
        this._castPlayer.sendMessage({
            options: {
                index: index
            },
            command: 'SetSubtitleStreamIndex'
        });
    }

    setMaxStreamingBitrate(options) {
        this._castPlayer.sendMessage({
            options: options,
            command: 'SetMaxStreamingBitrate'
        });
    }

    isFullscreen() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.IsFullscreen;
    }

    nextTrack() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'NextTrack'
        });
    }

    previousTrack() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'PreviousTrack'
        });
    }

    volumeDown() {
        let vol = this._castPlayer.session.receiver.volume.level;
        if (vol == null) {
            vol = 0.5;
        }
        vol -= 0.05;
        vol = Math.max(vol, 0);

        this._castPlayer.session.setReceiverVolumeLevel(vol);
    }

    endSession() {
        const instance = this;

        this.stop().then(function () {
            setTimeout(function () {
                instance._castPlayer.stopApp();
            }, 1000);
        });
    }

    volumeUp() {
        let vol = this._castPlayer.session.receiver.volume.level;
        if (vol == null) {
            vol = 0.5;
        }
        vol += 0.05;
        vol = Math.min(vol, 1);

        this._castPlayer.session.setReceiverVolumeLevel(vol);
    }

    setVolume(vol) {
        vol = Math.min(vol, 100);
        vol = Math.max(vol, 0);
        vol = vol / 100;

        this._castPlayer.session.setReceiverVolumeLevel(vol);
    }

    unpause() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'Unpause'
        });
    }

    playPause() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'PlayPause'
        });
    }

    pause() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'Pause'
        });
    }

    stop() {
        // suppress playing a next media item after this one. See playbackManager
        this._playNextAfterEnded = false;
        return this._castPlayer.sendMessage({
            options: {},
            command: 'Stop'
        });
    }

    displayContent(options) {
        this._castPlayer.sendMessage({
            options: options,
            command: 'DisplayContent'
        });
    }

    setMute(isMuted) {
        const castPlayer = this._castPlayer;

        if (isMuted) {
            castPlayer.sendMessage({
                options: {},
                command: 'Mute'
            });
        } else {
            castPlayer.sendMessage({
                options: {},
                command: 'Unmute'
            });
        }
    }

    getRepeatMode() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.RepeatMode;
    }

    getQueueShuffleMode() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.ShuffleMode;
    }

    playTrailers() {
        console.warn('[chromecastPlayer] Playing trailers is not supported.');
    }

    setRepeatMode(mode) {
        this._castPlayer.sendMessage({
            options: {
                RepeatMode: mode
            },
            command: 'SetRepeatMode'
        });
    }

    setQueueShuffleMode() {
        console.warn('[chromecastPlayer] Setting shuffle queue mode is not supported.');
    }

    toggleMute() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'ToggleMute'
        });
    }

    audioTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Audio';
        });
    }

    getAudioStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.AudioStreamIndex;
    }

    subtitleTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Subtitle';
        });
    }

    getSubtitleStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.SubtitleStreamIndex;
    }

    getMaxStreamingBitrate() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.MaxStreamingBitrate;
    }

    getVolume() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};

        return state.VolumeLevel == null ? 100 : state.VolumeLevel;
    }

    isPlaying(mediaType) {
        const state = this.lastPlayerData || {};
        return state.NowPlayingItem != null && (state.NowPlayingItem.MediaType === mediaType || !mediaType);
    }

    isPlayingVideo() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Video';
    }

    isPlayingAudio() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Audio';
    }

    currentTime(val) {
        if (val != null) {
            return this.seek(val * 10000);
        }

        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.PositionTicks / 10000;
    }

    duration() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.RunTimeTicks;
    }

    getBufferedRanges() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.BufferedRanges || [];
    }

    paused() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};

        return state.IsPaused;
    }

    isMuted() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};

        return state.IsMuted;
    }

    shuffle(item) {
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        const userId = apiClient.getCurrentUserId();

        const instance = this;

        apiClient.getItem(userId, item.Id).then(function (fetchedItem) {
            instance.playWithCommand({
                items: [fetchedItem]
            }, 'Shuffle');
        });
    }

    instantMix(item) {
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        const userId = apiClient.getCurrentUserId();

        const instance = this;

        apiClient.getItem(userId, item.Id).then(function (fetchedItem) {
            instance.playWithCommand({
                items: [fetchedItem]
            }, 'InstantMix');
        });
    }

    canPlayMediaType(mediaType) {
        mediaType = (mediaType || '').toLowerCase();
        return mediaType === 'audio' || mediaType === 'video';
    }

    canQueueMediaType(mediaType) {
        return this.canPlayMediaType(mediaType);
    }

    queue(options) {
        this.playWithCommand(options, 'PlayLast');
    }

    queueNext(options) {
        this.playWithCommand(options, 'PlayNext');
    }

    /*
     * play
     * options.items[]: Id, IsFolder, MediaType, Name, ServerId, Type, ...
     */
    play(options) {
        if (options.items) {
            return this.playWithCommand(options, 'PlayNow');
        } else {
            if (!options.serverId) {
                throw new Error('serverId required!');
            }

            const instance = this;
            const apiClient = ServerConnections.getApiClient(options.serverId);

            return getItemsForPlayback(apiClient, {
                Ids: options.ids.join(',')
            }).then(function (result) {
                options.items = result.Items;
                return instance.playWithCommand(options, 'PlayNow');
            });
        }
    }

    toggleFullscreen() {
        // not supported
    }

    beginPlayerUpdates() {
        // Setup polling here
    }

    endPlayerUpdates() {
        // Stop polling here
    }

    getPlaylist() {
        return Promise.resolve([]);
    }

    getCurrentPlaylistItemId() {
        // not supported?
    }

    setCurrentPlaylistItem() {
        return Promise.resolve();
    }

    removeFromPlaylist() {
        return Promise.resolve();
    }

    getPlayerState() {
        return this.getPlayerStateInternal() || {};
    }

    getCurrentPlaylistIndex() {
        // tbd: update to support playlists and not only album with tracks
        return this.getPlayerStateInternal()?.NowPlayingItem?.IndexNumber;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    clearQueue(currentTime) {
        // not supported yet
    }
}

export default ChromecastPlayer;
