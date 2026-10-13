// SlopTank modification notice: added or changed by SlopTank on 2026-10-13.
/**
 * Cross-document durable claims for bounded playback-startup log delivery.
 * @module playbackStartupTraceDeliveryJournal
 */
import { randomId } from '../../utils/random.ts';

const DATABASE_NAME = 'sloptank.playbackStartupTrace';
const DATABASE_VERSION = 1;
const STORE_NAME = 'deliveries';
const SCHEMA_VERSION = 1;
const JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOURNAL_ATTEMPTS = 128;
const MAX_JOURNAL_ROWS = 256;
const MAX_DELIVERIES_PER_PHASE = 2;
const MAX_PHASE_PAYLOAD_BYTES = 32768;
const JOURNAL_OPERATION_TIMEOUT_MS = 5000;
const CLAIM_LEASE_MS = 30000;
const DEFINITE_FAILURE_RETRY_DELAY_MS = 1000;

const ROW_FIELDS = [
    'schemaVersion', 'serverId', 'attemptId', 'phase', 'attemptStartedAtMs',
    'attemptExpiresAtMs', 'deliveryCount', 'acknowledged', 'claimHistory',
    'firstPayloadTemplate', 'activeClaim', 'retryNotBeforeMs'
];
const CLAIM_FIELDS = ['claimId', 'ordinal', 'documentEpoch', 'claimedAtMs', 'expiresAtMs'];
const PAYLOAD_FIELDS = [
    'version', 'attemptId', 'phase', 'startedAt', 'elapsedMs',
    'serverId', 'status', 'pendingStage', 'events', 'mediaSnapshot'
];
const PAYLOAD_STATUSES = new Set(['starting', 'incident', 'abandoned', 'complete', 'cancelled']);
const PAYLOAD_PHASES = new Set(['incident', 'completion']);
const PAYLOAD_STAGES = new Set([
    'route', 'item-fetch', 'translate-items', 'additional-parts', 'intro-lookup',
    'preplay-interceptors', 'bitrate', 'player-choice', 'device-profile',
    'current-user', 'media-streams', 'playback-info', 'stream-info', 'player-play',
    'playback-start', 'create-media-element', 'update-video-url', 'set-current-src',
    'osd-preparing', 'osd-ready', 'firstvideoframe', 'videoready', 'pagehide',
    'cancelled', 'loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting',
    'stalled', 'seeked', 'error', 'abort'
]);
const PAYLOAD_OUTCOMES = new Set(['begin', 'resolved', 'rejected', 'visible', 'hidden', 'abandoned', 'cancelled', 'complete']);
const PAYLOAD_PLAY_METHODS = new Set(['DirectPlay', 'DirectStream', 'Transcode', 'Remux']);
const PAYLOAD_REQUEST_KINDS = new Set(['playback-info', 'video', 'subtitle']);
const PAYLOAD_MEDIA_EVENTS = new Set([
    'loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled',
    'seeked', 'error', 'abort', 'firstvideoframe', 'videoready'
]);
const PAYLOAD_FIELD_NAMES = new Set([
    'outcome', 'mediaSourceId', 'container', 'playMethod', 'audioStreamIndex',
    'subtitleStreamIndex', 'httpStatus', 'requestKind', 'mediaErrorCode',
    'mediaReadyState', 'mediaNetworkState', 'currentTime', 'buffered', 'seekable',
    'event', 'resourceDurationMs', 'resourceTransferSize'
]);
const MEDIA_SNAPSHOT_FIELDS = new Set([
    'mediaReadyState', 'mediaNetworkState', 'currentTime', 'buffered', 'seekable', 'mediaErrorCode'
]);

function byteSize(text) {
    return new Blob([text]).size;
}

function boundedText(value, maxLength = 128) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && /^[A-Za-z0-9_.+-]+$/.test(value);
}

function isInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function hasExactFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const compareText = (left, right) => left.localeCompare(right);
    const keys = Object.keys(value).sort(compareText);
    const expected = [...fields].sort(compareText);
    return keys.length === fields.length && keys.every((key, index) => key === expected[index]);
}

function validNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validRangeList(value) {
    return Array.isArray(value) && value.length <= 4 && value.every(range =>
        hasExactFields(range, ['start', 'end']) && validNumber(range.start) && validNumber(range.end) && range.end >= range.start
    );
}

function validPayloadFields(fields) {
    for (const [key, value] of Object.entries(fields)) {
        if (!PAYLOAD_FIELD_NAMES.has(key)) return false;
        if (key === 'outcome' && !PAYLOAD_OUTCOMES.has(value)) return false;
        if (key === 'event' && !PAYLOAD_MEDIA_EVENTS.has(value)) return false;
        if (key === 'requestKind' && !PAYLOAD_REQUEST_KINDS.has(value)) return false;
        if (key === 'playMethod' && !PAYLOAD_PLAY_METHODS.has(value)) return false;
        if (key === 'mediaSourceId' || key === 'container') {
            if (!boundedText(value, 64)) return false;
        } else if (key === 'httpStatus') {
            if (value !== 'unknown' && (!Number.isInteger(value) || value < 100 || value > 599)) return false;
        } else if (key === 'currentTime' || key === 'resourceDurationMs' || key === 'resourceTransferSize') {
            if (!validNumber(value)) return false;
        } else if (key === 'audioStreamIndex' || key === 'subtitleStreamIndex') {
            if (!Number.isInteger(value) || value < -1) return false;
        } else if (key === 'mediaErrorCode' || key === 'mediaReadyState' || key === 'mediaNetworkState') {
            if (!Number.isInteger(value) || value < 0) return false;
        } else if ((key === 'buffered' || key === 'seekable') && !validRangeList(value)) {
            return false;
        }
    }
    return true;
}

function validatePayloadTemplate(template, binding = {}) {
    if (typeof template !== 'string' || byteSize(template) > MAX_PHASE_PAYLOAD_BYTES) return false;
    let payload;
    try {
        payload = JSON.parse(template);
    } catch {
        return false;
    }
    if (!hasExactFields(payload, PAYLOAD_FIELDS.concat(payload?.itemId !== undefined ? ['itemId'] : []))
        || JSON.stringify(payload) !== template
        || payload.version !== SCHEMA_VERSION || !PAYLOAD_PHASES.has(payload.phase)
        || !boundedText(payload.serverId) || !boundedText(payload.attemptId)
        || !PAYLOAD_STATUSES.has(payload.status) || !PAYLOAD_STAGES.has(payload.pendingStage)
        || typeof payload.startedAt !== 'string' || !Number.isFinite(Date.parse(payload.startedAt))
        || !validNumber(payload.elapsedMs) || (payload.itemId !== undefined && !boundedText(payload.itemId))
        || !Array.isArray(payload.events) || payload.events.length > 32
        || !payload.events.every(event => {
            if (!event || typeof event !== 'object' || Array.isArray(event)
                || !PAYLOAD_STAGES.has(event.stage) || !validNumber(event.elapsedMs)) return false;
            const fields = { ...event };
            delete fields.stage;
            delete fields.elapsedMs;
            return validPayloadFields(fields);
        }) || !payload.mediaSnapshot || typeof payload.mediaSnapshot !== 'object' || Array.isArray(payload.mediaSnapshot)
        || Object.entries(payload.mediaSnapshot).some(([key, value]) => {
            if (!MEDIA_SNAPSHOT_FIELDS.has(key)) return true;
            if (key === 'buffered' || key === 'seekable') return !validRangeList(value);
            if (key === 'currentTime') return !validNumber(value);
            return !Number.isInteger(value) || value < 0;
        })) return false;
    return (binding.serverId === undefined || payload.serverId === binding.serverId)
        && (binding.attemptId === undefined || payload.attemptId === binding.attemptId)
        && (binding.phase === undefined || payload.phase === binding.phase)
        && (binding.attemptStartedAtMs === undefined
            || Date.parse(payload.startedAt) === binding.attemptStartedAtMs);
}

function serializeDeliveryPayload(template, ordinal) {
    const payload = JSON.parse(template);
    return JSON.stringify({
        version: payload.version,
        attemptId: payload.attemptId,
        phase: payload.phase,
        deliveryOrdinal: ordinal,
        startedAt: payload.startedAt,
        elapsedMs: payload.elapsedMs,
        ...(payload.itemId !== undefined ? { itemId: payload.itemId } : {}),
        serverId: payload.serverId,
        status: payload.status,
        pendingStage: payload.pendingStage,
        events: payload.events,
        mediaSnapshot: payload.mediaSnapshot
    });
}

function rowKey(row) {
    return JSON.stringify([row.serverId, row.attemptId, row.phase]);
}

function inputKey(input) {
    return JSON.stringify([input.serverId, input.attemptId, input.phase]);
}

function validateClaimHistory(history, count) {
    if (!Array.isArray(history) || history.length !== count) return false;
    const ids = new Set();
    return history.every((entry, index) => {
        if (!hasExactFields(entry, ['claimId', 'ordinal']) || !boundedText(entry.claimId, 64)
            || entry.ordinal !== index + 1 || ids.has(entry.claimId)) return false;
        ids.add(entry.claimId);
        return true;
    });
}

function validateRow(row) {
    if (!hasExactFields(row, ROW_FIELDS) || row.schemaVersion !== SCHEMA_VERSION
        || !boundedText(row.serverId) || !boundedText(row.attemptId) || !PAYLOAD_PHASES.has(row.phase)
        || !isInteger(row.attemptStartedAtMs)
        || row.attemptExpiresAtMs !== row.attemptStartedAtMs + JOURNAL_TTL_MS
        || ![1, 2].includes(row.deliveryCount) || typeof row.acknowledged !== 'boolean'
        || !validateClaimHistory(row.claimHistory, row.deliveryCount)
        || !(row.retryNotBeforeMs === null || isInteger(row.retryNotBeforeMs))) return false;
    const active = row.activeClaim;
    if (active !== null && (!hasExactFields(active, CLAIM_FIELDS)
        || !boundedText(active.claimId, 64) || !boundedText(active.documentEpoch, 64)
        || !isInteger(active.ordinal) || active.ordinal !== row.deliveryCount
        || !isInteger(active.claimedAtMs) || !isInteger(active.expiresAtMs)
        || active.expiresAtMs !== active.claimedAtMs + CLAIM_LEASE_MS
        || !row.claimHistory.some(entry => entry.claimId === active.claimId && entry.ordinal === active.ordinal))) return false;
    if (row.acknowledged && (active !== null || row.retryNotBeforeMs !== null || row.firstPayloadTemplate !== null)) return false;
    if (row.deliveryCount === 1 && !row.acknowledged) {
        if (!validatePayloadTemplate(row.firstPayloadTemplate, row)) return false;
    } else if (row.deliveryCount === 2 && active !== null) {
        if (!validatePayloadTemplate(row.firstPayloadTemplate, row)) return false;
    } else if (row.firstPayloadTemplate !== null || active !== null || row.retryNotBeforeMs !== null) {
        return false;
    }
    return true;
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function typedError(reasonCode) {
    const error = new Error(reasonCode);
    error.reasonCode = reasonCode;
    return error;
}

function createOperationController() {
    const listeners = new Set();
    const signal = {
        aborted: false,
        addEventListener(type, listener) {
            if (type === 'abort') listeners.add(listener);
        },
        removeEventListener(type, listener) {
            if (type === 'abort') listeners.delete(listener);
        }
    };
    return {
        signal,
        abort() {
            if (signal.aborted) return;
            signal.aborted = true;
            for (const listener of listeners) listener();
            listeners.clear();
        }
    };
}

function createNativeAdapter(indexedDb) {
    if (!indexedDb || typeof indexedDb.open !== 'function') return null;

    function transact(mode, durability, handler, context) {
        return new Promise((resolve, reject) => {
            let request;
            let database;
            let transaction;
            let finished = false;
            let result;
            const { signal, deadlineAt, now } = context;
            const expired = () => signal.aborted || now() >= deadlineAt;
            const cleanup = () => {
                signal.removeEventListener('abort', abort);
                try {
                    transaction?.abort();
                } catch {
                    // allow-silent-catch: transaction abort cleanup may race settlement; the caller still receives operation-aborted
                    // The transaction may already be settled.
                }
                try {
                    database?.close();
                } catch {
                    // allow-silent-catch: database close cleanup may race prior close; the caller still receives operation-aborted
                    // The database may already be closed.
                }
            };
            const settle = (error, value) => {
                if (finished) return;
                finished = true;
                signal.removeEventListener('abort', abort);
                try {
                    database?.close();
                } catch {
                    // allow-silent-catch: close cleanup cannot replace the settle function's original typed error or committed value
                    // Closing is best effort after an IDB error.
                }
                if (error) reject(error);
                else resolve(value);
            };
            const abort = () => {
                cleanup();
                settle(typedError('operation-aborted'));
            };
            signal.addEventListener('abort', abort, { once: true });
            try {
                request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
            } catch {
                settle(typedError('open-failed'));
                return;
            }
            request.onupgradeneeded = event => {
                if (finished || expired()) {
                    try {
                        request.transaction.abort();
                    } catch {
                        // allow-silent-catch: expired upgrade abort may already be settled; the operation still refuses with operation-timeout
                        // The upgrade transaction may already be aborted.
                    }
                    if (!finished) settle(typedError('operation-timeout'));
                    return;
                }
                if (event.oldVersion !== 0 || event.newVersion !== DATABASE_VERSION) {
                    try {
                        request.transaction.abort();
                    } catch {
                        // allow-silent-catch: unexpected upgrade abort may already be settled; the operation still refuses with unexpected-upgrade
                        // The unexpected upgrade may already be aborted.
                    }
                    settle(typedError('unexpected-upgrade'));
                    return;
                }
                try {
                    request.result.createObjectStore(STORE_NAME, { keyPath: ['serverId', 'attemptId', 'phase'] });
                } catch {
                    try {
                        request.transaction.abort();
                    } catch {
                        // allow-silent-catch: failed upgrade abort may already be settled; the operation still refuses with upgrade-failed
                        // The upgrade transaction may already be aborted.
                    }
                    settle(typedError('upgrade-failed'));
                }
            };
            request.onblocked = () => settle(typedError('open-blocked'));
            request.onerror = () => settle(typedError('open-failed'));
            request.onsuccess = () => {
                if (finished) {
                    try {
                        request.result.close();
                    } catch {
                        // allow-silent-catch: late-open close may race connection shutdown; the operation was already settled and no transaction is started
                        // A late-opened database is closed best-effort.
                    }
                    return;
                }
                database = request.result;
                if (expired()) {
                    settle(typedError('operation-timeout'));
                    return;
                }
                database.onversionchange = () => {
                    try {
                        database.close();
                    } catch {
                        // allow-silent-catch: version-change close may race browser closure; the operation still refuses with versionchange
                        // Closing is best effort during version change.
                    }
                    settle(typedError('versionchange'));
                };
                try {
                    transaction = mode === 'readwrite' ? database.transaction(STORE_NAME, 'readwrite', { durability }) : database.transaction(STORE_NAME, 'readonly');
                } catch {
                    settle(typedError(mode === 'readwrite' ? 'durability-unsupported' : 'transaction-failed'));
                    return;
                }
                const store = transaction.objectStore(STORE_NAME);
                const rowsRequest = store.getAll();
                rowsRequest.onerror = () => {
                    try {
                        transaction.abort();
                    } catch {
                        // allow-silent-catch: request failure may already have aborted the transaction; transaction callbacks retain the typed refusal
                        // The request failure may already have aborted it.
                    }
                };
                rowsRequest.onsuccess = () => {
                    if (finished || expired()) {
                        try {
                            transaction.abort();
                        } catch {
                            // allow-silent-catch: expired transaction abort may already be settled; the branch retains its timeout or aborted refusal
                            // The transaction may already be aborted.
                        }
                        settle(typedError(expired() ? 'operation-timeout' : 'operation-aborted'));
                        return;
                    }
                    try {
                        const ops = {
                            put: row => {
                                if (mode !== 'readwrite') throw typedError('readonly-mutation');
                                store.put(clone(row));
                            },
                            delete: key => {
                                if (mode !== 'readwrite') throw typedError('readonly-mutation');
                                store.delete(key);
                            }
                        };
                        result = handler(rowsRequest.result.map(clone), ops);
                    } catch (error) {
                        try {
                            transaction.abort();
                        } catch {
                            // allow-silent-catch: handler failure may already have aborted the transaction; its reasonCode or transaction-handler-failed is preserved
                            // The transaction may already be aborted.
                        }
                        settle(error?.reasonCode ? error : typedError('transaction-handler-failed'));
                    }
                };
                transaction.onerror = () => settle(typedError('transaction-failed'));
                transaction.onabort = () => settle(typedError('transaction-aborted'));
                transaction.oncomplete = () => {
                    if (expired()) settle(typedError('operation-timeout'));
                    else settle(null, result);
                };
            };
        });
    }

    return { transact };
}

function validInput(input) {
    return input && boundedText(input.serverId) && boundedText(input.attemptId)
        && PAYLOAD_PHASES.has(input.phase) && isInteger(input.attemptStartedAtMs);
}

function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function createPlaybackStartupTraceDeliveryJournal({
    adapter,
    indexedDB = typeof window === 'undefined' ? undefined : window.indexedDB,
    now = () => Date.now(),
    makeId = randomId,
    operationTimeoutMs = JOURNAL_OPERATION_TIMEOUT_MS
} = {}) {
    const storage = adapter || createNativeAdapter(indexedDB);

    async function operate(work) {
        if (!storage) return { kind: 'refused', reasonCode: 'indexeddb-unavailable' };
        const started = now();
        const deadlineAt = started + operationTimeoutMs;
        const controller = createOperationController();
        let deadlineTimer;
        const deadline = new Promise(resolve => {
            deadlineTimer = setTimeout(() => {
                controller.abort();
                resolve({ kind: 'refused', reasonCode: 'operation-timeout' });
            }, operationTimeoutMs);
        });
        const context = { signal: controller.signal, deadlineAt, now };
        const run = (async () => {
            try {
                const result = await work(context);
                if (controller.signal.aborted || now() >= deadlineAt) return { kind: 'refused', reasonCode: 'operation-timeout' };
                return result;
            } catch (error) {
                return { kind: 'refused', reasonCode: error?.reasonCode || 'journal-operation-failed' };
            } finally {
                clearTimeout(deadlineTimer);
            }
        })();
        const result = await Promise.race([run, deadline]);
        if (result.kind !== 'claimed') clearTimeout(deadlineTimer);
        return result;
    }

    async function transact(context, mode, handler) {
        if (context.signal.aborted || now() >= context.deadlineAt) throw typedError('operation-timeout');
        return storage.transact(mode, mode === 'readwrite' ? 'strict' : undefined, handler, context);
    }

    function validateAndCleanup(rows, operations, currentTimeMs) {
        const byKey = new Map();
        for (const row of rows) {
            if (!validateRow(row)) throw typedError('malformed-row');
            const key = rowKey(row);
            if (byKey.has(key)) throw typedError('duplicate-key');
            byKey.set(key, row);
        }
        const retained = [];
        for (const row of byKey.values()) {
            if (currentTimeMs >= row.attemptExpiresAtMs) {
                operations.delete([row.serverId, row.attemptId, row.phase]);
            } else {
                retained.push(row);
            }
        }
        return retained;
    }

    function verifyReadback(context, key, expected, expectedMissing = false) {
        return transact(context, 'readonly', rows => {
            const current = rows.find(row => rowKey(row) === key);
            if (expectedMissing) return current === undefined;
            return current !== undefined && validateRow(current) && sameValue(current, expected);
        }).then(matches => matches === true);
    }

    async function claimDelivery(input) {
        if (!validInput(input)) return { kind: 'refused', reasonCode: 'invalid-input' };
        const { serverId, attemptId, phase, attemptStartedAtMs, payloadTemplate, documentEpoch } = input;
        if (now() >= attemptStartedAtMs + JOURNAL_TTL_MS) return { kind: 'refused', reasonCode: 'attempt-expired' };
        if (!boundedText(documentEpoch, 64) || !validatePayloadTemplate(payloadTemplate, {
            serverId, attemptId, phase, attemptStartedAtMs
        })) {
            return { kind: 'refused', reasonCode: 'invalid-template' };
        }
        try {
            if (byteSize(serializeDeliveryPayload(payloadTemplate, 1)) > MAX_PHASE_PAYLOAD_BYTES) {
                return { kind: 'refused', reasonCode: 'payload-too-large' };
            }
            if (byteSize(serializeDeliveryPayload(payloadTemplate, 2)) > MAX_PHASE_PAYLOAD_BYTES) {
                return { kind: 'refused', reasonCode: 'payload-too-large' };
            }
        } catch {
            return { kind: 'refused', reasonCode: 'invalid-template' };
        }
        return operate(async context => {
            const key = inputKey(input);
            const currentTimeMs = now();
            let outcome;
            let expectedRow;
            let expectedMissing = false;
            await transact(context, 'readwrite', (rows, operations) => {
                const retained = validateAndCleanup(rows, operations, currentTimeMs);
                const attemptRows = retained.filter(candidate => candidate.serverId === serverId
                    && candidate.attemptId === attemptId);
                if (attemptRows.some(candidate => candidate.attemptStartedAtMs !== attemptStartedAtMs)) {
                    throw typedError('binding-mismatch');
                }
                let row = retained.find(candidate => rowKey(candidate) === key);
                if (row && (row.serverId !== serverId || row.attemptId !== attemptId || row.phase !== phase
                    || row.attemptStartedAtMs !== attemptStartedAtMs
                    || row.attemptExpiresAtMs !== attemptStartedAtMs + JOURNAL_TTL_MS)) {
                    throw typedError('binding-mismatch');
                }
                if (row?.acknowledged || (row?.deliveryCount === MAX_DELIVERIES_PER_PHASE && row.activeClaim === null)) {
                    if (row && row.firstPayloadTemplate !== null) {
                        row = { ...row, firstPayloadTemplate: null, activeClaim: null, retryNotBeforeMs: null };
                        operations.put(row);
                        expectedRow = row;
                    } else {
                        expectedRow = row;
                    }
                    outcome = { kind: 'done' };
                    return;
                }
                if (row?.activeClaim) {
                    if (currentTimeMs < row.activeClaim.claimedAtMs || currentTimeMs < row.activeClaim.expiresAtMs) {
                        expectedRow = row;
                        outcome = { kind: 'defer', retryAtMs: Math.max(currentTimeMs, row.activeClaim.expiresAtMs) };
                        return;
                    }
                    row = { ...row, activeClaim: null, retryNotBeforeMs: null };
                    if (row.deliveryCount === MAX_DELIVERIES_PER_PHASE) {
                        row.firstPayloadTemplate = null;
                        operations.put(row);
                        expectedRow = row;
                        outcome = { kind: 'done' };
                        return;
                    }
                }
                if (row?.retryNotBeforeMs !== null && row?.retryNotBeforeMs > currentTimeMs) {
                    expectedRow = row;
                    outcome = { kind: 'defer', retryAtMs: row.retryNotBeforeMs };
                    return;
                }
                const distinctAttempts = new Set(retained.map(candidate => JSON.stringify([candidate.serverId, candidate.attemptId])));
                const postCleanupRows = retained.length;
                if (!row && !attemptRows.length && distinctAttempts.size >= MAX_JOURNAL_ATTEMPTS) {
                    expectedMissing = true;
                    outcome = { kind: 'refused', reasonCode: 'attempt-capacity' };
                    return;
                }
                if (!row && postCleanupRows >= MAX_JOURNAL_ROWS) {
                    expectedMissing = true;
                    outcome = { kind: 'refused', reasonCode: 'row-capacity' };
                    return;
                }
                const template = row?.deliveryCount === 1 ? row.firstPayloadTemplate : payloadTemplate;
                if (!validatePayloadTemplate(template, {
                    serverId, attemptId, phase, attemptStartedAtMs
                })) throw typedError('malformed-template');
                const ordinal = (row?.deliveryCount || 0) + 1;
                if (ordinal > MAX_DELIVERIES_PER_PHASE) {
                    expectedRow = row;
                    outcome = { kind: 'done' };
                    return;
                }
                const claimId = makeId();
                if (!boundedText(claimId, 64) || row?.claimHistory.some(entry => entry.claimId === claimId)) {
                    throw typedError('invalid-claim-id');
                }
                const claimedAtMs = currentTimeMs;
                const expiresAtMs = claimedAtMs + CLAIM_LEASE_MS;
                const newRow = {
                    schemaVersion: SCHEMA_VERSION,
                    serverId,
                    attemptId,
                    phase,
                    attemptStartedAtMs,
                    attemptExpiresAtMs: attemptStartedAtMs + JOURNAL_TTL_MS,
                    deliveryCount: ordinal,
                    acknowledged: false,
                    claimHistory: [...(row?.claimHistory || []), { claimId, ordinal }],
                    firstPayloadTemplate: template,
                    activeClaim: { claimId, ordinal, documentEpoch, claimedAtMs, expiresAtMs },
                    retryNotBeforeMs: null
                };
                if (!validateRow(newRow)) throw typedError('invalid-claim-row');
                operations.put(newRow);
                expectedRow = newRow;
                outcome = { kind: 'claimed', claimId, ordinal, payloadTemplate: template, expiresAtMs };
            });
            if (!outcome) throw typedError('claim-result-missing');
            if (expectedRow || expectedMissing) {
                const matches = await verifyReadback(context, key, expectedRow, expectedMissing);
                if (!matches) return { kind: 'refused', reasonCode: 'readback-mismatch' };
            }
            return outcome;
        });
    }

    async function settleClaim(input, settlement) {
        if (!validInput(input) || !boundedText(input.claimId, 64) || !isInteger(input.ordinal)
            || input.ordinal < 1 || input.ordinal > MAX_DELIVERIES_PER_PHASE) {
            return { kind: 'refused', reasonCode: 'invalid-input' };
        }
        return operate(async context => {
            const key = inputKey(input);
            const currentTimeMs = now();
            let outcome;
            let expectedRow;
            let expectedMissing = false;
            await transact(context, 'readwrite', (rows, operations) => {
                const retained = validateAndCleanup(rows, operations, currentTimeMs);
                const row = retained.find(candidate => rowKey(candidate) === key);
                if (!row) {
                    expectedMissing = true;
                    outcome = { kind: 'committed', applied: false };
                    return;
                }
                if (row.attemptStartedAtMs !== input.attemptStartedAtMs
                    || row.attemptExpiresAtMs !== input.attemptStartedAtMs + JOURNAL_TTL_MS) throw typedError('binding-mismatch');
                const knownClaim = row.claimHistory.some(entry => entry.claimId === input.claimId && entry.ordinal === input.ordinal);
                if (!knownClaim) throw typedError('unknown-claim');
                let updated = row;
                if (settlement === 'acknowledge') {
                    updated = {
                        ...row,
                        acknowledged: true,
                        activeClaim: null,
                        retryNotBeforeMs: null,
                        firstPayloadTemplate: null
                    };
                } else if (row.activeClaim?.claimId === input.claimId && row.activeClaim.ordinal === input.ordinal) {
                    const retryAtMs = row.deliveryCount < MAX_DELIVERIES_PER_PHASE ? currentTimeMs + DEFINITE_FAILURE_RETRY_DELAY_MS : null;
                    updated = {
                        ...row,
                        activeClaim: null,
                        retryNotBeforeMs: retryAtMs,
                        firstPayloadTemplate: row.deliveryCount < MAX_DELIVERIES_PER_PHASE ? row.firstPayloadTemplate : null
                    };
                    outcome = { kind: 'committed', applied: true, retryAtMs };
                }
                if (!sameValue(updated, row)) operations.put(updated);
                expectedRow = updated;
                outcome ||= { kind: 'committed', applied: !sameValue(updated, row) };
            });
            if (!outcome) throw typedError('settlement-result-missing');
            if (expectedRow || expectedMissing) {
                const matches = await verifyReadback(context, key, expectedRow, expectedMissing);
                if (!matches) return { kind: 'unknown', reasonCode: 'readback-mismatch' };
            }
            return outcome;
        });
    }

    async function acknowledgeDelivery(input) {
        return settleClaim(input, 'acknowledge');
    }

    async function recordDeliveryFailure(input) {
        return settleClaim(input, 'failure');
    }

    async function readDeliveryMirrors(requests) {
        if (!Array.isArray(requests) || requests.length > MAX_JOURNAL_ROWS
            || requests.some(request => !validInput(request))) {
            return { kind: 'refused', reasonCode: 'invalid-input' };
        }
        return operate(async context => {
            const rows = await transact(context, 'readonly', values => {
                if (values.some(row => !validateRow(row))) throw typedError('malformed-row');
                const requested = new Map(requests.map(request => [inputKey(request), request]));
                return values.filter(row => requested.has(rowKey(row))).map(row => {
                    if (requested.get(rowKey(row)).attemptStartedAtMs !== row.attemptStartedAtMs) {
                        throw typedError('binding-mismatch');
                    }
                    return {
                        serverId: row.serverId,
                        attemptId: row.attemptId,
                        phase: row.phase,
                        attemptStartedAtMs: row.attemptStartedAtMs,
                        deliveries: row.deliveryCount,
                        acknowledged: row.acknowledged,
                        activeClaim: row.activeClaim,
                        retryNotBeforeMs: row.retryNotBeforeMs,
                        firstPayloadTemplate: row.firstPayloadTemplate
                    };
                });
            });
            return { kind: 'read', rows };
        });
    }

    return { claimDelivery, acknowledgeDelivery, recordDeliveryFailure, readDeliveryMirrors };
}

const defaultJournal = createPlaybackStartupTraceDeliveryJournal();

export const claimPlaybackStartupDelivery = input => defaultJournal.claimDelivery(input);
export const acknowledgePlaybackStartupDelivery = input => defaultJournal.acknowledgeDelivery(input);
export const failPlaybackStartupDelivery = input => defaultJournal.recordDeliveryFailure(input);
export const readPlaybackStartupDeliveryMirrors = requests => defaultJournal.readDeliveryMirrors(requests);
export { createPlaybackStartupTraceDeliveryJournal, serializeDeliveryPayload as serializePlaybackStartupDelivery };
