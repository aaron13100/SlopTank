// SlopTank modification notice: added or changed by SlopTank on 2026-10-01.
// SlopTank regression (c274 lever 2): /Items/{id}/Similar must not be fetched
// until the Similar section is observed intersecting the viewport.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ServerConnections } from 'lib/jellyfin-apiclient';
import renderSimilarItems, { disposeSimilarItems } from './similarItemsRenderer';

/**
 * Drives the real renderer, the real cardBuilder and the real imageLoader.
 * Only two boundaries are test-configured, both external to the app and both
 * through production seams (same approach as playbackmanager.test.js):
 *  - the Jellyfin server: a recording apiClient registered through
 *    ServerConnections.addApiClient(); no server exists under vitest
 *  - IntersectionObserver: a browser platform API that jsdom does not
 *    implement; the harness below lets a test decide when the observed
 *    section "scrolls into view"
 */
const SERVER_ID = 'similar-test-server';

/** Browser-platform viewport observer: tests trigger intersection by hand. */
const viewport = {
    observers: [],
    reset() {
        this.observers = [];
    }
};

class ScriptedIntersectionObserver {
    constructor(callback) {
        this.callback = callback;
        this.observed = [];
        this.disconnected = false;
        viewport.observers.push(this);
    }

    observe(el) {
        this.observed.push(el);
    }

    disconnect() {
        this.disconnected = true;
    }

    scrollIntoView(isIntersecting) {
        // A disconnected platform observer never delivers entries again.
        if (this.disconnected) {
            return;
        }
        this.callback([{ isIntersecting }], this);
    }
}

/** Recording server client; `respond` decides each getSimilarItems outcome. */
const server = {
    calls: [],
    respond: () => Promise.resolve({ Items: [{ Id: 'a', Name: 'Alpha', ServerId: SERVER_ID, Type: 'Movie' }] }),
    reset() {
        this.calls = [];
        this.respond = () => Promise.resolve({ Items: [{ Id: 'a', Name: 'Alpha', ServerId: SERVER_ID, Type: 'Movie' }] });
    }
};

function createRecordingApiClient() {
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
        getSimilarItems(itemId, options) {
            server.calls.push({ itemId, options });
            return server.respond();
        },
        getScaledImageUrl: () => 'https://jellyfin.test.invalid/img.jpg'
    };
}

function makePage() {
    const page = document.createElement('div');
    page.innerHTML = '<div id="similarCollapsible" class="hide"><div class="similarContent"></div></div>';
    document.body.appendChild(page);
    return page;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10));
const movie = { Id: 'item-1', ServerId: SERVER_ID, Type: 'Movie' };

describe('renderSimilarItems deferral', () => {
    beforeAll(() => {
        ServerConnections.addApiClient(createRecordingApiClient());
    });

    beforeEach(() => {
        viewport.reset();
        server.reset();
        globalThis.IntersectionObserver = ScriptedIntersectionObserver;
    });

    afterEach(() => {
        delete globalThis.IntersectionObserver;
        document.body.innerHTML = '';
    });

    it('does not fetch before the section intersects', async () => {
        const page = makePage();
        renderSimilarItems(page, movie, 'movies');
        await flush();

        expect(viewport.observers).toHaveLength(1);
        expect(viewport.observers[0].observed[0]).toBe(page.querySelector('#similarCollapsible'));
        expect(server.calls).toHaveLength(0);

        viewport.observers[0].scrollIntoView(false);
        await flush();
        expect(server.calls).toHaveLength(0);
    });

    it('fetches exactly once after the section intersects and renders the cards', async () => {
        const page = makePage();
        renderSimilarItems(page, movie, 'movies');

        viewport.observers[0].scrollIntoView(true);
        viewport.observers[0].scrollIntoView(true);
        await flush();

        expect(server.calls).toHaveLength(1);
        expect(server.calls[0].itemId).toBe('item-1');
        expect(server.calls[0].options).toMatchObject({ userId: 'user-1', limit: 12 });
        expect(viewport.observers[0].disconnected).toBe(true);
        const section = page.querySelector('#similarCollapsible');
        expect(section.classList.contains('hide')).toBe(false);
        expect(section.querySelector('.similarContent .card')).not.toBeNull();
    });

    it('disposeSimilarItems disconnects the observer so nothing is fetched', async () => {
        const page = makePage();
        renderSimilarItems(page, movie, 'movies');
        disposeSimilarItems(page);

        expect(viewport.observers[0].disconnected).toBe(true);
        viewport.observers[0].scrollIntoView(true);
        await flush();
        expect(server.calls).toHaveLength(0);
    });

    it('a stale render late response does not write into the page', async () => {
        const page = makePage();
        let resolveLate;
        server.respond = () => new Promise(resolve => {
            resolveLate = resolve;
        });

        renderSimilarItems(page, movie, 'movies');
        viewport.observers[0].scrollIntoView(true);
        expect(server.calls).toHaveLength(1);

        disposeSimilarItems(page);
        resolveLate({ Items: [{ Id: 'stale', Name: 'Stale', ServerId: SERVER_ID, Type: 'Movie' }] });
        await flush();

        expect(page.querySelector('.similarContent').innerHTML).toBe('');
    });

    it('a superseded render does not write when a newer render owns the page', async () => {
        const page = makePage();
        let resolveLate;
        server.respond = () => new Promise(resolve => {
            resolveLate = resolve;
        });

        renderSimilarItems(page, movie, 'movies');
        viewport.observers[0].scrollIntoView(true);
        renderSimilarItems(page, { ...movie, Id: 'item-2' }, 'movies');
        resolveLate({ Items: [{ Id: 'stale', Name: 'Stale', ServerId: SERVER_ID, Type: 'Movie' }] });
        await flush();

        expect(page.querySelector('.similarContent').innerHTML).toBe('');
        expect(viewport.observers[1].disconnected).toBe(false);
    });

    it('hides the section and never fetches for an unsupported item type', async () => {
        const page = makePage();
        renderSimilarItems(page, { Id: 'ep', ServerId: SERVER_ID, Type: 'Episode' }, 'tvshows');
        await flush();

        expect(page.querySelector('#similarCollapsible').classList.contains('hide')).toBe(true);
        expect(viewport.observers).toHaveLength(0);
        expect(server.calls).toHaveLength(0);
    });
});
