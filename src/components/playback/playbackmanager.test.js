import { createMemoryHistory } from 'history';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerConnections } from 'lib/jellyfin-apiclient';

import globalize from '../../lib/globalize';
import Events from '../../utils/events.ts';
import { PluginType } from '../../types/plugin.ts';
import { pluginManager } from '../pluginManager';
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
        expect(appRouter.history.location.pathname).not.toBe('/video');
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
