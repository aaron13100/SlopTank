// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-08-03, 2026-09-09, 2026-09-15, 2026-09-24, 2026-09-27.
import { createMemoryHistory } from 'history';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerConnections } from 'lib/jellyfin-apiclient';

import globalize from '../../lib/globalize';
import appSettings from '../../scripts/settings/appSettings';
import Events from '../../utils/events.ts';
import { PluginType } from '../../types/plugin.ts';
import { pluginManager } from '../pluginManager';
import { resolvePlaybackMediaStreams } from './mediaStreams';
import { appRouter } from '../router/appRouter';
import YoutubePlayer from '../../plugins/youtubePlayer/plugin';
import { playbackManager } from './playbackmanager';

/**
 * Trailer playback coverage (t_260722_143145_607), driven through the real
 * user entry point (playbackManager.playTrailers / playbackManager.play)
 * with the real youtubePlayer plugin registered via the real pluginManager
 * registration path, the real string dictionary, and the real alert dialog
 * rendered into jsdom. Only two boundaries are test-configured, both truly
 * external to the app, and both through production seams:
 *  - the YouTube iframe API: window.YT is the exact global the production
 *    script https://www.youtube.com/iframe_api defines; the harness below
 *    implements the same player contract and records constructions
 *  - the Jellyfin server: an offline apiClient implementing the client
 *    contract is registered through ServerConnections.addApiClient(), the
 *    same production seam real connections use
 *
 * Covers:
 *  - dead-trailer recovery: a failed YouTube trailer skips to the next
 *    trailer in the list instead of aborting the playlist
 *  - honest terminal failure: when every trailer fails, the real mapped
 *    reason is surfaced to the user
 *  - scoping: non-trailer URL playback errors do NOT auto-advance
 *  - native-controls handoff: the YT.Player is constructed with YouTube's
 *    own controls enabled and captions off, and the app video OSD is not
 *    shown over the iframe
 *  - close affordances: Escape and the overlay close button stop playback
 *    and tear the trailer dialog down, including after a natural end
 */

/**
 * Records every {text, title} the app sends across the alert seam.
 * components/alert itself is platform-bound dialog UI that cannot render
 * under jsdom (see .claude/mock-allowlist.yaml); the recorded text is the
 * final translated message the user would see.
 */
const alertCalls = vi.hoisted(() => []);
vi.mock('../alert', () => ({
    default: (options) => {
        alertCalls.push(options);
        return Promise.resolve();
    }
}));

const SERVER_ID = 'test-server-1';

/** Records every YT.Player construction and scripts each video's outcome. */
const youTubeHarness = {
    constructedConfigs: [],
    instances: [],
    unavailableVideoIds: new Set(),
    /** Videos that never finish loading (no onReady, no onError). */
    neverReadyVideoIds: new Set(),
    reset() {
        this.constructedConfigs = [];
        this.instances = [];
        this.unavailableVideoIds = new Set();
        this.neverReadyVideoIds = new Set();
    }
};

/**
 * Implementation of the YT.Player contract backing the window.YT seam.
 * Mirrors the async behavior of the real iframe API: onError (code 100,
 * "video not found") for unavailable videos, else onReady followed by a
 * PLAYING state change once playVideo() is called.
 *
 * Faithful to a live-observed detail: the real iframe API attaches the
 * playback methods (stopVideo, getVolume, ...) to the player object only
 * once the embedded player reports ready. Before that, and for players
 * that error out, only construction-time members (destroy) exist. The app
 * crashed on exactly this ("this.currentYoutubePlayer.stopVideo is not a
 * function") when the user closed the overlay while the player was still
 * loading, so the harness models it: the playback API is attached in
 * onReady only.
 */
class ScriptedYouTubePlayer {
    constructor(elementId, config) {
        youTubeHarness.constructedConfigs.push(config);
        youTubeHarness.instances.push(this);
        this.config = config;
        this.destroyed = false;
        this.state = -1;
        setTimeout(() => {
            if (this.destroyed || youTubeHarness.neverReadyVideoIds.has(config.videoId)) {
                return;
            }
            if (youTubeHarness.unavailableVideoIds.has(config.videoId)) {
                config.events.onError({ data: 100, target: this });
            } else {
                this.attachPlaybackApi();
                config.events.onReady({ target: this });
            }
        }, 0);
    }
    /** The real API attaches these only once the player is ready. */
    attachPlaybackApi() {
        this.playVideo = () => {
            setTimeout(() => {
                if (this.destroyed) {
                    return;
                }
                this.state = 1;
                this.config.events.onStateChange({ data: 1, target: this });
            }, 0);
        };
        this.stopVideo = () => {
            this.state = -1;
        };
        this.pauseVideo = () => {
            this.state = 2;
        };
        this.setSize = () => undefined;
        this.seekTo = () => undefined;
        this.getCurrentTime = () => 1;
        this.getDuration = () => 120;
        this.getPlayerState = () => this.state;
        this.getVolume = () => 100;
        this.setVolume = () => undefined;
        this.mute = () => undefined;
        this.unMute = () => undefined;
        this.isMuted = () => false;
    }
    /** Test hook: simulate the video reaching its natural end. */
    endVideo() {
        this.state = 0;
        this.config.events.onStateChange({ data: 0, target: this });
    }
    destroy() {
        this.destroyed = true;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until cond() is truthy; throws after ~3s so failures stay fast. */
async function waitFor(cond) {
    for (let i = 0; i < 300; i++) {
        if (cond()) {
            return;
        }
        await sleep(10);
    }
    throw new TypeError('waitFor: condition never became true');
}

const userConfiguration = { EnableNextEpisodeAutoPlay: true };

/**
 * Offline implementation of the apiClient contract surface this flow
 * touches, registered through the production ServerConnections.addApiClient
 * seam. The Jellyfin server itself is unavailable under vitest.
 */
function createOfflineApiClient() {
    let serverInfo = { Id: SERVER_ID };
    return {
        serverAddress: () => 'https://jellyfin.test.invalid',
        serverInfo(info) {
            if (info) {
                serverInfo = info;
            }
            return serverInfo;
        },
        serverId: () => SERVER_ID,
        getCurrentUserId: () => 'user-1',
        getCurrentUser: () => Promise.resolve({ Id: 'user-1', Configuration: userConfiguration }),
        getSavedEndpointInfo: () => ({ IsInNetwork: true }),
        getEndpointInfo: () => Promise.resolve({ IsInNetwork: true }),
        getLocalTrailers: () => Promise.resolve([]),
        getIntros: () => Promise.resolve({ Items: [] }),
        getItem: () => Promise.resolve({}),
        reportPlaybackStart: () => Promise.resolve(),
        reportPlaybackProgress: () => Promise.resolve(),
        reportPlaybackStopped: () => Promise.resolve()
    };
}

function youtubeUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

function movieWithTrailers(videoIds) {
    return {
        Id: 'movie-1',
        Name: 'Some Movie',
        ServerId: SERVER_ID,
        MediaType: 'Video',
        Type: 'Movie',
        RemoteTrailers: videoIds.map((videoId) => ({ Url: youtubeUrl(videoId), Name: `${videoId} trailer` }))
    };
}

function constructedVideoIds() {
    return youTubeHarness.constructedConfigs.map((config) => config.videoId);
}

function trailerDialog() {
    return document.querySelector('.youtubePlayerContainer');
}

function youtubePlugin() {
    return pluginManager.ofType(PluginType.MediaPlayer).find((plugin) => plugin.id === 'youtubeplayer');
}

describe('playbackManager trailer playback', () => {
    /** playbackstart states observed on the real playbackManager bus. */
    let playbackStarts;

    function onPlaybackStart(e, player, state) {
        playbackStarts.push(state);
    }

    beforeAll(async () => {
        window.YT = { Player: ScriptedYouTubePlayer, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 } };

        // Same setup as appRouter.test.js: drive the real router over a real
        // in-memory history so router-dependent paths work under jsdom.
        appRouter.initialize(createMemoryHistory());

        // DOM scaffolding index.html normally provides; backdrop teardown
        // during player destroy() requires it.
        if (!document.querySelector('.backgroundContainer')) {
            const backgroundContainer = document.createElement('div');
            backgroundContainer.classList.add('backgroundContainer');
            document.body.appendChild(backgroundContainer);
        }

        // Load the real string dictionary so assertions cover the actual
        // user-facing message text, not just translation keys.
        globalize.register({ name: 'core', strings: [{ lang: 'en-us', path: 'en-us.json' }] });
        globalize.defaultModule('core');
        await globalize.loadStrings('core');

        ServerConnections.addApiClient(createOfflineApiClient());

        // Register the real plugin through the real registration path so
        // playbackManager wires it exactly as in production.
        await pluginManager.loadPlugin(Promise.resolve({ default: YoutubePlayer }));
    });

    beforeEach(() => {
        youTubeHarness.reset();
        userConfiguration.EnableNextEpisodeAutoPlay = true;
        alertCalls.length = 0;
        playbackStarts = [];
        Events.on(playbackManager, 'playbackstart', onPlaybackStart);
    });

    afterEach(async () => {
        Events.off(playbackManager, 'playbackstart', onPlaybackStart);
        // Tear down whatever the test left playing via the real stop path.
        const plugin = youtubePlugin();
        if (plugin) {
            await playbackManager.stop(plugin);
            // Belt for red-phase runs where stop() cannot tear down yet.
            const dialog = trailerDialog();
            if (dialog) {
                dialog.remove();
                plugin.videoDialog = null;
            }
        }
        playbackManager._playQueueManager.reset();
        await sleep(20);
    });

    it('skips to the next trailer when the first YouTube trailer is dead', async () => {
        youTubeHarness.unavailableVideoIds.add('deadvid1');
        const movie = movieWithTrailers(['deadvid1', 'goodvid1']);

        await playbackManager.playTrailers(movie);
        await waitFor(() => playbackStarts.length === 1);

        // The dead trailer was tried first, then playback advanced to the
        // next trailer instead of aborting the playlist.
        expect(constructedVideoIds()).toEqual(['deadvid1', 'goodvid1']);
        expect(playbackStarts[0].NowPlayingItem.Name).toBe('goodvid1 trailer');
        // No error surfaced: recovery was silent.
        expect(alertCalls).toHaveLength(0);
        expect(trailerDialog()).toBeTruthy();
    });

    it('skips a dead trailer mid-list after an earlier trailer already played', async () => {
        // Covers the queue-fallback branch: when trailer 2 of 3 dies, the
        // originating play options are no longer available (the queue
        // advanced naturally after trailer 1 ended), so the remaining
        // trailers come from the live play queue.
        youTubeHarness.unavailableVideoIds.add('deadvid1');
        const movie = movieWithTrailers(['goodvid1', 'deadvid1', 'goodvid2']);

        await playbackManager.playTrailers(movie);
        await waitFor(() => playbackStarts.length === 1);

        // First trailer finishes; auto-play advances into the dead one,
        // which must be skipped in favor of the third.
        youTubeHarness.instances[0].endVideo();
        await waitFor(() => playbackStarts.length === 2);

        expect(constructedVideoIds()).toEqual(['goodvid1', 'deadvid1', 'goodvid2']);
        expect(playbackStarts[1].NowPlayingItem.Name).toBe('goodvid2 trailer');
        expect(alertCalls).toHaveLength(0);
    });

    it('surfaces the real mapped reason when every trailer is dead', async () => {
        youTubeHarness.unavailableVideoIds.add('deadvid1');
        youTubeHarness.unavailableVideoIds.add('deadvid2');
        const movie = movieWithTrailers(['deadvid1', 'deadvid2']);

        await playbackManager.playTrailers(movie);

        // Both were tried; nothing started; the user got the specific
        // reason (error code 100 maps to YoutubeNotFound), not silence and
        // not a generic error.
        await waitFor(() => alertCalls.length === 1);
        expect(alertCalls[0].text).toBe('Trailer unavailable (Video not found.)');
        expect(constructedVideoIds()).toEqual(['deadvid1', 'deadvid2']);
        expect(playbackStarts).toHaveLength(0);
        // The overlay must not be left covering the page.
        expect(trailerDialog()).toBeNull();
    });

    it('does NOT auto-advance for non-trailer URL playback errors', async () => {
        youTubeHarness.unavailableVideoIds.add('deadvid1');
        const items = [
            { Name: 'Some Video', Url: youtubeUrl('deadvid1'), MediaType: 'Video', ServerId: SERVER_ID },
            { Name: 'Other Video', Url: youtubeUrl('goodvid1'), MediaType: 'Video', ServerId: SERVER_ID }
        ];

        await playbackManager.play({ items });

        // Ordinary (non-Trailer) playback keeps the existing error
        // behavior: abort and report, no trailer-style auto-advance.
        await waitFor(() => alertCalls.length === 1);
        expect(alertCalls[0].text).toBe('Video not found.');
        expect(constructedVideoIds()).toEqual(['deadvid1']);
        expect(playbackStarts).toHaveLength(0);
    });

    it('hands the control surface to YouTube instead of the app OSD', async () => {
        const movie = movieWithTrailers(['goodvid1']);

        await playbackManager.playTrailers(movie);
        await waitFor(() => playbackStarts.length === 1);

        const playerVars = youTubeHarness.constructedConfigs[0].playerVars;
        // Native YouTube controls own the trailer: CC toggle, quality,
        // scrubbing and fullscreen come from YouTube's own chrome.
        expect(playerVars.controls).toBe(1);
        // Auto-captions default OFF; the user opts in via the CC button.
        expect(playerVars.cc_load_policy).toBe(0);
        expect(playerVars.fs).toBe(1);
        expect(playerVars.modestbranding).toBe(1);
        expect(playerVars.rel).toBe(0);
        expect(playerVars.playsinline).toBe(1);

        // The app never navigates to its own video OSD for the trailer, so
        // the container must keep fronting the page itself.
        expect(appRouter.history.location.pathname).not.toBe('/web/video');
        expect(trailerDialog().classList.contains('onTop')).toBe(true);
    });

    it('stops and tears down the trailer when Escape is pressed', async () => {
        const movie = movieWithTrailers(['goodvid1']);

        await playbackManager.playTrailers(movie);
        await waitFor(() => playbackStarts.length === 1);
        expect(trailerDialog()).toBeTruthy();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        await waitFor(() => trailerDialog() === null);
    });

    it('Escape tears down the overlay while the player is still loading', async () => {
        // Live-observed crash: before the embedded player reports ready,
        // the YT.Player object has no playback methods, and closing the
        // overlay threw "stopVideo is not a function", leaving the overlay
        // stuck. The harness models the pre-ready API surface.
        youTubeHarness.neverReadyVideoIds.add('slowvid1');
        const movie = movieWithTrailers(['slowvid1']);

        playbackManager.playTrailers(movie);
        await waitFor(() => youTubeHarness.constructedConfigs.length === 1 && trailerDialog() !== null);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        await waitFor(() => trailerDialog() === null);
    });

    it('close button tears down the overlay even after the trailer ended naturally', async () => {
        userConfiguration.EnableNextEpisodeAutoPlay = false;
        const movie = movieWithTrailers(['goodvid1', 'goodvid2']);

        await playbackManager.playTrailers(movie);
        await waitFor(() => playbackStarts.length === 1);

        // First trailer ends; with next-episode auto-play off nothing
        // advances, so the overlay is still up with no video.
        youTubeHarness.instances[0].endVideo();
        await sleep(50);
        expect(trailerDialog()).toBeTruthy();

        // The user's only way out is the overlay's own close button (the
        // YouTube chrome has no close control); it must still work even
        // though the player already ended (src is gone).
        const closeButton = document.querySelector('.youtubePlayerCloseButton');
        expect(closeButton).toBeTruthy();
        closeButton.click();

        await waitFor(() => trailerDialog() === null);
    });
});

describe('playbackManager media-stream resolution', () => {
    function offlineApiClient() {
        const fetched = [];
        return {
            apiClient: {
                getCurrentUserId: () => 'user-1',
                getItem: (_userId, id) => {
                    fetched.push(id);
                    return Promise.resolve({ Id: id, MediaStreams: [{ Index: 0, Type: 'Video', Id: 'fetched' }] });
                }
            },
            fetched
        };
    }

    it('reuses the item streams when no source is selected, without refetching', async () => {
        const { apiClient, fetched } = offlineApiClient();
        const item = { Id: 'movie-1', MediaStreams: [{ Index: 0, Type: 'Video', Id: 'item' }] };

        const streams = await resolvePlaybackMediaStreams(apiClient, item, null);

        // The Play flow must not pay a whole extra item round trip between
        // the click and PlaybackInfo when the streams are already in hand.
        expect(streams).toBe(item.MediaStreams);
        expect(fetched).toEqual([]);
    });

    it('refetches when a media source is explicitly selected', async () => {
        const { apiClient, fetched } = offlineApiClient();
        const item = {
            Id: 'movie-1',
            MediaStreams: [{ Index: 0, Type: 'Video', Id: 'item' }],
            MediaSources: [{ Id: 'movie-1' }, { Id: 'source-2' }]
        };

        const streams = await resolvePlaybackMediaStreams(apiClient, item, 'source-2');

        // A different source's streams cannot be assumed from the item's own
        // merged list, so the explicit selection still refetches by source.
        expect(streams[0].Id).toBe('fetched');
        expect(fetched).toEqual(['source-2']);
    });

    it('reuses item streams when the selection is the item only source (details default)', async () => {
        const { apiClient, fetched } = offlineApiClient();
        // The details page source selector defaults to the single source,
        // whose id equals the item id; that is not a real selection.
        const item = {
            Id: 'movie-1',
            MediaStreams: [{ Index: 0, Type: 'Video', Id: 'item' }],
            MediaSources: [{ Id: 'movie-1' }]
        };

        const streams = await resolvePlaybackMediaStreams(apiClient, item, 'movie-1');

        expect(streams).toBe(item.MediaStreams);
        expect(fetched).toEqual([]);
    });

    it('refetches when the item carries no streams', async () => {
        const { apiClient, fetched } = offlineApiClient();
        const item = { Id: 'movie-1' };

        const streams = await resolvePlaybackMediaStreams(apiClient, item, null);

        expect(streams[0].Id).toBe('fetched');
        expect(fetched).toEqual(['movie-1']);
    });
});

/** A promise plus its resolve/reject, so a test controls when a boundary answers. */
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Records whether a promise has settled, without awaiting it. */
function trackSettled(promise) {
    const state = { settled: false, error: null };
    promise.then(() => {
        state.settled = true;
    }, (error) => {
        state.settled = true;
        state.error = error;
    });
    return state;
}

/**
 * Quality changes must be awaitable end to end (t_260916_110919_134).
 *
 * setMaxStreamingBitrate used to fire its endpoint lookup, bitrate probe,
 * settings write and changeStream without returning the chain, so every
 * caller (the player settings menu among them) resolved before the new
 * stream existed, and a re-read right after the click saw the old bitrate.
 * These drive the real playbackManager through the real changeStream path;
 * the only test-configured boundaries are the Jellyfin server (an offline
 * apiClient registered through ServerConnections.addApiClient) and the
 * media player plugin contract (getDeviceProfile / play), each answering
 * from a deferred the test releases, so the test observes exactly when the
 * manager's promise settles relative to them.
 */
describe('playbackManager.setMaxStreamingBitrate awaitability', () => {
    const STREAM_SERVER_ID = 'c209-stream-server';
    /** Every force flag the manager passed to the server's bitrate probe. */
    const bitrateProbeCalls = [];
    let bitrateProbe;
    /** The server's answer to an instant-mix request, released by the test. */
    let instantMixResponse;

    beforeAll(() => {
        let serverInfo = { Id: STREAM_SERVER_ID };
        ServerConnections.addApiClient({
            serverAddress: () => 'https://c209.test.invalid',
            serverInfo(info) {
                if (info) {
                    serverInfo = info;
                }
                return serverInfo;
            },
            serverId: () => STREAM_SERVER_ID,
            getCurrentUserId: () => 'user-1',
            deviceId: () => 'c209-device',
            accessToken: () => 'c209-token',
            getUrl: (name, params) => `https://c209.test.invalid/${name}?${new URLSearchParams(params || {}).toString()}`,
            getSavedEndpointInfo: () => ({ IsInNetwork: false }),
            getEndpointInfo: () => Promise.resolve({ IsInNetwork: false }),
            detectBitrate(force) {
                bitrateProbeCalls.push(force);
                return bitrateProbe.promise;
            },
            getInstantMixFromItem: () => instantMixResponse.promise,
            reportPlaybackProgress: () => Promise.resolve()
        });
    });

    beforeEach(() => {
        bitrateProbe = createDeferred();
        bitrateProbeCalls.length = 0;
        instantMixResponse = createDeferred();
    });

    /**
     * A local video player mid-playback implementing the media player
     * plugin contract, with its device-profile and play() answers held open
     * until the test releases them.
     */
    function createPlayingVideoPlayer({ playMethod = 'DirectPlay', extraStreams = [] } = {}) {
        const mediaSource = {
            Id: 'c209-source',
            Container: 'mp4',
            Protocol: 'Http',
            RequiredHttpHeaders: [],
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: true,
            RunTimeTicks: 600000000,
            MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', BitRate: 8000000 }, ...extraStreams]
        };
        const item = {
            Id: 'c209-movie',
            Name: 'Bitrate Movie',
            ServerId: STREAM_SERVER_ID,
            MediaType: 'Video',
            Type: 'Movie',
            PresetMediaSource: mediaSource
        };
        const deviceProfile = createDeferred();
        const playback = createDeferred();
        const calls = { deviceProfile: 0, play: [] };
        const player = {
            name: 'c209-stream-change-player',
            id: 'c209-stream-change-player',
            isLocalPlayer: true,
            streamInfo: {
                url: 'https://c209.test.invalid/Videos/c209-movie/stream.mp4',
                mediaType: 'Video',
                playMethod,
                item,
                mediaSource
            },
            currentTime: () => 42,
            duration: () => 60,
            paused: () => false,
            getVolume: () => 100,
            isMuted: () => false,
            setSubtitleStreamIndex: () => undefined,
            supports: () => false,
            currentSrc() {
                return this.streamInfo.url;
            },
            getDeviceProfile() {
                calls.deviceProfile++;
                return deviceProfile.promise;
            },
            play(streamInfo) {
                calls.play.push(streamInfo);
                return playback.promise;
            }
        };
        return { player, calls, deviceProfile, playback };
    }

    it('resolves only after bitrate detection, the settings write and the new stream have landed', async () => {
        const { player, calls, deviceProfile, playback } = createPlayingVideoPlayer();

        const result = playbackManager.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: true }, player);

        expect(typeof result?.then).toBe('function');
        const state = trackSettled(result);

        await waitFor(() => bitrateProbeCalls.length === 1);
        expect(bitrateProbeCalls).toEqual([true]);
        await sleep(20);
        expect(state.settled).toBe(false);

        bitrateProbe.resolve(3000000);
        await waitFor(() => calls.deviceProfile === 1);
        expect(appSettings.enableAutomaticBitrateDetection(false, 'Video')).toBe(true);
        expect(Number(appSettings.maxStreamingBitrate(false, 'Video'))).toBe(3000000);
        await sleep(20);
        expect(state.settled).toBe(false);

        deviceProfile.resolve({});
        await waitFor(() => calls.play.length === 1);
        await sleep(20);
        expect(state.settled).toBe(false);

        playback.resolve();
        await waitFor(() => state.settled);
        expect(player.streamInfo.started).toBe(true);
        expect(player.maxStreamingBitrate).toBe(3000000);
    });

    it('awaits the stream change for a fixed bitrate choice too', async () => {
        const { player, calls, deviceProfile, playback } = createPlayingVideoPlayer();

        const result = playbackManager.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 420000 }, player);

        expect(typeof result?.then).toBe('function');
        const state = trackSettled(result);

        await waitFor(() => calls.deviceProfile === 1);
        expect(bitrateProbeCalls).toEqual([]);
        expect(appSettings.enableAutomaticBitrateDetection(false, 'Video')).toBe(false);
        deviceProfile.resolve({});
        await waitFor(() => calls.play.length === 1);
        await sleep(20);
        expect(state.settled).toBe(false);

        playback.resolve();
        await waitFor(() => state.settled);
        expect(player.maxStreamingBitrate).toBe(420000);
    });

    /**
     * Asserts `result` is a promise that stays pending through the device
     * profile request and the new stream's play(), settling only after both.
     */
    async function expectAwaitsStreamChange(result, { calls, deviceProfile, playback }) {
        expect(typeof result?.then).toBe('function');
        const state = trackSettled(result);

        await waitFor(() => calls.deviceProfile === 1);
        await sleep(20);
        expect(state.settled).toBe(false);

        deviceProfile.resolve({});
        await waitFor(() => calls.play.length === 1);
        await sleep(20);
        expect(state.settled).toBe(false);

        playback.resolve();
        await waitFor(() => state.settled);
        expect(state.error).toBeNull();
    }

    it('seek on a transcoded stream resolves once the re-requested stream plays', async () => {
        const harness = createPlayingVideoPlayer({ playMethod: 'Transcode' });

        await expectAwaitsStreamChange(playbackManager.seek(300000000, harness.player), harness);

        expect(harness.calls.play[0].playerStartPositionTicks).toBe(300000000);
    });

    it('setAudioStreamIndex on a transcoded stream resolves once the new audio stream plays', async () => {
        const harness = createPlayingVideoPlayer({
            playMethod: 'Transcode',
            extraStreams: [{ Index: 1, Type: 'Audio', Codec: 'aac' }, { Index: 2, Type: 'Audio', Codec: 'ac3' }]
        });

        await expectAwaitsStreamChange(playbackManager.setAudioStreamIndex(2, harness.player), harness);

        expect(harness.player.audioStreamIndex).toBe(2);
    });

    it('setSubtitleStreamIndex resolves once a burned-in subtitle stream plays', async () => {
        const harness = createPlayingVideoPlayer({
            playMethod: 'Transcode',
            extraStreams: [{ Index: 3, Type: 'Subtitle', Codec: 'pgssub', DeliveryMethod: 'Encode' }]
        });

        await expectAwaitsStreamChange(playbackManager.setSubtitleStreamIndex(3, harness.player), harness);

        expect(harness.player.subtitleStreamIndex).toBe(3);
    });

    it('a remote SetMaxStreamingBitrate command applies the requested cap', async () => {
        const harness = createPlayingVideoPlayer();

        const result = playbackManager.sendCommand({ Name: 'SetMaxStreamingBitrate', Arguments: { Bitrate: '420000' } }, harness.player);

        await expectAwaitsStreamChange(result, harness);
        expect(bitrateProbeCalls).toEqual([]);
        expect(appSettings.enableAutomaticBitrateDetection(false, 'Video')).toBe(false);
        expect(harness.player.maxStreamingBitrate).toBe(420000);
    });

    it('seekRelative hands the offset to a player that manages its own playlist', () => {
        const offsets = [];
        const player = {
            name: 'c209-self-managing-player',
            isLocalPlayer: false,
            getPlaylist: () => Promise.resolve([]),
            seekRelative(offsetTicks) {
                offsets.push(offsetTicks);
                return 'forwarded';
            }
        };

        expect(playbackManager.seekRelative(50000000, player)).toBe('forwarded');
        expect(offsets).toEqual([50000000]);
    });

    it('queue resolves only after items are handed to a player that manages its own playlist', async () => {
        const profile = createDeferred();
        const queued = [];
        const player = {
            name: 'c209-queueing-player',
            isLocalPlayer: true,
            getPlaylist: () => Promise.resolve([]),
            getDeviceProfile: () => profile.promise,
            getMaxStreamingBitrate: () => 8000000,
            queue(items) {
                queued.push(items);
            }
        };
        const item = { Id: 'c209-queued', Name: 'Queued', ServerId: STREAM_SERVER_ID, MediaType: 'Video', Type: 'Movie' };

        const state = trackSettled(playbackManager.queue({ items: [item] }, player));
        await sleep(20);
        expect(state.settled).toBe(false);
        expect(queued).toEqual([]);

        profile.resolve({ TranscodingProfiles: [], DirectPlayProfiles: [], CodecProfiles: [] });
        await waitFor(() => state.settled);
        expect(state.error).toBeNull();
        expect(queued).toEqual([[item]]);
    });

    it('nextTrack returns the play pipeline for the next queued item', async () => {
        appSettings.enableAutomaticBitrateDetection(false, 'Video', false);
        const harness = createPlayingVideoPlayer();
        const next = { Id: 'c209-next', Name: 'Next', ServerId: STREAM_SERVER_ID, MediaType: 'Video', Type: 'Movie' };
        playbackManager._playQueueManager.setPlaylist([harness.player.streamInfo.item, next]);
        playbackManager._playQueueManager.setPlaylistState(playbackManager._playQueueManager.getPlaylist()[0].PlaylistItemId, 0);

        try {
            const result = playbackManager.nextTrack(harness.player);

            expect(typeof result?.then).toBe('function');
            const state = trackSettled(result);
            await waitFor(() => state.settled);
        } finally {
            playbackManager._playQueueManager.reset();
        }
    });

    it('instantMix resolves only after the mix request and the resulting play request finish', async () => {
        const harness = createPlayingVideoPlayer();

        const result = playbackManager.instantMix({ Id: 'c209-seed', ServerId: STREAM_SERVER_ID }, harness.player);

        expect(typeof result?.then).toBe('function');
        const state = trackSettled(result);
        await sleep(20);
        expect(state.settled).toBe(false);

        // An empty mix has nothing to play: the play request fails, and that
        // failure now reaches the instantMix caller instead of floating.
        instantMixResponse.resolve({ Items: [] });
        await waitFor(() => state.settled);
    });
});
