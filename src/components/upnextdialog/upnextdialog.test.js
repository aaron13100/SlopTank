// SlopTank modification notice: added or changed by SlopTank on 2026-10-07.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { ApiClient } from 'jellyfin-apiclient';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from '../../utils/events.ts';
import dom from '../../utils/dom';
import globalize from '../../lib/globalize';
import UpNextDialog from './upnextdialog';

const serverId = 'up-next-dialog-test-server';
const itemId = 'next';
let fixtureServer;
let fixtureOrigin;
let fixtureApiClient;
let userIdSequence = 0;
let dialogs;
const configuredResponses = new Map();
const pendingResponses = new Map();
const responseCompletions = new Map();
const failedUserIds = new Set();

function trackResponseCompletion(userId, response) {
    const completion = new Promise(resolve => {
        if (response.writableFinished) resolve();
        else response.once('finish', resolve);
    });
    const completions = responseCompletions.get(userId) || [];
    completions.push(completion);
    responseCompletions.set(userId, completions);
}

function userProfile(userId, enableNextEpisodeAutoPlay) {
    return {
        Id: userId,
        ServerId: serverId,
        Name: 'Fixture User',
        Configuration: { EnableNextEpisodeAutoPlay: enableNextEpisodeAutoPlay }
    };
}

function sendJson(response, statusCode, value, statusMessage) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        ...(statusMessage ? { 'status-message': statusMessage } : {})
    });
    response.end(JSON.stringify(value));
}

function holdResponse(userId, response) {
    const pending = pendingResponses.get(userId) || [];
    pending.push(response);
    pendingResponses.set(userId, pending);
}

function configureUserResponse(userId, response) {
    configuredResponses.set(userId, response);
}

function releaseNextResponse(userId, value, statusCode = 200) {
    const pending = pendingResponses.get(userId) || [];
    const response = pending.shift();
    if (!response) throw new Error(`No pending profile request for ${userId}`);
    if (!pending.length) pendingResponses.delete(userId);
    else pendingResponses.set(userId, pending);
    sendJson(response, statusCode, value, statusCode === 502 ? 'Bad Gateway' : undefined);
}

async function waitForPendingResponses(userId, count = 1) {
    const deadline = Date.now() + 3000;
    while ((pendingResponses.get(userId)?.length || 0) < count) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} profile request(s) for ${userId}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function waitForCondition(predicate, description) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function waitForStoredUser(userId) {
    const cacheKey = `user-${userId}-${serverId}`;
    await waitForCondition(() => Boolean(localStorage.getItem(cacheKey)), 'real ApiClient profile cache');
    // The ApiClient writes this real profile cache immediately before resolving
    // getCurrentUser; drain its promise continuation and the dialog continuation.
    await Promise.resolve();
    await Promise.resolve();
}

function waitForRequestFailure() {
    return new Promise(resolve => {
        const listener = (event, details) => {
            Events.off(fixtureApiClient, 'requestfail', listener);
            resolve(details);
        };
        Events.on(fixtureApiClient, 'requestfail', listener);
    });
}

function prepareUserResponse(response) {
    const userId = `up-next-user-${++userIdSequence}`;
    fixtureApiClient.setAuthenticationInfo('test-only-token', userId);
    configureUserResponse(userId, response);
    return userId;
}

function makeDialog({ parent = document.createElement('div'), id = itemId, name = 'Next Episode' } = {}) {
    const dialog = new UpNextDialog({
        parent,
        player: {
            name: 'localplayer',
            isLocalPlayer: true,
            duration: () => 240000,
            currentTime: () => 0
        },
        nextItem: { Id: id, ServerId: serverId, Type: 'Episode', Name: name }
    });
    dialogs.push(dialog);
    return { parent, dialog };
}

describe('UpNextDialog asynchronous user preferences', () => {
    beforeAll(async () => {
        document.head.insertAdjacentHTML('afterbegin', '<base href="http://127.0.0.1/web/">');
        globalize.register({ name: 'core', strings: [{ lang: 'en-us', path: 'en-us.json' }] });
        globalize.defaultModule('core');
        await globalize.loadStrings('core');

        fixtureServer = createServer((request, response) => {
            const match = request.url?.match(/^\/Users\/([^/?]+)/);
            if (request.method !== 'GET' || !match) {
                sendJson(response, 404, { error: 'Fixture route not found' });
                return;
            }

            const userId = decodeURIComponent(match[1]);
            trackResponseCompletion(userId, response);
            const configured = configuredResponses.get(userId);
            if (!configured) {
                sendJson(response, 404, { error: 'No profile fixture configured' });
                return;
            }
            if (configured.hold) {
                holdResponse(userId, response);
                return;
            }
            if (configured.statusCode) {
                sendJson(response, configured.statusCode, configured.body, configured.statusMessage);
                return;
            }
            sendJson(response, 200, userProfile(userId, configured.enableNextEpisodeAutoPlay));
        });

        await new Promise((resolve, reject) => {
            fixtureServer.once('error', reject);
            fixtureServer.listen(0, '127.0.0.1', resolve);
        });
        fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;

        fixtureApiClient = new ApiClient(fixtureOrigin, 'SlopTank Up Next Tests', '1', 'Vitest', 'up-next-tests');
        fixtureApiClient.serverInfo({
            Id: serverId,
            Name: 'Up Next test fixture',
            ManualAddress: fixtureOrigin
        });
        ServerConnections.addApiClient(fixtureApiClient);
    }, 180000);

    beforeEach(() => {
        dialogs = [];
    });

    afterEach(async () => {
        for (const dialog of dialogs) dialog.destroy();
        for (const [userId, pending] of pendingResponses) {
            while (pending.length) {
                const response = pending.shift();
                sendJson(response, 200, userProfile(userId, false));
            }
        }
        await Promise.all([...responseCompletions.values()].flat());
        for (const userId of responseCompletions.keys()) {
            if (!failedUserIds.has(userId)) await waitForStoredUser(userId);
        }
        pendingResponses.clear();
        responseCompletions.clear();
        failedUserIds.clear();
        configuredResponses.clear();
        fixtureApiClient.setAuthenticationInfo(null, null);
    });

    afterAll(async () => {
        await ServerConnections.deleteServer(serverId);
        if (fixtureServer?.listening) {
            await new Promise((resolve, reject) => {
                fixtureServer.close(error => error ? reject(error) : resolve());
                fixtureServer.closeAllConnections();
            });
        }
    });

    it('renders a static card while the real profile request remains pending', async () => {
        const userId = prepareUserResponse({ hold: true });
        const { parent } = makeDialog();
        await waitForPendingResponses(userId);

        expect(parent.classList.contains('upNextDialog-hidden')).toBe(false);
        expect(parent.querySelector('.upNextDialog-title').innerText).toBe('Next Episode');
        expect(parent.querySelector('.upNextDialog-countdownText')).toBeNull();
    });

    it('keeps the static card when the real profile disables autoplay', async () => {
        const userId = prepareUserResponse({ hold: true });
        const { parent } = makeDialog();
        await waitForPendingResponses(userId);
        releaseNextResponse(userId, userProfile(userId, false));
        await waitForStoredUser(userId);

        expect(parent.classList.contains('upNextDialog-hidden')).toBe(false);
        expect(parent.querySelector('.upNextDialog-title').innerText).toBe('Next Episode');
        expect(parent.querySelector('.upNextDialog-countdownText')).toBeNull();
    });

    it('starts the countdown after the real profile enables autoplay', async () => {
        const userId = prepareUserResponse({ hold: true });
        const { parent, dialog } = makeDialog();
        await waitForPendingResponses(userId);
        releaseNextResponse(userId, userProfile(userId, true));

        await waitForCondition(() => Boolean(parent.querySelector('.upNextDialog-countdownText')), 'autoplay countdown text');
        expect(dialog._countdownTextTimeout).toBeDefined();
        expect(dialog.showStaticNextText).toBe(false);
        expect(parent.classList.contains('upNextDialog-hidden')).toBe(false);
    });

    it('keeps the static card usable when the profile request never resolves', async () => {
        const userId = prepareUserResponse({ hold: true });
        const { parent, dialog } = makeDialog();
        await waitForPendingResponses(userId);

        expect(parent.classList.contains('upNextDialog-hidden')).toBe(false);
        expect(parent.querySelector('.upNextDialog-title').innerText).toBe('Next Episode');
        expect(parent.querySelector('.upNextDialog-countdownText')).toBeNull();
        expect(dialog._countdownTextTimeout).toBeUndefined();
    });

    it('keeps the static card visible when the profile endpoint returns an HTTP error', async () => {
        const userId = prepareUserResponse({ hold: true });
        const requestFailure = waitForRequestFailure();
        const { parent } = makeDialog();
        await waitForPendingResponses(userId);
        releaseNextResponse(userId, { error: 'preference endpoint unavailable' }, 502);
        const failure = await requestFailure;
        failedUserIds.add(userId);
        expect(failure.status).toBe(502);

        expect(parent.classList.contains('upNextDialog-hidden')).toBe(false);
        expect(parent.querySelector('.upNextDialog-title').innerText).toBe('Next Episode');
        expect(parent.querySelector('.upNextDialog-countdownText')).toBeNull();
    });

    it('ignores the actual profile response after the dialog is destroyed', async () => {
        const userId = prepareUserResponse({ hold: true });
        const { parent, dialog } = makeDialog();
        await waitForPendingResponses(userId);
        const originalTitle = parent.querySelector('.upNextDialog-title').innerText;

        dialog.destroy();
        releaseNextResponse(userId, userProfile(userId, true));
        await waitForStoredUser(userId);

        expect(parent.querySelector('.upNextDialog-title').innerText).toBe(originalTitle);
        expect(dialog._countdownTextTimeout).toBeUndefined();
    });

    it('does not let an older profile response overwrite the replacement item', async () => {
        const userId = prepareUserResponse({ hold: true });
        const first = makeDialog();
        await waitForPendingResponses(userId);
        first.dialog.destroy();

        const replacement = makeDialog({ parent: first.parent, id: 'replacement', name: 'Replacement Episode' });
        await waitForPendingResponses(userId, 2);
        releaseNextResponse(userId, userProfile(userId, true));
        await waitForStoredUser(userId);

        expect(first.parent.querySelector('.upNextDialog-title').innerText).toBe('Replacement Episode');
        expect(first.parent.querySelector('.upNextDialog-countdownText')).toBeNull();

        releaseNextResponse(userId, userProfile(userId, true));
        await waitForCondition(() => Boolean(first.parent.querySelector('.upNextDialog-countdownText')), 'replacement autoplay countdown text');
        expect(replacement.dialog._countdownTextTimeout).toBeDefined();
        expect(replacement.dialog.showStaticNextText).toBe(false);
    });

    it('cancels the real transition listener when a destroyed dialog is replaced', async () => {
        const userId = prepareUserResponse({ hold: true });
        const first = makeDialog();
        await waitForPendingResponses(userId);
        let hideEvents = 0;
        Events.on(first.dialog, 'hide', () => {
            hideEvents += 1;
        });

        const hiding = first.dialog.hide();
        first.dialog.destroy();
        makeDialog({ parent: first.parent, id: 'replacement', name: 'Replacement Episode' });
        await waitForPendingResponses(userId, 2);
        expect(first.parent.classList.contains('hide')).toBe(false);
        expect(first.parent.classList.contains('upNextDialog-hidden')).toBe(false);

        first.parent.dispatchEvent(new Event(dom.whichTransitionEvent()));
        await hiding;

        expect(first.parent.classList.contains('hide')).toBe(false);
        expect(first.parent.classList.contains('upNextDialog-hidden')).toBe(false);
        expect(hideEvents).toBe(1);
    });
});
