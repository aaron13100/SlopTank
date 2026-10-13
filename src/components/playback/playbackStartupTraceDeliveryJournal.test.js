// SlopTank modification notice: added or changed by SlopTank on 2026-10-13.
import { describe, expect, it } from 'vitest';

import { createPlaybackStartupTraceDeliveryJournal } from './playbackStartupTraceDeliveryJournal';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const SERVER_ID = 'journal-test-server';

function key(row) {
    return JSON.stringify([row.serverId, row.attemptId, row.phase]);
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function payloadTemplate({ serverId = SERVER_ID, attemptId, phase = 'incident', status = 'incident', pendingStage = 'item-fetch', marker = 0, attemptStartedAtMs = NOW }) {
    return JSON.stringify({
        version: 1,
        attemptId,
        phase,
        startedAt: new Date(attemptStartedAtMs).toISOString(),
        elapsedMs: marker,
        itemId: `item-${attemptId}`,
        serverId,
        status,
        pendingStage,
        events: [{ stage: pendingStage, elapsedMs: marker, outcome: 'begin' }],
        mediaSnapshot: {}
    });
}

function input(attemptId, phase = 'incident', options = {}) {
    const attemptStartedAtMs = options.attemptStartedAtMs ?? NOW;
    return {
        serverId: options.serverId || SERVER_ID,
        attemptId,
        phase,
        attemptStartedAtMs,
        payloadTemplate: options.payloadTemplate || payloadTemplate({ attemptId, phase, attemptStartedAtMs }),
        documentEpoch: options.documentEpoch || `document-${attemptId}`
    };
}

function journalRow(attemptId, phase, { active = false } = {}) {
    const claimId = `seed-${attemptId}-${phase}`;
    return {
        schemaVersion: 1,
        serverId: SERVER_ID,
        attemptId,
        phase,
        attemptStartedAtMs: NOW,
        attemptExpiresAtMs: NOW + TTL_MS,
        deliveryCount: 1,
        acknowledged: !active,
        claimHistory: [{ claimId, ordinal: 1 }],
        firstPayloadTemplate: active ? payloadTemplate({ attemptId, phase }) : null,
        activeClaim: active ? {
            claimId,
            ordinal: 1,
            documentEpoch: 'seed-document',
            claimedAtMs: NOW,
            expiresAtMs: NOW + CLAIM_LEASE_TEST_MS
        } : null,
        retryNotBeforeMs: null
    };
}

function memoryAdapter({ strictSupported = true, blocked = false, mismatchReadback = false, delayMs = 0, putFailure } = {}) {
    const rows = new Map();
    const transactions = [];
    let serial = Promise.resolve();
    let transactionIndex = 0;
    return {
        transactions,
        async transact(mode, durability, handler, context) {
            const previous = serial;
            let release;
            serial = new Promise(resolve => {
                release = resolve;
            });
            await previous;
            try {
                transactionIndex++;
                transactions.push({ mode, durability: durability || null });
                if (blocked) throw Object.assign(new Error('blocked'), { reasonCode: 'open-blocked' });
                if (mode === 'readwrite' && durability === 'strict' && !strictSupported) {
                    throw Object.assign(new Error('strict unsupported'), { reasonCode: 'durability-unsupported' });
                }
                if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
                if (context.signal.aborted || Date.now() >= context.deadlineAt) {
                    throw Object.assign(new Error('deadline'), { reasonCode: 'operation-timeout' });
                }
                const working = new Map(Array.from(rows, ([rowKey, row]) => [rowKey, clone(row)]));
                const values = Array.from(working.values()).map(clone);
                const operations = {
                    put(row) {
                        if (putFailure) throw Object.assign(new Error('write refused'), { reasonCode: putFailure });
                        working.set(key(row), clone(row));
                    },
                    delete(rowKey) {
                        working.delete(JSON.stringify(rowKey));
                    }
                };
                const result = handler(values, operations);
                if (mode === 'readwrite') {
                    rows.clear();
                    for (const [rowKey, row] of working) rows.set(rowKey, row);
                }
                if (mismatchReadback && mode === 'readonly' && transactionIndex > 1) return undefined;
                return clone(result);
            } finally {
                release();
            }
        },
        snapshot() {
            return Array.from(rows.values()).map(clone);
        },
        seed(row) {
            rows.set(key(row), clone(row));
        }
    };
}

function makeJournal(adapter, now = () => NOW, prefix = 'claim') {
    let id = 0;
    return createPlaybackStartupTraceDeliveryJournal({
        adapter,
        now,
        makeId: () => `${prefix}-${++id}`
    });
}

function lateOpenIndexedDb({ blocked = false } = {}) {
    let request;
    let closeCount = 0;
    let transactionCount = 0;
    const database = {
        close() {
            closeCount++;
        },
        transaction() {
            transactionCount++;
            throw new Error('late open must not start a transaction');
        }
    };
    return {
        indexedDB: {
            open() {
                request = {};
                if (blocked) queueMicrotask(() => request.onblocked?.());
                return request;
            }
        },
        resolveLateSuccess() {
            request.result = database;
            request.onsuccess?.();
        },
        get closeCount() { return closeCount; },
        get transactionCount() { return transactionCount; }
    };
}

describe('playback startup trace delivery journal', () => {
    it('serializes two document instances and grants only one live ordinal', async () => {
        const adapter = memoryAdapter();
        const first = makeJournal(adapter, () => NOW, 'first');
        const second = makeJournal(adapter, () => NOW, 'second');
        const request = input('attempt-race');

        const [left, right] = await Promise.all([first.claimDelivery(request), second.claimDelivery(request)]);

        expect([left.kind, right.kind].sort((leftKind, rightKind) => leftKind.localeCompare(rightKind))).toEqual(['claimed', 'defer']);
        expect(adapter.snapshot()[0].deliveryCount).toBe(1);
        expect(adapter.snapshot()[0].activeClaim.ordinal).toBe(1);
    });

    it('commits strictly before an independent readonly claim readback', async () => {
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter);

        const result = await journal.claimDelivery(input('attempt-readback'));

        expect(result.kind).toBe('claimed');
        expect(adapter.transactions.slice(0, 2)).toEqual([
            { mode: 'readwrite', durability: 'strict' },
            { mode: 'readonly', durability: null }
        ]);
    });

    it('refuses when the single operation deadline expires before completion', async () => {
        const adapter = memoryAdapter({ delayMs: 30 });
        const journal = createPlaybackStartupTraceDeliveryJournal({
            adapter,
            now: () => NOW,
            operationTimeoutMs: 5,
            makeId: () => 'deadline-claim'
        });

        await expect(journal.claimDelivery(input('attempt-deadline'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'operation-timeout'
        });
    });

    it('refuses when strict durability is unsupported', async () => {
        const journal = makeJournal(memoryAdapter({ strictSupported: false }));

        await expect(journal.claimDelivery(input('attempt-durability'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'durability-unsupported'
        });
    });

    it('refuses blocked opens and readback mismatches without returning a claim', async () => {
        const blocked = makeJournal(memoryAdapter({ blocked: true }));
        const mismatch = makeJournal(memoryAdapter({ mismatchReadback: true }));

        await expect(blocked.claimDelivery(input('attempt-blocked'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'open-blocked'
        });
        await expect(mismatch.claimDelivery(input('attempt-mismatch'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'readback-mismatch'
        });
    });

    it('closes a database returned after an open was blocked without starting a transaction', async () => {
        const facade = lateOpenIndexedDb({ blocked: true });
        const journal = createPlaybackStartupTraceDeliveryJournal({ indexedDB: facade.indexedDB });

        await expect(journal.claimDelivery(input('attempt-late-blocked-open'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'open-blocked'
        });
        facade.resolveLateSuccess();

        expect(facade.closeCount).toBe(1);
        expect(facade.transactionCount).toBe(0);
    });

    it('closes a database returned after the absolute deadline without granting a claim', async () => {
        const facade = lateOpenIndexedDb();
        const journal = createPlaybackStartupTraceDeliveryJournal({
            indexedDB: facade.indexedDB,
            operationTimeoutMs: 5
        });

        await expect(journal.claimDelivery(input('attempt-late-timeout-open'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'operation-timeout'
        });
        facade.resolveLateSuccess();

        expect(facade.closeCount).toBe(1);
        expect(facade.transactionCount).toBe(0);
    });

    it('refuses quota and aborted strict transactions without dispatch authority', async () => {
        const quota = makeJournal(memoryAdapter({ putFailure: 'quota-exceeded' }));
        const aborted = makeJournal({
            async transact() {
                throw Object.assign(new Error('aborted'), { reasonCode: 'transaction-aborted' });
            }
        });

        await expect(quota.claimDelivery(input('attempt-quota'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'quota-exceeded'
        });
        await expect(aborted.claimDelivery(input('attempt-abort'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'transaction-aborted'
        });
    });

    it('caps definite retry at ordinal two and retains a terminal tombstone', async () => {
        let time = NOW;
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter, () => time);
        const request = input('attempt-retry');
        const first = await journal.claimDelivery(request);
        await journal.recordDeliveryFailure({ ...request, claimId: first.claimId, ordinal: first.ordinal });

        time += 999;
        await expect(journal.claimDelivery(request)).resolves.toMatchObject({ kind: 'defer', retryAtMs: NOW + 1000 });
        time += 1;
        const second = await journal.claimDelivery(request);
        await journal.recordDeliveryFailure({ ...request, claimId: second.claimId, ordinal: second.ordinal });

        expect(second).toMatchObject({ kind: 'claimed', ordinal: 2 });
        expect(adapter.snapshot()[0]).toMatchObject({ deliveryCount: 2, firstPayloadTemplate: null, activeClaim: null });
        await expect(journal.claimDelivery(request)).resolves.toEqual({ kind: 'done' });
    });

    it('defers an unsettled document to its unchanged lease then grants one ordinal two', async () => {
        let time = NOW;
        const adapter = memoryAdapter();
        const first = makeJournal(adapter, () => time, 'first');
        const second = makeJournal(adapter, () => time, 'second');
        const request = input('attempt-lost-response');
        const ordinalOne = await first.claimDelivery(request);

        time += 29_999;
        await expect(second.claimDelivery(request)).resolves.toMatchObject({ kind: 'defer', retryAtMs: NOW + 30_000 });
        time += 1;
        const ordinalTwo = await second.claimDelivery(request);

        expect(ordinalTwo).toMatchObject({ kind: 'claimed', ordinal: 2, payloadTemplate: request.payloadTemplate });
        await expect(first.claimDelivery(request)).resolves.toMatchObject({ kind: 'defer' });
        time += CLAIM_LEASE_TEST_MS;
        await expect(first.claimDelivery(request)).resolves.toEqual({ kind: 'done' });
        expect(ordinalOne.ordinal).toBe(1);
    });

    it('accepts a late ordinal-one success after ordinal two was claimed', async () => {
        let time = NOW;
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter, () => time);
        const request = input('attempt-late-ack');
        const first = await journal.claimDelivery(request);
        time += 30_000;
        const second = await journal.claimDelivery(request);

        await expect(journal.acknowledgeDelivery({ ...request, claimId: first.claimId, ordinal: first.ordinal }))
            .resolves.toMatchObject({ kind: 'committed', applied: true });
        expect(adapter.snapshot()[0]).toMatchObject({
            deliveryCount: 2,
            acknowledged: true,
            activeClaim: null,
            firstPayloadTemplate: null
        });
        expect(second.ordinal).toBe(2);
    });

    it('does not expire an active claim when the wall clock moves backwards', async () => {
        let time = NOW;
        const adapter = memoryAdapter();
        const first = makeJournal(adapter, () => time, 'first');
        const second = makeJournal(adapter, () => time, 'second');
        const request = input('attempt-clock-rollback');
        await first.claimDelivery(request);
        time -= 5_000;

        await expect(second.claimDelivery(request)).resolves.toMatchObject({ kind: 'defer', retryAtMs: NOW + 30_000 });
        expect(adapter.snapshot()[0].deliveryCount).toBe(1);
    });

    it('reuses the exact first payload template for ordinal two', async () => {
        let time = NOW;
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter, () => time);
        const firstInput = input('attempt-template', 'incident', { payloadTemplate: payloadTemplate({ attemptId: 'attempt-template', marker: 7 }) });
        const first = await journal.claimDelivery(firstInput);
        time += CLAIM_LEASE_TEST_MS;
        const laterInput = input('attempt-template', 'incident', { payloadTemplate: payloadTemplate({ attemptId: 'attempt-template', marker: 99 }) });

        const second = await journal.claimDelivery(laterInput);

        expect(second).toMatchObject({ kind: 'claimed', ordinal: 2, payloadTemplate: firstInput.payloadTemplate });
        expect(second.payloadTemplate).not.toBe(laterInput.payloadTemplate);
        expect(first.kind).toBe('claimed');
    });

    it('refuses malformed templates, row corruption, and wrong bindings', async () => {
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter);
        const request = input('attempt-malformed');
        await expect(journal.claimDelivery({ ...request, payloadTemplate: '{"version":1}' })).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'invalid-template'
        });
        await expect(journal.claimDelivery(input('attempt-wrong-start', 'incident', {
            attemptStartedAtMs: NOW + 1,
            payloadTemplate: payloadTemplate({ attemptId: 'attempt-wrong-start' })
        }))).resolves.toMatchObject({ kind: 'refused', reasonCode: 'invalid-template' });
        await journal.claimDelivery(request);
        const row = adapter.snapshot()[0];
        row.serverId = 'wrong-server';
        adapter.seed(row);
        await expect(journal.claimDelivery(request)).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'malformed-row'
        });
    });

    it('refuses a second phase whose immutable start differs from the first phase', async () => {
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter);
        const incident = input('attempt-cross-phase-start', 'incident');
        const claim = await journal.claimDelivery(incident);
        await journal.acknowledgeDelivery({ ...incident, claimId: claim.claimId, ordinal: claim.ordinal });

        await expect(journal.claimDelivery(input('attempt-cross-phase-start', 'completion', {
            attemptStartedAtMs: NOW + 1
        }))).resolves.toMatchObject({ kind: 'refused', reasonCode: 'binding-mismatch' });
        expect(adapter.snapshot()).toHaveLength(1);
    });

    it('keeps acknowledged tombstones against stale realms and rejects expired input before lookup', async () => {
        let time = NOW;
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter, () => time);
        const request = input('attempt-tombstone');
        const claim = await journal.claimDelivery(request);
        await journal.acknowledgeDelivery({ ...request, claimId: claim.claimId, ordinal: claim.ordinal });

        await expect(journal.claimDelivery(request)).resolves.toEqual({ kind: 'done' });
        time = NOW + TTL_MS;
        await expect(journal.claimDelivery(request)).resolves.toMatchObject({ kind: 'refused', reasonCode: 'attempt-expired' });
        expect(adapter.snapshot()).toHaveLength(1);
    });

    it('cleans expired rows only at immutable expiry and never recreates an old attempt', async () => {
        let time = NOW;
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter, () => time);
        const request = input('attempt-expiry-cleanup');
        const claim = await journal.claimDelivery(request);
        await journal.acknowledgeDelivery({ ...request, claimId: claim.claimId, ordinal: claim.ordinal });

        time = NOW + TTL_MS - 1;
        await journal.claimDelivery(input('attempt-current'));
        expect(adapter.snapshot().some(row => row.attemptId === request.attemptId)).toBe(true);
        time = NOW + TTL_MS;
        await journal.claimDelivery(input('attempt-after-expiry', 'incident', { attemptStartedAtMs: time }));
        expect(adapter.snapshot().some(row => row.attemptId === request.attemptId)).toBe(false);
        await expect(journal.claimDelivery(request)).resolves.toMatchObject({ kind: 'refused', reasonCode: 'attempt-expired' });
    });

    it('refuses a new attempt at the 128-attempt cap without evicting a tombstone', async () => {
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter);
        for (let index = 0; index < 128; index++) {
            const request = input(`attempt-cap-${index}`);
            const claim = await journal.claimDelivery(request);
            await journal.acknowledgeDelivery({ ...request, claimId: claim.claimId, ordinal: claim.ordinal });
        }

        await expect(journal.claimDelivery(input('attempt-cap-overflow'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'attempt-capacity'
        });
        expect(adapter.snapshot()).toHaveLength(128);
    });

    it('refuses a new phase at the 256-row cap but allows an existing row to settle', async () => {
        const adapter = memoryAdapter();
        const journal = makeJournal(adapter);
        for (let index = 0; index < 128; index++) {
            const attemptId = `attempt-row-cap-${index}`;
            for (const phase of ['incident', 'completion']) {
                adapter.seed(journalRow(attemptId, phase, { active: index === 0 && phase === 'incident' }));
            }
        }

        await expect(journal.claimDelivery(input('attempt-row-overflow'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'attempt-capacity'
        });
        const existing = input('attempt-row-cap-0', 'incident');
        await expect(journal.acknowledgeDelivery({ ...existing, claimId: 'seed-attempt-row-cap-0-incident', ordinal: 1 }))
            .resolves.toMatchObject({ kind: 'committed', applied: true });
        const read = await journal.readDeliveryMirrors([existing]);
        expect(read).toMatchObject({ kind: 'read', rows: [expect.objectContaining({ deliveries: 1, acknowledged: true })] });
        expect(adapter.snapshot()).toHaveLength(256);
    });

    it('fails closed when IndexedDB is unavailable', async () => {
        const journal = createPlaybackStartupTraceDeliveryJournal({ indexedDB: null });

        await expect(journal.claimDelivery(input('attempt-no-indexeddb'))).resolves.toMatchObject({
            kind: 'refused', reasonCode: 'indexeddb-unavailable'
        });
    });
});

const CLAIM_LEASE_TEST_MS = 30_000;
