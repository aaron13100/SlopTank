import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from '../../utils/events.ts';

import { setRouteSearchOverride } from '../../utils/url.ts';
import { createPermalinkResume } from '../../controllers/playback/video/permalinkResume';
import { createPlaybackLauncher } from './playbackLauncher';
import {
    beginPlaybackStartupTrace,
    cancelPlaybackStartupTrace,
    completePlaybackStartupTrace,
    flushPendingPlaybackStartupTraces,
    playbackStartupTraceMemoryStatsForTest,
    playbackStartupTraceStorageKey,
    recordPlaybackStartupTrace,
    setPlaybackStartupTraceDeliveryJournalForTest
} from './playbackStartupTrace';

const SERVER_ID = 'playback-startup-trace-test-server';
const STORAGE_KEY = playbackStartupTraceStorageKey();
const ORIGINAL_AXIOS_ADAPTER = axios.defaults.adapter;
const uploadedRequests = [];

function createBoundaryJournal() {
    const rows = new Map();
    let nextClaim = 0;
    const keyFor = input => JSON.stringify([input.serverId, input.attemptId, input.phase]);
    return {
        async claimDelivery(input) {
            const key = keyFor(input);
            const row = rows.get(key);
            if (row?.acknowledged || row?.deliveries >= 2 && !row.activeClaim) return { kind: 'done' };
            if (row?.activeClaim) return { kind: 'defer', retryAtMs: row.expiresAtMs };
            if (row?.retryAtMs > Date.now()) return { kind: 'defer', retryAtMs: row.retryAtMs };
            const ordinal = (row?.deliveries || 0) + 1;
            const claimId = `test-claim-${++nextClaim}`;
            const payloadTemplate = row?.firstPayloadTemplate || input.payloadTemplate;
            const next = {
                deliveries: ordinal,
                acknowledged: false,
                firstPayloadTemplate: payloadTemplate,
                activeClaim: claimId,
                expiresAtMs: Date.now() + 30_000,
                retryAtMs: null
            };
            rows.set(key, next);
            return { kind: 'claimed', claimId, ordinal, payloadTemplate, expiresAtMs: next.expiresAtMs };
        },
        async acknowledgeDelivery(input) {
            const row = rows.get(keyFor(input));
            if (row) {
                row.acknowledged = true;
                row.activeClaim = null;
                row.firstPayloadTemplate = null;
                row.retryAtMs = null;
            }
            return { kind: 'committed', applied: Boolean(row) };
        },
        async recordDeliveryFailure(input) {
            const row = rows.get(keyFor(input));
            if (row?.activeClaim === input.claimId) {
                row.activeClaim = null;
                row.retryAtMs = row.deliveries < 2 ? Date.now() + 1000 : null;
            }
            return { kind: 'committed', applied: Boolean(row), retryAtMs: row?.retryAtMs };
        },
        async readDeliveryMirrors(requests) {
            return {
                kind: 'read',
                rows: requests.flatMap(request => {
                    const row = rows.get(keyFor(request));
                    return row ? [{ ...request, deliveries: row.deliveries, acknowledged: row.acknowledged }] : [];
                })
            };
        }
    };
}

function offlineApiClient(itemFetchPromise) {
    return {
        serverAddress: () => 'https://jellyfin.test.invalid',
        serverInfo: () => ({ Id: SERVER_ID }),
        serverId: () => SERVER_ID,
        getCurrentUserId: () => 'user-1',
        getItem: () => itemFetchPromise,
        appName: () => 'SlopTank test',
        appVersion: () => '1.0',
        deviceName: () => 'Vitest',
        deviceId: () => 'vitest-device',
        accessToken: () => 'secret-token-must-not-be-uploaded'
    };
}

function installSdkRouteAdapter({ failDeliveries = 0, holdFirst = false } = {}) {
    let failuresRemaining = failDeliveries;
    let releaseFirstRequest;
    let firstRequestStarted;
    const firstRequestReady = new Promise(resolve => {
        firstRequestStarted = resolve;
    });
    axios.defaults.adapter = async config => {
        const body = typeof config.data?.text === 'function' ? await config.data.text() : String(config.data || '');
        uploadedRequests.push({
            url: config.url,
            method: config.method,
            contentType: config.headers?.['Content-Type'],
            authorizationPresent: Boolean(config.headers?.Authorization || config.headers?.authorization),
            body
        });
        if (holdFirst && uploadedRequests.length === 1) {
            firstRequestStarted();
            await new Promise(resolve => {
                releaseFirstRequest = resolve;
            });
        }
        if (failuresRemaining > 0) {
            failuresRemaining--;
            throw Object.assign(new Error('local test transport failure'), { status: 503 });
        }
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    return {
        firstRequestReady,
        releaseFirstRequest: () => releaseFirstRequest?.()
    };
}

function readStoredState() {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
}

function videoElement() {
    return {
        readyState: 2,
        networkState: 1,
        currentTime: 12.5,
        error: { code: 3 },
        buffered: { length: 1, start: () => 10, end: () => 18 },
        seekable: { length: 1, start: () => 0, end: () => 300 }
    };
}

function makeHangingLauncher(stage) {
    let resolveBlockedOperation;
    const blockedOperation = new Promise(resolve => {
        resolveBlockedOperation = resolve;
    });
    const player = {
        isLocalPlayer: true,
        getDeviceProfile: () => Promise.resolve({}),
        play: () => stage === 'player-play' ? blockedOperation : Promise.resolve()
    };
    const mediaSource = {
        Id: 'source-1',
        Container: 'mkv',
        MediaStreams: [],
        DefaultAudioStreamIndex: -1,
        DefaultSubtitleStreamIndex: -1
    };
    const apiClient = Object.assign(offlineApiClient(Promise.resolve()), {
        getCurrentUser: () => Promise.resolve({ Configuration: {} })
    });
    const context = {
        manager: { _currentPlayer: null, trackHasSecondarySubtitleSupport: () => true },
        registry: { getPlayer: () => player },
        lifecycle: { onPlaybackStarted: () => undefined, onPlaybackError: () => undefined },
        serverConnections: { getApiClient: () => apiClient },
        mediaSource: {
            getPlaybackMediaSource: () => stage === 'playback-info' ? blockedOperation : Promise.resolve(mediaSource)
        },
        state: { getPlayerData: () => ({}) },
        streamInfo: { createStreamInfo: () => ({ playMethod: 'DirectPlay' }) },
        showPlaybackError: () => undefined
    };
    const launcher = createPlaybackLauncher(context);
    const item = {
        Id: `item-${stage}`,
        ServerId: SERVER_ID,
        MediaType: 'Video',
        Type: 'Movie',
        MediaStreams: [{ Type: 'Video', Index: 0 }]
    };
    const startupTraceId = beginPlaybackStartupTrace({ itemId: item.Id, serverId: SERVER_ID, apiClient, stage: 'player-choice' });
    const playback = launcher.playAfterBitrateDetect(1000000, item, {
        startupTraceId,
        items: [item],
        startPositionTicks: 0
    }, () => undefined);
    return { playback, startupTraceId, resolveBlockedOperation };
}

describe('playback startup trace recovery', () => {
    beforeEach(() => {
        setPlaybackStartupTraceDeliveryJournalForTest(createBoundaryJournal());
    });

    afterEach(() => {
        axios.defaults.adapter = ORIGINAL_AXIOS_ADAPTER;
        uploadedRequests.length = 0;
    });

    afterEach(() => {
        setRouteSearchOverride(null);
        sessionStorage.clear();
        setPlaybackStartupTraceDeliveryJournalForTest(null);
        vi.useRealTimers();
    });

    it('preserves the item-fetch incident for authenticated replay after the 30-second watchdog', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const itemId = 'item-hung-before-play-options';
        setRouteSearchOverride(`?id=${itemId}&serverId=${SERVER_ID}`);
        ServerConnections.addApiClient(offlineApiClient(new Promise(() => undefined)));

        const resume = createPermalinkResume({
            setPermalinkPreparing: () => undefined,
            canonicalizeVideoRoute: () => undefined,
            playbackManager: {
                getCurrentPlayer: () => null,
                canPlay: () => true,
                play: () => Promise.resolve(),
                pause: () => Promise.resolve(),
                unpause: () => Promise.resolve(),
                paused: () => false
            }
        });

        resume.resume();
        await vi.advanceTimersByTimeAsync(30_000);

        const stored = readStoredState();
        expect(stored, 'a hung getItem() must leave a reload-surviving incident').toMatchObject({
            version: 1,
            incidents: [
                expect.objectContaining({
                    itemId,
                    status: 'incident',
                    pendingStage: 'item-fetch',
                    mediaSnapshot: {}
                })
            ]
        });

        const persistedAttemptId = stored.incidents[0].attemptId;
        Events.trigger(ServerConnections, 'localusersignedin', [{ ServerId: SERVER_ID }]);
        await vi.waitFor(() => expect(uploadedRequests).toHaveLength(1));
        expect(JSON.parse(uploadedRequests[0].body)).toMatchObject({
            attemptId: persistedAttemptId,
            status: 'incident',
            pendingStage: 'item-fetch'
        });
    });

    it.each(['playback-info', 'player-play'])('captures a permanently pending production launcher stage: %s', async stage => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const apiClient = offlineApiClient(Promise.resolve());
        ServerConnections.addApiClient(apiClient);
        const { playback, startupTraceId } = makeHangingLauncher(stage);
        recordPlaybackStartupTrace(startupTraceId, 'osd-ready', { outcome: 'visible' });
        recordPlaybackStartupTrace(startupTraceId, 'stalled', {
            event: 'stalled',
            requestKind: 'video',
            httpStatus: 'unknown'
        });

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(uploadedRequests).toHaveLength(1));

        expect(JSON.parse(uploadedRequests[0].body)).toMatchObject({
            attemptId: startupTraceId,
            status: 'incident',
            pendingStage: stage
        });
        expect(readStoredState().incidents[0]).toMatchObject({ status: 'incident', pendingStage: stage });
        void playback;
    });

    it('persists pagehide abandonment and replays it after the authenticated sign-in event', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const apiClient = offlineApiClient(Promise.resolve());
        ServerConnections.addApiClient(apiClient);
        const attemptId = beginPlaybackStartupTrace({ itemId: 'item-reload', serverId: SERVER_ID, apiClient, stage: 'playback-info' });

        window.dispatchEvent(new Event('pagehide'));
        expect(readStoredState().incidents[0]).toMatchObject({ status: 'abandoned', pendingStage: 'playback-info' });

        Events.trigger(ServerConnections, 'localusersignedin', [{ ServerId: SERVER_ID }]);
        await vi.waitFor(() => expect(uploadedRequests).toHaveLength(1));

        expect(uploadedRequests[0]).toMatchObject({ url: 'https://jellyfin.test.invalid/ClientLog/Document', method: 'post' });
        expect(uploadedRequests[0]).toMatchObject({ contentType: 'text/plain', authorizationPresent: true });
        expect(uploadedRequests[0].body).toContain(attemptId);
        expect(uploadedRequests[0].body).not.toContain('secret-token-must-not-be-uploaded');
        expect(JSON.parse(uploadedRequests[0].body)).toMatchObject({ status: 'abandoned', pendingStage: 'playback-info' });
        expect(JSON.parse(uploadedRequests[0].body).events).toEqual(expect.arrayContaining([
            expect.objectContaining({ stage: 'pagehide', outcome: 'abandoned' })
        ]));
    });

    it('does not resend an acknowledged phase when a replaced document restores a stale session mirror', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const apiClient = offlineApiClient(Promise.resolve());
        beginPlaybackStartupTrace({ itemId: 'item-stale-realm', serverId: SERVER_ID, apiClient, stage: 'item-fetch' });
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(uploadedRequests).toHaveLength(1));

        const stale = readStoredState();
        const phaseState = stale.incidents[0].phaseState.incident;
        phaseState.deliveries = 0;
        phaseState.acknowledged = false;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stale));

        await flushPendingPlaybackStartupTraces(apiClient);

        expect(uploadedRequests).toHaveLength(1);
        expect(readStoredState().incidents[0].phaseState.incident).toEqual({ deliveries: 1, acknowledged: true });
    });

    it('drains a new pagehide/auth trigger after an older upload settles without retrying its failed phase', async () => {
        vi.useFakeTimers();
        const adapter = installSdkRouteAdapter({ holdFirst: true });
        const apiClient = offlineApiClient(Promise.resolve());
        const oldAttempt = beginPlaybackStartupTrace({ itemId: 'item-old-upload', serverId: SERVER_ID, apiClient, stage: 'playback-info' });
        await vi.advanceTimersByTimeAsync(30_000);
        await adapter.firstRequestReady;
        recordPlaybackStartupTrace(oldAttempt, 'stalled', { event: 'stalled', requestKind: 'video' });

        const newAttempt = beginPlaybackStartupTrace({ itemId: 'item-new-pagehide', serverId: SERVER_ID, apiClient, stage: 'player-play' });
        window.dispatchEvent(new Event('pagehide'));
        Events.trigger(ServerConnections, 'localusersignedin', [{ ServerId: SERVER_ID }]);
        adapter.releaseFirstRequest();

        await vi.waitFor(() => expect(uploadedRequests).toHaveLength(2));
        const payloads = uploadedRequests.map(request => JSON.parse(request.body));
        expect(payloads.filter(payload => payload.attemptId === oldAttempt)).toHaveLength(1);
        expect(payloads.find(payload => payload.attemptId === newAttempt)).toMatchObject({
            status: 'abandoned',
            pendingStage: 'player-play'
        });
        const storedOldAttempt = readStoredState().incidents.find(record => record.attemptId === oldAttempt);
        expect(storedOldAttempt.phaseState.incident.acknowledged).toBe(true);
        expect(storedOldAttempt.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ stage: 'stalled', event: 'stalled' })
        ]));
    });

    it('captures media state and rejects unapproved fields before the incident upload', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const apiClient = offlineApiClient(Promise.resolve());
        const attemptId = beginPlaybackStartupTrace({ itemId: 'item-media-snapshot', serverId: SERVER_ID, apiClient, stage: 'playback-info' });
        recordPlaybackStartupTrace(attemptId, 'playback-info', {
            outcome: 'begin',
            requestKind: 'playback-info',
            url: 'http://bad.test/video?api_key=secret',
            query: '?api_key=secret',
            authorization: 'secret-token-must-not-be-uploaded',
            rawError: 'private failure detail'
        }, videoElement());

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(uploadedRequests).toHaveLength(1));

        const body = JSON.parse(uploadedRequests[0].body);
        expect(body).toMatchObject({
            attemptId,
            pendingStage: 'playback-info',
            mediaSnapshot: {
                mediaReadyState: 2,
                mediaNetworkState: 1,
                currentTime: 12.5,
                mediaErrorCode: 3,
                buffered: [{ start: 10, end: 18 }],
                seekable: [{ start: 0, end: 300 }]
            }
        });
        expect(uploadedRequests[0].body).not.toMatch(/api_key|secret-token|private failure|bad\.test/);
        expect(new Blob([uploadedRequests[0].body]).size).toBeLessThanOrEqual(32768);
    });

    it('bounds uncertain SDK deliveries to two attempts and retains the exhausted marker', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter({ failDeliveries: 2 });
        const apiClient = offlineApiClient(Promise.resolve());
        const attemptId = beginPlaybackStartupTrace({ itemId: 'item-failed-upload', serverId: SERVER_ID, apiClient, stage: 'item-fetch' });
        await vi.advanceTimersByTimeAsync(30_000);
        await flushPendingPlaybackStartupTraces(apiClient);
        await vi.advanceTimersByTimeAsync(1000);
        await flushPendingPlaybackStartupTraces(apiClient);
        await flushPendingPlaybackStartupTraces(apiClient);

        expect(uploadedRequests).toHaveLength(2);
        expect(uploadedRequests.map(request => JSON.parse(request.body))).toEqual([
            expect.objectContaining({ attemptId, phase: 'incident', deliveryOrdinal: 1 }),
            expect.objectContaining({ attemptId, phase: 'incident', deliveryOrdinal: 2 })
        ]);
        expect(readStoredState().incidents[0].phaseState.incident).toEqual({ deliveries: 2, acknowledged: false });
    });

    it('refuses upload when the incremented delivery marker cannot be read back from storage', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const apiClient = offlineApiClient(Promise.resolve());
        const attemptId = beginPlaybackStartupTrace({ itemId: 'item-storage-write-failure', serverId: SERVER_ID, stage: 'item-fetch' });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(readStoredState().incidents[0]).toMatchObject({ attemptId, status: 'incident' });

        const storedState = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
        delete storedState.incidents[0].mediaSnapshot;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storedState));
        const quotaFillKey = 'playback-startup-trace-quota-fill';
        const currentStorageUsage = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
            .reduce((total, key) => total + key.length + sessionStorage.getItem(key).length, 0);
        const remainingStorageQuota = 5_000_000 - currentStorageUsage - quotaFillKey.length;
        expect(remainingStorageQuota).toBeGreaterThan(0);
        sessionStorage.setItem(quotaFillKey, 'x'.repeat(remainingStorageQuota));
        expect(() => sessionStorage.setItem(quotaFillKey, 'x'.repeat(remainingStorageQuota + 1)))
            .toThrow(expect.objectContaining({ name: 'QuotaExceededError' }));
        expect(readStoredState().incidents[0]).toMatchObject({ attemptId, status: 'incident' });

        await expect(flushPendingPlaybackStartupTraces(apiClient)).resolves.toBeUndefined();
        await expect(flushPendingPlaybackStartupTraces(apiClient)).resolves.toBeUndefined();
        expect(uploadedRequests).toEqual([]);
        expect(readStoredState().incidents[0].phaseState.incident).toEqual({ deliveries: 0, acknowledged: false });
    });

    it('keeps pending uploads ahead of later fast completions and retires per-attempt references', async () => {
        vi.useFakeTimers();
        const pending = [
            beginPlaybackStartupTrace({ itemId: 'pending-one', serverId: SERVER_ID, stage: 'item-fetch' }),
            beginPlaybackStartupTrace({ itemId: 'pending-two', serverId: SERVER_ID, stage: 'playback-info' })
        ];
        await vi.advanceTimersByTimeAsync(30_000);
        const completed = [];
        for (let index = 0; index < 6; index++) {
            const attemptId = beginPlaybackStartupTrace({ itemId: `cancel-${index}`, serverId: SERVER_ID, stage: 'player-play' });
            completed.push(attemptId);
            completePlaybackStartupTrace(attemptId, 'firstvideoframe', videoElement());
        }

        const state = readStoredState();
        expect(state.incidents).toHaveLength(4);
        expect(state.incidents.filter(record => record.status === 'incident').map(record => record.attemptId)).toEqual(pending);
        expect(state.incidents.filter(record => record.status === 'complete').map(record => record.attemptId)).toEqual(completed.slice(-2));
        expect(playbackStartupTraceMemoryStatsForTest()).toEqual({
            timers: 0,
            monotonicStarts: 2,
            apiClients: 0,
            queuedFlushApiClients: 0
        });
    });

    it('caps memory and storage ownership at four uploadable incidents after repeated watchdogs', async () => {
        vi.useFakeTimers();
        const attempts = [];
        for (let index = 0; index < 7; index++) {
            attempts.push(beginPlaybackStartupTrace({ itemId: `pending-${index}`, serverId: SERVER_ID, stage: 'item-fetch' }));
            await vi.advanceTimersByTimeAsync(30_000);
        }

        const state = readStoredState();
        expect(state.incidents).toHaveLength(4);
        expect(state.incidents.map(record => record.attemptId)).toEqual(attempts.slice(-4));
        expect(state.incidents.every(record => record.status === 'incident')).toBe(true);
        expect(playbackStartupTraceMemoryStatsForTest()).toEqual({
            timers: 0,
            monotonicStarts: 4,
            apiClients: 0,
            queuedFlushApiClients: 0
        });
    });

    it('reserves one bounded record for a new active start while retaining three older pending uploads', async () => {
        vi.useFakeTimers();
        const pending = [];
        for (let index = 0; index < 4; index++) {
            pending.push(beginPlaybackStartupTrace({ itemId: `older-pending-${index}`, serverId: SERVER_ID, stage: 'item-fetch' }));
            await vi.advanceTimersByTimeAsync(30_000);
        }

        const active = beginPlaybackStartupTrace({ itemId: 'new-active-start', serverId: SERVER_ID, stage: 'player-play' });
        const records = readStoredState().incidents;
        expect(records).toHaveLength(4);
        expect(records.map(record => record.attemptId)).toEqual([...pending.slice(-3), active]);
        expect(records.at(-1)).toMatchObject({ status: 'starting', pendingStage: 'player-play' });
        expect(playbackStartupTraceMemoryStatsForTest()).toEqual({
            timers: 1,
            monotonicStarts: 4,
            apiClients: 0,
            queuedFlushApiClients: 0
        });
    });

    it('drops fast successful starts without uploading routine traces', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const apiClient = offlineApiClient(Promise.resolve());
        const attemptId = beginPlaybackStartupTrace({ itemId: 'item-fast', serverId: SERVER_ID, apiClient, stage: 'player-play' });
        recordPlaybackStartupTrace(attemptId, 'player-play', { outcome: 'resolved' });
        completePlaybackStartupTrace(attemptId, 'firstvideoframe', videoElement());
        await flushPendingPlaybackStartupTraces(apiClient);
        await vi.advanceTimersByTimeAsync(30_000);

        expect(readStoredState().incidents).toHaveLength(1);
        expect(readStoredState().incidents[0]).toMatchObject({ attemptId, status: 'complete', phaseState: {} });
        expect(uploadedRequests).toEqual([]);
    });

    it('uploads one late completion phase after an incident and completes on paused-ready', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter();
        const apiClient = offlineApiClient(Promise.resolve());
        const attemptId = beginPlaybackStartupTrace({ itemId: 'item-late-ready', serverId: SERVER_ID, apiClient, stage: 'player-play' });
        await vi.advanceTimersByTimeAsync(30_000);
        recordPlaybackStartupTrace(attemptId, 'videoready', { outcome: 'resolved' }, videoElement());
        completePlaybackStartupTrace(attemptId, 'videoready', videoElement());
        await vi.waitFor(() => expect(uploadedRequests).toHaveLength(2));

        expect(uploadedRequests.map(request => JSON.parse(request.body).phase)).toEqual(['incident', 'completion']);
        expect(JSON.parse(uploadedRequests[1].body)).toMatchObject({ pendingStage: 'player-play' });
    });

    it('caps incident and completion phases at two SDK dispatches each', async () => {
        vi.useFakeTimers();
        installSdkRouteAdapter({ failDeliveries: 4 });
        const apiClient = offlineApiClient(Promise.resolve());
        const attemptId = beginPlaybackStartupTrace({ itemId: 'item-four-deliveries', serverId: SERVER_ID, apiClient, stage: 'player-play' });
        await vi.advanceTimersByTimeAsync(30_000);
        recordPlaybackStartupTrace(attemptId, 'firstvideoframe', { outcome: 'resolved' });
        completePlaybackStartupTrace(attemptId, 'firstvideoframe');

        await flushPendingPlaybackStartupTraces(apiClient);
        await vi.advanceTimersByTimeAsync(1000);
        for (let i = 0; i < 3; i++) await flushPendingPlaybackStartupTraces(apiClient);

        expect(uploadedRequests).toHaveLength(4);
        const payloads = uploadedRequests.map(request => JSON.parse(request.body));
        expect(payloads.map(({ phase, deliveryOrdinal }) => `${phase}:${deliveryOrdinal}`).sort((left, right) => left.localeCompare(right))).toEqual([
            'completion:1', 'completion:2', 'incident:1', 'incident:2'
        ]);
        expect(payloads.every(payload => payload.attemptId === attemptId)).toBe(true);
        expect(readStoredState().incidents[0].phaseState).toEqual({
            incident: { deliveries: 2, acknowledged: false },
            completion: { deliveries: 2, acknowledged: false }
        });
    });

    it('keeps overlapping traces and cancellation attribution separate', () => {
        const first = beginPlaybackStartupTrace({ itemId: 'item-first', serverId: SERVER_ID, stage: 'player-play' });
        const second = beginPlaybackStartupTrace({ itemId: 'item-second', serverId: SERVER_ID, stage: 'playback-info' });
        recordPlaybackStartupTrace(first, 'player-play', { outcome: 'begin' });
        recordPlaybackStartupTrace(second, 'playback-info', { outcome: 'begin', httpStatus: 500 });
        cancelPlaybackStartupTrace(first, 'item-switch');

        expect(readStoredState().incidents).toEqual([
            expect.objectContaining({ attemptId: first, itemId: 'item-first', status: 'cancelled' }),
            expect.objectContaining({ attemptId: second, itemId: 'item-second', status: 'starting', pendingStage: 'playback-info' })
        ]);
    });

    it('does not throw or change the playback promise when session storage is unavailable', () => {
        const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
        Object.defineProperty(window, 'sessionStorage', {
            configurable: true,
            get: () => { throw new Error('storage denied'); }
        });

        expect(() => {
            const attemptId = beginPlaybackStartupTrace({ itemId: 'item-no-storage', serverId: SERVER_ID, stage: 'item-fetch' });
            recordPlaybackStartupTrace(attemptId, 'item-fetch', { outcome: 'begin' });
            completePlaybackStartupTrace(attemptId, 'firstvideoframe');
        }).not.toThrow();

        Object.defineProperty(window, 'sessionStorage', descriptor);
    });
});
