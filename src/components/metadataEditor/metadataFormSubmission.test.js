// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Records every {text, title} the app sends across the alert seam.
 * components/alert itself is platform-bound dialog UI that cannot render
 * under jsdom (see .claude/mock-allowlist.yaml); the recorded text is the
 * final translated message the user would see.
 */
const alertCalls = vi.hoisted(() => []);
vi.mock('../alert', () => ({
    default: (text, title) => {
        alertCalls.push({ text, title });
        return Promise.resolve();
    }
}));

import loading from '../loading/loading';
import globalize from '../../lib/globalize';

import { submitUpdatedItem } from './metadataFormSubmission';

/**
 * The server boundary: an offline api client implementing exactly the
 * contract submitUpdatedItem uses (updateItem, ajax, getUrl), the same
 * production-seam approach as playbackmanager.test.js. A refused save
 * rejects with a real Response whose body is the server's ProblemDetails
 * JSON, because that is what the legacy apiclient's fetchWithFailover
 * rejects with on every HTTP error status.
 */
function offlineApiClient(updateItemResult) {
    return {
        getUrl: (path) => path,
        ajax: () => Promise.resolve({}),
        updateItem: () => updateItemResult
    };
}

function refusedResponse() {
    return new Response(
        JSON.stringify({
            title: 'content-mismatch',
            detail: "Current content for '/media/TV/The Pitt/Season 02' does not match capsule '6a466e1d'."
        }),
        { status: 409, statusText: 'Conflict', headers: { 'Content-Type': 'application/json' } }
    );
}

function editorForm() {
    const form = document.createElement('form');
    const contentType = document.createElement('select');
    contentType.id = 'selectContentType';
    contentType.value = '';
    form.appendChild(contentType);
    return form;
}

const item = { Id: 'item-1', Name: 'The Pitt' };

function loadingLayerActive() {
    const layer = document.querySelector('.docspinner');
    return layer !== null && layer.classList.contains('mdlSpinnerActive');
}

describe('metadata form submission outcome reporting', () => {
    afterEach(() => {
        alertCalls.length = 0;
        loading.hide();
    });

    it('surfaces a refused save instead of leaving the spinner up forever', async () => {
        loading.show();
        expect(loadingLayerActive()).toBe(true);

        const saved = [];
        submitUpdatedItem(
            offlineApiClient(Promise.reject(refusedResponse())),
            editorForm(),
            item,
            { metadataEditorInfo: { ContentType: '' }, onSaved: () => saved.push(true) });

        await vi.waitFor(() => expect(alertCalls).toHaveLength(1));

        expect(loadingLayerActive()).toBe(false);
        expect(saved).toHaveLength(0);
        expect(alertCalls[0].title).toBe(globalize.translate('HeaderError'));
        expect(alertCalls[0].text).toContain('content-mismatch');
        expect(alertCalls[0].text).toContain("does not match capsule '6a466e1d'");
    });

    it('keeps the success path intact: toast framing, loading hidden, editor closed', async () => {
        loading.show();

        const saved = [];
        submitUpdatedItem(
            offlineApiClient(Promise.resolve({})),
            editorForm(),
            item,
            { metadataEditorInfo: { ContentType: '' }, onSaved: () => saved.push(true) });

        await vi.waitFor(() => expect(saved).toHaveLength(1));

        expect(alertCalls).toHaveLength(0);
        expect(loadingLayerActive()).toBe(false);
    });
});
