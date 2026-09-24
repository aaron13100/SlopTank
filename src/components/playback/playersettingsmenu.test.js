// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ServerConnections } from 'lib/jellyfin-apiclient';

import globalize from '../../lib/globalize';
import appSettings from '../../scripts/settings/appSettings';
import playerSettingsMenu from './playersettingsmenu';

/**
 * The action sheet is platform dialog UI that cannot render under jsdom
 * (see .claude/mock-allowlist.yaml). This seam records every sheet the menu
 * opens and answers each with the id the user clicks, in order.
 */
const actionSheetSeam = vi.hoisted(() => ({ shown: [], clicks: [] }));
vi.mock('../actionSheet/actionSheet', () => ({
    default: {
        show: (options) => {
            actionSheetSeam.shown.push(options);
            return Promise.resolve(actionSheetSeam.clicks.shift());
        }
    }
}));

/**
 * The player settings menu's Quality choice must stay awaitable until the
 * new stream is actually playing (t_260916_110919_134).
 *
 * showQualityMenu used to call playbackManager.setMaxStreamingBitrate as a
 * bare statement, so the menu's own promise (returned from show() to the
 * video OSD) settled as soon as the sheet closed, while the endpoint
 * lookup, bitrate probe, settings write and stream change were still in
 * flight. A re-read of the menu right after the click then showed the old
 * bitrate. This drives the real menu and the real playbackManager. The
 * test-configured boundaries are the action sheet (platform dialog UI, see
 * the seam below), the Jellyfin server (an offline apiClient registered
 * through ServerConnections.addApiClient) and the media player plugin
 * contract, whose device-profile and play() answers are held open until
 * released.
 */

const SERVER_ID = 'c209-menu-server';

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

/** Every force flag the manager passed to the server's bitrate probe. */
const bitrateProbeCalls = [];
let bitrateProbe;

/**
 * A local video player mid-playback implementing the media player plugin
 * contract, with its device-profile and play() answers held open until the
 * test releases them.
 */
function createPlayingVideoPlayer() {
    const mediaSource = {
        Id: 'c209-menu-source',
        Container: 'mp4',
        Protocol: 'Http',
        RequiredHttpHeaders: [],
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        RunTimeTicks: 600000000,
        MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', BitRate: 8000000 }]
    };
    const item = {
        Id: 'c209-menu-movie',
        Name: 'Menu Movie',
        ServerId: SERVER_ID,
        MediaType: 'Video',
        Type: 'Movie',
        PresetMediaSource: mediaSource
    };
    const deviceProfile = createDeferred();
    const playback = createDeferred();
    const calls = { deviceProfile: 0, play: [] };
    const player = {
        name: 'c209-menu-player',
        id: 'c209-menu-player',
        isLocalPlayer: true,
        streamInfo: {
            url: 'https://c209.test.invalid/Videos/c209-menu-movie/stream.mp4',
            mediaType: 'Video',
            playMethod: 'DirectPlay',
            item,
            mediaSource
        },
        currentTime: () => 42,
        duration: () => 60,
        paused: () => false,
        getVolume: () => 100,
        isMuted: () => false,
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

describe('player settings menu quality choice', () => {
    beforeAll(async () => {
        globalize.register({ name: 'core', strings: [{ lang: 'en-us', path: 'en-us.json' }] });
        globalize.defaultModule('core');
        await globalize.loadStrings('core');

        let serverInfo = { Id: SERVER_ID };
        ServerConnections.addApiClient({
            serverAddress: () => 'https://c209.test.invalid',
            serverInfo(info) {
                if (info) {
                    serverInfo = info;
                }
                return serverInfo;
            },
            serverId: () => SERVER_ID,
            getCurrentUserId: () => 'user-1',
            getCurrentUser: () => Promise.resolve({ Id: 'user-1', Policy: { EnableVideoPlaybackTranscoding: true } }),
            deviceId: () => 'c209-device',
            accessToken: () => 'c209-token',
            getUrl: (name, params) => `https://c209.test.invalid/${name}?${new URLSearchParams(params || {}).toString()}`,
            getSavedEndpointInfo: () => ({ IsInNetwork: false }),
            getEndpointInfo: () => Promise.resolve({ IsInNetwork: false }),
            detectBitrate(force) {
                bitrateProbeCalls.push(force);
                return bitrateProbe.promise;
            },
            reportPlaybackProgress: () => Promise.resolve()
        });
    });

    it('keeps the menu promise pending until the Auto quality stream is playing', async () => {
        bitrateProbe = createDeferred();
        bitrateProbeCalls.length = 0;
        // The user had forced the lowest tier; Auto is the change under test.
        appSettings.enableAutomaticBitrateDetection(false, 'Video', false);
        appSettings.maxStreamingBitrate(false, 'Video', 420000);
        const { player, calls, deviceProfile, playback } = createPlayingVideoPlayer();

        actionSheetSeam.shown.length = 0;
        // The user opens Quality, then picks Auto (bitrate id 0).
        actionSheetSeam.clicks = ['quality', '0'];

        const state = trackSettled(playerSettingsMenu.show({ player, quality: true }));

        await waitFor(() => bitrateProbeCalls.length === 1);
        expect(actionSheetSeam.shown[0].items.map((item) => item.id)).toContain('quality');
        expect(actionSheetSeam.shown[1].items.find((item) => item.id === 0).name).toBe('Auto');
        await sleep(20);
        expect(state.settled).toBe(false);

        bitrateProbe.resolve(3000000);
        await waitFor(() => calls.deviceProfile === 1);
        deviceProfile.resolve({});
        await waitFor(() => calls.play.length === 1);
        await sleep(20);
        expect(state.settled).toBe(false);

        playback.resolve();
        await waitFor(() => state.settled);
        expect(state.error).toBeNull();
        expect(appSettings.enableAutomaticBitrateDetection(false, 'Video')).toBe(true);
        expect(player.maxStreamingBitrate).toBe(3000000);
    });
});
