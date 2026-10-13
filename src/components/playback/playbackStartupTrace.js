// SlopTank modification notice: added or changed by SlopTank on 2026-10-12.
/**
 * Owns the bounded, reload-surviving video-startup trace, its session storage,
 * and its authenticated Jellyfin client-log upload boundary.
 * @module playbackStartupTrace
 */
import { getClientLogApi } from '@jellyfin/sdk/lib/utils/api/client-log-api';

import { currentTimeMs } from '../../utils/clock';
import { randomId } from '../../utils/random.ts';
import { toApi } from '../../utils/jellyfin-apiclient/compat';
import {
    acknowledgePlaybackStartupDelivery,
    claimPlaybackStartupDelivery,
    failPlaybackStartupDelivery,
    readPlaybackStartupDeliveryMirrors,
    serializePlaybackStartupDelivery
} from './playbackStartupTraceDeliveryJournal';

const STORAGE_KEY = 'sloptank.playbackStartupTrace.v1';
const SCHEMA_VERSION = 1;
const MAX_EVENTS = 32;
const MAX_INCIDENTS = 4;
const MAX_INCIDENT_BYTES = 32768;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WATCHDOG_MS = 30 * 1000;
const MAX_DELIVERIES_PER_PHASE = 2;
const UPLOAD_TIMEOUT_MS = 20_000;

const ALLOWED_STAGES = new Set([
    'route', 'item-fetch', 'translate-items', 'additional-parts', 'intro-lookup',
    'preplay-interceptors', 'bitrate', 'player-choice', 'device-profile',
    'current-user', 'media-streams', 'playback-info', 'stream-info', 'player-play', 'playback-start',
    'create-media-element', 'update-video-url', 'set-current-src', 'osd-preparing',
    'osd-ready', 'firstvideoframe', 'videoready', 'pagehide', 'cancelled',
    'loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled',
    'seeked', 'error', 'abort'
]);
const ALLOWED_OUTCOMES = new Set(['begin', 'resolved', 'rejected', 'visible', 'hidden', 'abandoned', 'cancelled', 'complete']);
const ALLOWED_MEDIA_EVENTS = new Set([
    'loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled',
    'seeked', 'error', 'abort', 'firstvideoframe', 'videoready'
]);
const OBSERVATIONAL_STAGES = new Set([...ALLOWED_MEDIA_EVENTS, 'osd-preparing', 'osd-ready', 'pagehide']);
const ALLOWED_REQUEST_KINDS = new Set(['playback-info', 'video', 'subtitle']);
const ALLOWED_STATUSES = new Set(['starting', 'incident', 'abandoned', 'complete', 'cancelled']);
const ALLOWED_CANCEL_REASONS = new Set(['cancelled', 'item-switch', 'superseded']);
const ALLOWED_PLAY_METHODS = new Set(['DirectPlay', 'DirectStream', 'Transcode', 'Remux']);
const ALLOWED_FIELDS = new Set([
    'outcome', 'mediaSourceId', 'container', 'playMethod', 'audioStreamIndex',
    'subtitleStreamIndex', 'httpStatus', 'requestKind', 'mediaErrorCode',
    'mediaReadyState', 'mediaNetworkState', 'currentTime', 'buffered', 'seekable',
    'event', 'resourceDurationMs', 'resourceTransferSize'
]);

const timers = new Map();
const monotonicStarts = new Map();
const apiClients = new Map();
const queuedFlushApiClients = new Map();
const retryWakeups = new Map();
const documentEpoch = randomId();
let eventCounter = 0;
let flushInFlight;
let lifecycleListenersBound = false;
let deliveryJournal = {
    acknowledgeDelivery: acknowledgePlaybackStartupDelivery,
    claimDelivery: claimPlaybackStartupDelivery,
    readDeliveryMirrors: readPlaybackStartupDeliveryMirrors,
    recordDeliveryFailure: failPlaybackStartupDelivery
};

const defaultDeliveryJournal = deliveryJournal;

function getSessionStorage() {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

function emptyState() {
    return { version: SCHEMA_VERSION, incidents: [] };
}

function cleanupAttemptMemory(attemptId) {
    const timer = timers.get(attemptId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(attemptId);
    monotonicStarts.delete(attemptId);
    apiClients.delete(attemptId);
}

function clearAttemptTimer(attemptId) {
    const timer = timers.get(attemptId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(attemptId);
}

function reconcileAttemptMemory(incidents) {
    const retained = new Map(incidents.map(record => [record.attemptId, record]));
    for (const attemptId of timers.keys()) {
        if (retained.get(attemptId)?.status !== 'starting') clearAttemptTimer(attemptId);
    }
    for (const attemptId of monotonicStarts.keys()) {
        const record = retained.get(attemptId);
        if (!record || (record.status !== 'starting' && record.status !== 'incident')) monotonicStarts.delete(attemptId);
    }
    for (const attemptId of apiClients.keys()) {
        const record = retained.get(attemptId);
        if (!record || (record.status !== 'starting' && record.status !== 'incident'
            && !(record.status === 'complete' && hasPendingUpload(record)))) apiClients.delete(attemptId);
    }
    for (const serverId of queuedFlushApiClients.keys()) {
        if (!incidents.some(record => record.serverId === serverId && hasPendingUpload(record))) {
            queuedFlushApiClients.delete(serverId);
        }
    }
    while (queuedFlushApiClients.size > MAX_INCIDENTS) {
        queuedFlushApiClients.delete(queuedFlushApiClients.keys().next().value);
    }
    const retainedPhases = new Map();
    for (const record of incidents) {
        for (const phase of record.status === 'complete' ? ['incident', 'completion'] : ['incident']) {
            const phaseState = record.phaseState[phase];
            if (phaseState && !phaseState.acknowledged && phaseState.deliveries < MAX_DELIVERIES_PER_PHASE) {
                retainedPhases.set(phaseWakeupKey(record.serverId, record.attemptId, phase), true);
            }
        }
    }
    for (const [key, wakeup] of retryWakeups) {
        if (!retainedPhases.has(key)) {
            clearTimeout(wakeup.timer);
            retryWakeups.delete(key);
        }
    }
}

function utf8Size(value) {
    return new Blob([value]).size;
}

function boundedString(value, maxLength = 128) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && /^[A-Za-z0-9_.+-]+$/.test(value) ? value : undefined;
}

function finiteNumber(value, minimum = 0) {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : undefined;
}

function rangeSummary(ranges) {
    if (!ranges || typeof ranges.length !== 'number') return undefined;
    const count = Math.min(ranges.length, 4);
    const summary = [];
    for (let index = 0; index < count; index++) {
        const start = finiteNumber(ranges.start(index));
        const end = finiteNumber(ranges.end(index));
        if (start !== undefined && end !== undefined) summary.push({ start, end });
    }
    return summary;
}

function sanitizeFields(fields = {}) {
    const safe = {};
    for (const key of ALLOWED_FIELDS) {
        const value = fields[key];
        if (value === undefined || value === null) continue;
        if (key === 'outcome') {
            if (ALLOWED_OUTCOMES.has(value)) safe[key] = value;
        } else if (key === 'event') {
            if (ALLOWED_MEDIA_EVENTS.has(value)) safe[key] = value;
        } else if (key === 'requestKind') {
            if (ALLOWED_REQUEST_KINDS.has(value)) safe[key] = value;
        } else if (key === 'mediaSourceId' || key === 'container' || key === 'playMethod') {
            if (key === 'playMethod') {
                if (ALLOWED_PLAY_METHODS.has(value)) safe[key] = value;
            } else {
                const text = boundedString(value, 64);
                if (text) safe[key] = text;
            }
        } else if (key === 'httpStatus') {
            safe[key] = value === 'unknown' ? 'unknown' : finiteNumber(value, 100);
        } else if (key === 'currentTime' || key === 'resourceDurationMs' || key === 'resourceTransferSize') {
            safe[key] = finiteNumber(value);
        } else if (key === 'audioStreamIndex' || key === 'subtitleStreamIndex') {
            if (Number.isInteger(value) && value >= -1) safe[key] = value;
        } else if (key === 'mediaErrorCode' || key === 'mediaReadyState' || key === 'mediaNetworkState') {
            if (Number.isInteger(value) && value >= 0) safe[key] = value;
        } else if (key === 'buffered' || key === 'seekable') {
            if (Array.isArray(value)) {
                safe[key] = value.slice(0, 4).flatMap(range => {
                    const start = finiteNumber(range?.start);
                    const end = finiteNumber(range?.end);
                    return start !== undefined && end !== undefined ? [{ start, end }] : [];
                });
            }
        }
    }
    return safe;
}

function readState() {
    const storage = getSessionStorage();
    if (!storage) {
        reconcileAttemptMemory([]);
        return emptyState();
    }
    const state = parseStoredState(storage.getItem(STORAGE_KEY));
    reconcileAttemptMemory(state.incidents);
    return state;
}

function parseStoredState(serialized) {
    try {
        const saved = JSON.parse(serialized || 'null');
        if (saved?.version !== SCHEMA_VERSION || !Array.isArray(saved.incidents)) return emptyState();
        const oldest = currentTimeMs() - RETENTION_MS;
        const incidents = saved.incidents.flatMap(record => {
            const startedAtMs = Date.parse(record?.startedAt || '');
            if (!Number.isFinite(startedAtMs) || startedAtMs < oldest || !boundedString(record?.attemptId, 64)
                || !ALLOWED_STATUSES.has(record.status) || !ALLOWED_STAGES.has(record.pendingStage)) return [];
            const phaseState = {};
            for (const phase of ['incident', 'completion']) {
                const savedPhase = record.phaseState?.[phase];
                if (savedPhase && Number.isInteger(savedPhase.deliveries) && savedPhase.deliveries >= 0) {
                    phaseState[phase] = {
                        deliveries: Math.min(savedPhase.deliveries, MAX_DELIVERIES_PER_PHASE),
                        acknowledged: savedPhase.acknowledged === true
                    };
                }
            }
            const events = Array.isArray(record.events) ? record.events.flatMap((event, index) => {
                if (!ALLOWED_STAGES.has(event?.stage)) return [];
                const elapsedMs = finiteNumber(event.elapsedMs);
                if (elapsedMs === undefined) return [];
                const eventDocumentEpoch = boundedString(event.documentEpoch, 64) ? event.documentEpoch : 'legacy';
                const savedEventCounter = Number.isSafeInteger(event.eventCounter) && event.eventCounter >= 0 ? event.eventCounter : index;
                const recordedAtMs = finiteNumber(event.recordedAtMs) ?? (startedAtMs + elapsedMs);
                const eventSnapshot = event.mediaSnapshot && typeof event.mediaSnapshot === 'object' ?
                    sanitizeFields(event.mediaSnapshot) : undefined;
                return [{
                    stage: event.stage,
                    elapsedMs,
                    documentEpoch: eventDocumentEpoch,
                    eventCounter: savedEventCounter,
                    recordedAtMs,
                    ...(eventSnapshot ? { mediaSnapshot: eventSnapshot } : {}),
                    ...sanitizeFields(event)
                }];
            }).slice(-MAX_EVENTS) : [];
            return [{
                attemptId: record.attemptId,
                version: SCHEMA_VERSION,
                startedAt: new Date(startedAtMs).toISOString(),
                itemId: boundedString(record.itemId),
                serverId: boundedString(record.serverId),
                status: record.status,
                pendingStage: record.pendingStage,
                events,
                phaseState,
                mediaSnapshot: sanitizeFields(record.mediaSnapshot),
                ...(ALLOWED_CANCEL_REASONS.has(record.cancelReason) ? { cancelReason: record.cancelReason } : {})
            }];
        });
        return { version: SCHEMA_VERSION, incidents: retainIncidents(incidents) };
    } catch {
        return emptyState();
    }
}

function trimIncident(record) {
    while (utf8Size(JSON.stringify(record)) > MAX_INCIDENT_BYTES && record.events.length) {
        record.events.shift();
    }
    return record;
}

function retainIncidents(incidents) {
    const protectedRecords = incidents.filter(record => record.status === 'starting' || hasPendingUpload(record));
    const nonUploadable = incidents.filter(record => record.status !== 'starting' && !hasPendingUpload(record));
    const retainedProtected = protectedRecords.slice(-MAX_INCIDENTS);
    if (protectedRecords.length > retainedProtected.length) {
        // The schema has a hard four-record cap; retain the newest uploadable
        // incidents and active starts deterministically; expose overflow without IDs.
        console.warn('[PlaybackStartupTrace] protected trace retention cap reached');
    }
    const retainedIds = new Set(retainedProtected.map(record => record.attemptId));
    const available = MAX_INCIDENTS - retainedProtected.length;
    const retainedOther = available > 0 ? nonUploadable.slice(-available) : [];
    for (const record of retainedOther) retainedIds.add(record.attemptId);
    return incidents.filter(record => retainedIds.has(record.attemptId)).map(trimIncident);
}

function writeState(state) {
    const storage = getSessionStorage();
    if (!storage) return false;
    let candidate = state;
    for (let pass = 0; pass < 3; pass++) {
        try {
            candidate = mergeStates(parseStoredState(storage.getItem(STORAGE_KEY)), candidate);
            candidate.incidents = retainIncidents(candidate.incidents);
            const serialized = JSON.stringify(candidate);
            storage.setItem(STORAGE_KEY, serialized);
            const readback = storage.getItem(STORAGE_KEY);
            if (readback === serialized) {
                reconcileAttemptMemory(candidate.incidents);
                return true;
            }
            candidate = mergeStates(parseStoredState(readback), candidate);
        } catch {
            // allow-silent-catch: bounded storage retry continues; writeState returns false unless a later write and exact readback succeed
            // Retry one bounded re-read/merge cycle after storage races or quota
            // failures; diagnostic storage never rejects playback work.
        }
    }
    return false;
}

const STATUS_PRECEDENCE = new Map([
    ['starting', 0], ['abandoned', 1], ['incident', 2], ['complete', 3], ['cancelled', 4]
]);

function compareEvents(left, right) {
    return left.recordedAtMs - right.recordedAtMs
        || left.documentEpoch.localeCompare(right.documentEpoch)
        || left.eventCounter - right.eventCounter;
}

function eventIdentity(event) {
    return `${event.documentEpoch}:${event.eventCounter}`;
}

function mergePhaseStates(left = {}, right = {}) {
    const result = {};
    for (const phase of ['incident', 'completion']) {
        const a = left[phase];
        const b = right[phase];
        if (!a && !b) continue;
        result[phase] = {
            deliveries: Math.max(a?.deliveries || 0, b?.deliveries || 0),
            acknowledged: a?.acknowledged === true || b?.acknowledged === true
        };
    }
    return result;
}

function mergeRecords(latest, candidate) {
    if (!latest) return candidate;
    if (!candidate) return latest;
    const byIdentity = new Map();
    for (const event of [...latest.events, ...candidate.events]) byIdentity.set(eventIdentity(event), event);
    const events = Array.from(byIdentity.values()).sort(compareEvents).slice(-MAX_EVENTS);
    const operationEvents = events.filter(event => !OBSERVATIONAL_STAGES.has(event.stage));
    const latestOperation = operationEvents[operationEvents.length - 1];
    const newestMedia = events.slice().reverse().find(event => event.mediaSnapshot);
    const candidatePrecedence = STATUS_PRECEDENCE.get(candidate.status);
    const latestPrecedence = STATUS_PRECEDENCE.get(latest.status);
    const status = candidatePrecedence > latestPrecedence ? candidate.status : latest.status;
    return {
        ...latest,
        ...candidate,
        startedAt: latest.startedAt,
        status,
        pendingStage: latestOperation?.stage || latest.pendingStage,
        events,
        phaseState: mergePhaseStates(latest.phaseState, candidate.phaseState),
        mediaSnapshot: newestMedia?.mediaSnapshot || candidate.mediaSnapshot || latest.mediaSnapshot || {}
    };
}

function mergeStates(latest, candidate) {
    const byAttempt = new Map();
    for (const record of latest.incidents) byAttempt.set(record.attemptId, record);
    for (const record of candidate.incidents) {
        byAttempt.set(record.attemptId, mergeRecords(byAttempt.get(record.attemptId), record));
    }
    return { version: SCHEMA_VERSION, incidents: retainIncidents(Array.from(byAttempt.values())) };
}

function findAttempt(state, attemptId) {
    return state.incidents.find(record => record.attemptId === attemptId);
}

function appendEvent(record, stage, fields = {}, updatePendingStage = true) {
    if (!ALLOWED_STAGES.has(stage)) return;
    const event = {
        stage,
        elapsedMs: Math.max(0, Math.round(monotonicNow() - (monotonicStarts.get(record.attemptId) ?? monotonicNow()))),
        documentEpoch,
        eventCounter: ++eventCounter,
        recordedAtMs: currentTimeMs(),
        ...sanitizeFields(fields)
    };
    if (updatePendingStage) record.pendingStage = stage;
    record.events.push(event);
    if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
    return event;
}

function monotonicNow() {
    try {
        return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : currentTimeMs();
    } catch {
        return currentTimeMs();
    }
}

function mediaSnapshot(element) {
    if (!element) return {};
    const snapshot = {
        mediaReadyState: finiteNumber(element.readyState),
        mediaNetworkState: finiteNumber(element.networkState),
        currentTime: finiteNumber(element.currentTime),
        buffered: rangeSummary(element.buffered),
        seekable: rangeSummary(element.seekable)
    };
    if (Number.isInteger(element.error?.code) && element.error.code >= 0) {
        snapshot.mediaErrorCode = element.error.code;
    }
    return sanitizeFields(snapshot);
}

function bindLifecycleListeners() {
    if (lifecycleListenersBound || typeof window === 'undefined') return;
    lifecycleListenersBound = true;
    const onPageExit = () => {
        const state = readState();
        let changed = false;
        const apiClientsToFlush = new Set();
        for (const record of state.incidents) {
            if (record.status !== 'starting') continue;
            record.status = 'abandoned';
            record.phaseState.incident ||= { deliveries: 0, acknowledged: false };
            appendEvent(record, 'pagehide', { outcome: 'abandoned' }, false);
            record.mediaSnapshot ||= {};
            changed = true;
            const timer = timers.get(record.attemptId);
            if (timer !== undefined) clearTimeout(timer);
            timers.delete(record.attemptId);
            const apiClient = apiClients.get(record.attemptId);
            if (apiClient) apiClientsToFlush.add(apiClient);
        }
        if (changed) writeState(state);
        for (const apiClient of apiClientsToFlush) void flushPendingPlaybackStartupTraces(apiClient);
    };
    window.addEventListener('pagehide', onPageExit);
    window.addEventListener('beforeunload', onPageExit);
}

function armWatchdog(attemptId) {
    const oldTimer = timers.get(attemptId);
    if (oldTimer !== undefined) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
        if (timers.get(attemptId) === timer) timers.delete(attemptId);
        const state = readState();
        const record = findAttempt(state, attemptId);
        if (!record || record.status !== 'starting') {
            cleanupAttemptMemory(attemptId);
            return;
        }
        record.status = 'incident';
        record.phaseState.incident ||= { deliveries: 0, acknowledged: false };
        appendEvent(record, record.pendingStage || 'route', { outcome: 'rejected' });
        record.mediaSnapshot ||= {};
        writeState(state);
        const apiClient = apiClients.get(attemptId);
        if (apiClient) void flushPendingPlaybackStartupTraces(apiClient);
    }, WATCHDOG_MS);
    timers.set(attemptId, timer);
}

function serializablePhaseTemplate(record, phase) {
    const body = {
        version: SCHEMA_VERSION,
        attemptId: record.attemptId,
        phase,
        startedAt: record.startedAt,
        elapsedMs: record.events[record.events.length - 1]?.elapsedMs || 0,
        ...(record.itemId ? { itemId: record.itemId } : {}),
        serverId: record.serverId,
        status: record.status,
        pendingStage: record.pendingStage,
        events: record.events.slice(-MAX_EVENTS).map(event => Object.fromEntries(Object.entries(event).filter(([key]) =>
            !['documentEpoch', 'eventCounter', 'recordedAtMs', 'mediaSnapshot'].includes(key)
        ))),
        mediaSnapshot: record.mediaSnapshot || {}
    };
    let text = JSON.stringify(body);
    while (utf8Size(text) > MAX_INCIDENT_BYTES && body.events.length) {
        body.events.shift();
        text = JSON.stringify(body);
    }
    return text;
}

async function dispatchIncident(apiClient, template, deliveryOrdinal) {
    const body = serializePlaybackStartupDelivery(template, deliveryOrdinal);
    if (utf8Size(body) > MAX_INCIDENT_BYTES) throw new Error('playback startup payload exceeded limit');
    // This generated SDK method declares File, but serializes every non-string
    // body as JSON (including Blob/File) before its text/plain POST. A string
    // preserves the exact bounded document at the actual SDK transport seam.
    return getClientLogApi(toApi(apiClient)).logFile({ body }, { timeout: UPLOAD_TIMEOUT_MS });
}

function serverIdFromApiClient(apiClient) {
    try {
        return apiClient.serverId?.() || apiClient.serverInfo?.()?.Id;
    } catch {
        return undefined;
    }
}

function hasPendingUpload(record) {
    const phases = record.status === 'complete' ? ['incident', 'completion'] : ['incident'];
    return phases.some(phase => {
        const phaseState = record.phaseState[phase];
        return phaseState && !phaseState.acknowledged && phaseState.deliveries < MAX_DELIVERIES_PER_PHASE;
    });
}

function journalInput(record, phase, payloadTemplate) {
    return {
        serverId: record.serverId,
        attemptId: record.attemptId,
        phase,
        attemptStartedAtMs: Date.parse(record.startedAt),
        payloadTemplate,
        documentEpoch
    };
}

function phaseWakeupKey(serverId, attemptId, phase) {
    return JSON.stringify([serverId, attemptId, phase]);
}

function clearDeliveryWakeup(serverId, attemptId, phase) {
    const key = phaseWakeupKey(serverId, attemptId, phase);
    const existing = retryWakeups.get(key);
    if (existing) clearTimeout(existing.timer);
    retryWakeups.delete(key);
}

function scheduleDeliveryWakeup(apiClient, record, phase, retryAtMs) {
    if (!record.serverId || !Number.isFinite(retryAtMs)) return;
    const key = phaseWakeupKey(record.serverId, record.attemptId, phase);
    const existing = retryWakeups.get(key);
    if (existing && existing.retryAtMs <= retryAtMs) return;
    if (existing) clearTimeout(existing.timer);
    const delay = Math.max(0, retryAtMs - currentTimeMs());
    const timer = setTimeout(() => {
        retryWakeups.delete(key);
        void flushPendingPlaybackStartupTraces(apiClient);
    }, delay);
    retryWakeups.set(key, { timer, retryAtMs });
}

async function reconcileJournalMirror(record, phase) {
    if (!record?.serverId) return;
    const request = {
        serverId: record.serverId,
        attemptId: record.attemptId,
        phase,
        attemptStartedAtMs: Date.parse(record.startedAt)
    };
    const result = await deliveryJournal.readDeliveryMirrors([request]);
    if (result.kind !== 'read') return;
    const state = readState();
    const current = findAttempt(state, record.attemptId);
    if (!current) return;
    const mirror = result.rows.find(row => row.serverId === record.serverId
        && row.attemptId === record.attemptId && row.phase === phase);
    if (mirror) {
        const previous = current.phaseState[phase];
        current.phaseState[phase] = {
            deliveries: Math.max(previous?.deliveries || 0, mirror.deliveries),
            acknowledged: previous?.acknowledged === true || mirror.acknowledged
        };
        writeState(state);
    }
}

function isDefiniteHttpFailure(error) {
    const status = error?.response?.status ?? error?.status;
    return Number.isInteger(status) && status >= 100 && status <= 599;
}

function publicTraceRecord(record) {
    return {
        ...record,
        events: record.events.map(event => Object.fromEntries(Object.entries(event).filter(([key]) =>
            !['documentEpoch', 'eventCounter', 'recordedAtMs', 'mediaSnapshot'].includes(key)
        )))
    };
}

async function flushPhase(apiClient, record, phase) {
    const payloadTemplate = serializablePhaseTemplate(publicTraceRecord(record), phase);
    const request = journalInput(record, phase, payloadTemplate);
    const claim = await deliveryJournal.claimDelivery(request);
    if (claim.kind === 'defer') {
        scheduleDeliveryWakeup(apiClient, record, phase, claim.retryAtMs);
        return;
    }
    if (claim.kind === 'done') {
        clearDeliveryWakeup(record.serverId, record.attemptId, phase);
        await reconcileJournalMirror(record, phase);
        return;
    }
    if (claim.kind !== 'claimed') return;

    const claimedState = readState();
    const claimedRecord = findAttempt(claimedState, record.attemptId);
    if (claimedRecord) {
        const previous = claimedRecord.phaseState[phase];
        claimedRecord.phaseState[phase] = {
            deliveries: Math.max(previous?.deliveries || 0, claim.ordinal),
            acknowledged: previous?.acknowledged === true
        };
        if (!writeState(claimedState)) {
            const settlement = await deliveryJournal.recordDeliveryFailure({ ...request, claimId: claim.claimId, ordinal: claim.ordinal });
            if (settlement.kind === 'committed' && settlement.retryAtMs !== undefined) {
                scheduleDeliveryWakeup(apiClient, record, phase, settlement.retryAtMs);
            }
            return;
        }
    }

    try {
        const body = serializePlaybackStartupDelivery(claim.payloadTemplate, claim.ordinal);
        if (utf8Size(body) > MAX_INCIDENT_BYTES) throw new Error('playback startup payload exceeded limit');
        await dispatchIncident(apiClient, claim.payloadTemplate, claim.ordinal);
        const settlement = await deliveryJournal.acknowledgeDelivery({ ...request, claimId: claim.claimId, ordinal: claim.ordinal });
        if (settlement.kind === 'committed') clearDeliveryWakeup(record.serverId, record.attemptId, phase);
        else scheduleDeliveryWakeup(apiClient, record, phase, claim.expiresAtMs);
        await reconcileJournalMirror(record, phase);
    } catch (error) {
        if (isDefiniteHttpFailure(error)) {
            const settlement = await deliveryJournal.recordDeliveryFailure({ ...request, claimId: claim.claimId, ordinal: claim.ordinal });
            await reconcileJournalMirror(record, phase);
            if (settlement.kind === 'committed' && settlement.retryAtMs !== undefined) {
                scheduleDeliveryWakeup(apiClient, record, phase, settlement.retryAtMs);
            } else if (claim.ordinal < MAX_DELIVERIES_PER_PHASE) {
                scheduleDeliveryWakeup(apiClient, record, phase, currentTimeMs() + 1000);
            }
        } else {
            // A timeout, abort or missing HTTP response has unknown server
            // settlement. Keep the lease unchanged until its fixed expiry.
            scheduleDeliveryWakeup(apiClient, record, phase, claim.expiresAtMs);
        }
    }
}

/**
 * Starts and persists a video-startup trace before the caller begins an async
 * operation. The generated id is safe on the app's plain-HTTP LAN origin.
 * @param {{itemId?: string, serverId?: string, startupTraceId?: string, apiClient?: object, stage?: string}} options Trace identity and first pending stage.
 * @returns {string|undefined} Trace id, or undefined when trace creation fails.
 */
export function beginPlaybackStartupTrace(options = {}) {
    try {
        const state = readState();
        const attemptId = boundedString(options.startupTraceId, 64) || randomId();
        const existing = findAttempt(state, attemptId);
        if (existing) {
            if (options.apiClient) apiClients.set(attemptId, options.apiClient);
            return attemptId;
        }
        const now = currentTimeMs();
        const record = {
            attemptId,
            version: SCHEMA_VERSION,
            startedAt: new Date(now).toISOString(),
            itemId: boundedString(options.itemId),
            serverId: boundedString(options.serverId || serverIdFromApiClient(options.apiClient)),
            status: 'starting',
            pendingStage: ALLOWED_STAGES.has(options.stage) ? options.stage : 'route',
            events: [],
            phaseState: {},
            mediaSnapshot: {}
        };
        monotonicStarts.set(attemptId, monotonicNow());
        appendEvent(record, record.pendingStage, { outcome: 'begin' });
        state.incidents.push(record);
        const persisted = writeState(state);
        bindLifecycleListeners();
        if (!persisted || !state.incidents.some(item => item.attemptId === attemptId)) {
            cleanupAttemptMemory(attemptId);
            return undefined;
        }
        if (options.apiClient) apiClients.set(attemptId, options.apiClient);
        armWatchdog(attemptId);
        if (options.apiClient && state.incidents.some(item => item.attemptId !== attemptId && hasPendingUpload(item))) {
            void flushPendingPlaybackStartupTraces(options.apiClient);
        }
        return attemptId;
    } catch {
        return undefined;
    }
}

/**
 * Records a sanitized stage transition synchronously before the next await.
 * @param {string|undefined} attemptId Trace id returned by beginPlaybackStartupTrace.
 * @param {string} stage Named operation or media event.
 * @param {object} [fields] Strictly filtered numeric/enumerated metadata.
 * @param {HTMLMediaElement} [element] Media element used for a safe state snapshot.
 */
export function recordPlaybackStartupTrace(attemptId, stage, fields, element) {
    if (!attemptId) return;
    try {
        const state = readState();
        const record = findAttempt(state, attemptId);
        if (!record || record.status === 'complete' || record.status === 'cancelled') return;
        const event = appendEvent(record, stage, fields, !OBSERVATIONAL_STAGES.has(stage));
        if (element) {
            record.mediaSnapshot = mediaSnapshot(element);
            if (event) event.mediaSnapshot = record.mediaSnapshot;
        }
        writeState(state);
    } catch {
        // allow-silent-catch: optional trace recording must not throw into playback; the last durable state and watchdog remain authoritative
        // Diagnostic failures are intentionally isolated from playback.
    }
}

/**
 * Pauses a requested item's watchdog while a separately traced intro plays.
 * @param {string|undefined} attemptId Requested item's trace id.
 */
export function suspendPlaybackStartupTrace(attemptId) {
    if (!attemptId) return;
    const timer = timers.get(attemptId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(attemptId);
}

/**
 * Restarts a requested item's watchdog when its own startup resumes.
 * @param {string|undefined} attemptId Requested item's trace id.
 */
export function resumePlaybackStartupTrace(attemptId) {
    if (!attemptId) return;
    const state = readState();
    const record = findAttempt(state, attemptId);
    if (record?.status === 'starting') armWatchdog(attemptId);
}

/**
 * Marks a failed stage while preserving only a numeric SDK status, when known.
 * @param {string|undefined} attemptId Trace id.
 * @param {string} stage Failed operation name.
 * @param {object} [fields] Allowlisted fields, normally numeric httpStatus.
 */
export function failPlaybackStartupTrace(attemptId, stage, fields = {}) {
    if (!attemptId) return;
    try {
        const state = readState();
        const record = findAttempt(state, attemptId);
        if (!record) return;
        record.status = 'incident';
        record.phaseState.incident ||= { deliveries: 0, acknowledged: false };
        appendEvent(record, stage, { ...fields, outcome: 'rejected' }, !OBSERVATIONAL_STAGES.has(stage));
        record.mediaSnapshot ||= {};
        writeState(state);
        const timer = timers.get(attemptId);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(attemptId);
        const apiClient = apiClients.get(attemptId);
        if (apiClient) void flushPendingPlaybackStartupTraces(apiClient);
    } catch {
        // allow-silent-catch: failure telemetry must not reject the playback promise or create delivery authority
        // Error reporting must never reject the playback promise.
    }
}

/**
 * Finishes a startup; fast successes are discarded while incidents retain a
 * single late-completion phase for diagnosis.
 * @param {string|undefined} attemptId Trace id.
 * @param {string} stage Completion stage, usually firstvideoframe or videoready.
 * @param {HTMLMediaElement} [element] Active media element.
 */
export function completePlaybackStartupTrace(attemptId, stage, element) {
    if (!attemptId) return;
    try {
        const state = readState();
        const record = findAttempt(state, attemptId);
        if (!record) return;
        const event = appendEvent(record, stage, { outcome: 'complete' }, !OBSERVATIONAL_STAGES.has(stage));
        if (element) {
            record.mediaSnapshot = mediaSnapshot(element);
            if (event) event.mediaSnapshot = record.mediaSnapshot;
        }
        const timer = timers.get(attemptId);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(attemptId);
        if (record.status === 'starting') {
            record.status = 'complete';
            writeState(state);
            cleanupAttemptMemory(attemptId);
        } else {
            record.status = 'complete';
            record.phaseState.completion ||= { deliveries: 0, acknowledged: false };
            writeState(state);
            const apiClient = apiClients.get(attemptId);
            if (apiClient) void flushPendingPlaybackStartupTraces(apiClient);
        }
    } catch {
        // allow-silent-catch: completion telemetry must not alter successful playback or fabricate journal acknowledgement
        // Completion telemetry is best effort and never affects playback.
    }
}

/**
 * Marks a cancelled or superseded startup with a bounded reason code.
 * @param {string|undefined} attemptId Trace id.
 * @param {'cancelled'|'item-switch'|'superseded'} reason Safe fixed reason code.
 */
export function cancelPlaybackStartupTrace(attemptId, reason = 'cancelled') {
    if (!attemptId) return;
    try {
        const state = readState();
        const record = findAttempt(state, attemptId);
        if (!record) return;
        const apiClient = apiClients.get(attemptId);
        record.status = 'cancelled';
        appendEvent(record, 'cancelled', { outcome: 'cancelled' });
        record.phaseState.incident ||= { deliveries: 0, acknowledged: false };
        record.cancelReason = ['cancelled', 'item-switch', 'superseded'].includes(reason) ? reason : 'cancelled';
        const timer = timers.get(attemptId);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(attemptId);
        writeState(state);
        apiClients.delete(attemptId);
        monotonicStarts.delete(attemptId);
        if (apiClient) void flushPendingPlaybackStartupTraces(apiClient);
    } catch {
        // allow-silent-catch: cancellation telemetry must not interrupt player teardown or fabricate delivery state
        // Cancellation telemetry must not interrupt player teardown.
    }
}

/**
 * Flushes pending diagnostics through the SDK's authenticated client-log API.
 * A phase's dispatch count is persisted before each POST, bounding retries at
 * two even when the response is lost and the server may have stored the file.
 * @param {object} apiClient Signed-in legacy Jellyfin API client.
 * @returns {Promise<void>} Settles after one bounded upload pass.
 */
function flushPending(apiClient, skipPhases = new Set()) {
    const signedInServerId = serverIdFromApiClient(apiClient);
    if (!signedInServerId) return Promise.resolve();
    if (flushInFlight) {
        queuedFlushApiClients.set(signedInServerId, apiClient);
        return flushInFlight;
    }
    const attemptedPhases = new Set();
    flushInFlight = (async () => {
        try {
            const state = readState();
            for (const record of state.incidents) {
                if (record.serverId !== signedInServerId) continue;
                if (record.status === 'starting') continue;
                const phases = record.status === 'complete' ? ['incident', 'completion'] : ['incident'];
                for (const phase of phases) {
                    const phaseKey = `${record.attemptId}:${phase}`;
                    if (!record.phaseState[phase]) continue;
                    if (skipPhases.has(phaseKey)) continue;
                    attemptedPhases.add(phaseKey);
                    await flushPhase(apiClient, record, phase);
                }
            }
        } catch {
            // allow-silent-catch: upload isolation preserves durable unacknowledged state for a later trigger and must not reject playback or auth
            // Upload failure is diagnostic-only and never affects playback or auth.
        }
    })().finally(() => {
        flushInFlight = undefined;
        const queuedApiClients = Array.from(queuedFlushApiClients.values());
        queuedFlushApiClients.clear();
        for (const queuedApiClient of queuedApiClients) {
            void flushPending(queuedApiClient, attemptedPhases);
        }
    });
    return flushInFlight;
}

export function flushPendingPlaybackStartupTraces(apiClient) {
    return flushPending(apiClient);
}

/**
 * Exposes the schema key for contract tests and diagnostics tooling.
 * @returns {string} Session storage key for schema version 1.
 */
export function playbackStartupTraceStorageKey() {
    return STORAGE_KEY;
}

/**
 * Returns bounded in-memory ownership counts for source-level contract tests.
 * @returns {{timers: number, monotonicStarts: number, apiClients: number, queuedFlushApiClients: number}} Current trace-owned references.
 */
export function playbackStartupTraceMemoryStatsForTest() {
    return {
        timers: timers.size,
        monotonicStarts: monotonicStarts.size,
        apiClients: apiClients.size,
        queuedFlushApiClients: queuedFlushApiClients.size
    };
}

/** @param {object} journal Test-only adapter for the upload boundary. */
export function setPlaybackStartupTraceDeliveryJournalForTest(journal) {
    deliveryJournal = journal || defaultDeliveryJournal;
}
