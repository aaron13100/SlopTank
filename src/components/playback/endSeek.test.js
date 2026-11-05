// SlopTank modification notice: added or changed by SlopTank on 2026-11-05.
/** End-seeks must produce the same stopped event and final position as natural completion. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Events from '../../utils/events.ts';
import HtmlVideoPlayer from '../../plugins/htmlVideoPlayer/plugin';
import { playbackManager } from './playbackmanager';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { pluginManager } from '../pluginManager';
import HtmlAudioPlayer from '../../plugins/htmlAudioPlayer/plugin';

const players = [];
const reports = [];
let registeredPlayer;

function trackPlayer(player) {
    // initMediaPlayer supplies this public flag when registering local plugins.
    player.isLocalPlayer = true;
    players.push(player);
    return player;
}

beforeAll(async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="backgroundContainer"></div><div class="backdropContainer"></div>');
    await vi.dynamicImportSettled();
    let serverInfo = { Id: 'offline-server' };
    ServerConnections.addApiClient({
        serverAddress: () => 'https://jellyfin.test.invalid',
        serverInfo(info) {
            if (info) serverInfo = info;
            return serverInfo;
        },
        serverId: () => 'offline-server',
        getCurrentUserId: () => 'user-1',
        getCurrentUser: () => Promise.resolve({ Id: 'user-1', Configuration: {} }),
        getSavedEndpointInfo: () => ({ IsInNetwork: true }),
        reportPlaybackStopped: info => {
            reports.push(info);
            return Promise.resolve();
        }
    });
    await pluginManager.loadPlugin(Promise.resolve({ default: HtmlVideoPlayer }));
    registeredPlayer = pluginManager.plugins.find(plugin => plugin.id === 'htmlvideoplayer');
});
afterEach(() => {
    for (const player of players.splice(0)) player.destroy();
    document.querySelectorAll('.videoPlayerContainer').forEach(container => {
        container.remove();
    });
});

for (const kind of ['video', 'audio']) {
    describe(`${kind} end seek`, () => {
        it.each([1415000, 1415470])('finishes playback at target %i ms instead of silently waiting for ended', async (target) => {
            const element = document.createElement(kind);
            Object.defineProperty(element, 'duration', { value: 1415 });
            let player;
            if (kind === 'video') {
                const container = document.createElement('div');
                container.className = 'videoPlayerContainer';
                container.append(element);
                document.body.append(container);
                player = trackPlayer(new HtmlVideoPlayer());
                await player.createMediaElement({});
            } else {
                player = trackPlayer(new HtmlAudioPlayer());
                player._mediaElement = element;
                player._currentSrc = 'test.mp3';
            }
            element.currentTime = 1385;
            const completions = [];
            Events.on(player, 'stopped', () => completions.push(player.currentTime()));
            player.currentTime(target);
            expect(completions, `end seek ${target} must report the final position before resetting the source`).toEqual([1415000]);
        });

        it('keeps an ordinary seek in playback', async () => {
            const player = kind === 'video' ? trackPlayer(new HtmlVideoPlayer()) : trackPlayer(new HtmlAudioPlayer());
            const element = document.createElement(kind);
            Object.defineProperty(element, 'duration', { value: 1415 });
            if (kind === 'video') {
                const container = document.createElement('div');
                container.className = 'videoPlayerContainer';
                container.append(element);
                document.body.append(container);
                await player.createMediaElement({});
            } else {
                player._mediaElement = element;
            }
            const completions = [];
            Events.on(player, 'stopped', () => completions.push(true));
            player.currentTime(1400000);
            expect({ time: element.currentTime, completions }).toEqual({ time: 1400, completions: [] });
        });
    });
}

it.each([1385, 1414.8])('Skip Outro at %i seconds on the final episode finishes playback through the shared seek path', async (position) => {
    const container = document.createElement('div');
    container.className = 'videoPlayerContainer';
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1415 });
    Object.defineProperty(video, 'seekable', { value: { length: 1, start: () => 0, end: () => 1415 } });
    container.append(video);
    document.body.append(container);
    const player = trackPlayer(registeredPlayer);
    reports.length = 0;
    playbackManager._playNextAfterEnded = true;
    await player.createMediaElement({});
    player.streamInfo = {
        url: 'test.mp4',
        item: { Id: 'final-episode', ServerId: 'offline-server', Type: 'Episode', RunTimeTicks: 14150000000 },
        mediaSource: { RunTimeTicks: 14150000000 }
    };
    video.currentTime = position;
    playbackManager._currentPlayer = player;
    playbackManager._playQueueManager.setPlaylist([player.streamInfo.item]);
    playbackManager._playQueueManager.setPlaylistIndex(0);
    Events.trigger(playbackManager, 'playerchange', [player, {}, null]);
    const navigationStates = [];
    const onStop = (_event, state) => navigationStates.push(state.NextMediaType);
    Events.on(player, 'playbackstop', onStop);
    try {
        Events.trigger(player, 'promptskip', [{ Type: 'Outro', StartTicks: 13848410634, EndTicks: 14154661670 }]);
        const button = document.querySelector('.skip-button');
        expect(button).not.toBeNull();
        button.click();
        expect(reports, 'the final-episode Skip Outro click must report completion at the full runtime').toMatchObject([{ ItemId: 'final-episode', PositionTicks: 14150000000 }]);
        expect(playbackManager.getCurrentPlayer()).toBeNull();
        expect(navigationStates, 'the OSD must receive the terminal state that navigates back').toEqual([null]);
    } finally {
        Events.off(player, 'playbackstop', onStop);
        Events.trigger(playbackManager, 'playbackstop', [{}]);
        playbackManager._currentPlayer = null;
        playbackManager._playQueueManager.reset();
        Events.trigger(playbackManager, 'playerchange', [null, {}, null]);
    }
});

it.each([1200, 1415])('seek to %i seconds respects the existing transcode offset', async (target) => {
    const container = document.createElement('div');
    container.className = 'videoPlayerContainer';
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 400 });
    Object.defineProperty(video, 'seekable', { value: { length: 1, start: () => 0, end: () => 400 } });
    container.append(video);
    document.body.append(container);
    const player = trackPlayer(new HtmlVideoPlayer());
    await player.createMediaElement({});
    player.streamInfo = {
        url: 'test.m3u8',
        transcodingOffsetTicks: 10150000000,
        item: { Id: 'resumed-episode', Type: 'Episode', RunTimeTicks: 14150000000 },
        mediaSource: { RunTimeTicks: 14150000000 }
    };
    playbackManager._currentPlayer = player;
    const completions = [];
    Events.on(player, 'stopped', () => completions.push(playbackManager.getCurrentTicks(player)));
    try {
        playbackManager.seek(target * 10000000);
        if (target === 1415) {
            expect(completions).toEqual([14150000000]);
        } else {
            expect({ nativeTime: video.currentTime, completions }).toEqual({ nativeTime: 185, completions: [] });
        }
    } finally {
        playbackManager._currentPlayer = null;
    }
});
