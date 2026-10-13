// SlopTank modification notice: added or changed by SlopTank on 2026-10-14.
import { beforeEach, describe, expect, it } from 'vitest';

// Enter the graph the way the router suites do (apiclient entry first):
// the dashboard <-> ServerConnections cycle only resolves when the
// api-client singleton evaluates before the dashboard helper, and the
// view loader imports the helper first.
import 'lib/jellyfin-apiclient';
import { loadView } from './viewContainer';
import jq from 'jquery';

// jsdom in this configuration does not execute scripts at all, so these
// controls assert the structural contract the jQuery insertion path needs
// (the page's script travels INTO the live view, where insertion evaluates
// it in a real browser); execution itself is proven by the real-Chromium
// browser matrix against the real daemon.
describe('legacy view loader script handling', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div class="mainAnimatedPages"></div>';
        // The webpack build exposes jQuery through expose-loader; vitest has
        // no loader pipeline, so the view loader's jQuery insertion path
        // needs the globals set directly.
        window.$ = window.jQuery = jq;
    });

    it('folds a plugin page script authored after the page div into the view', async () => {
        // Standalone-authored plugin pages (a full HTML document the server
        // used to serve as the whole page) carry their script as a sibling
        // that follows the page div. The view manager persists only the
        // page div, so the loader must fold that script into the view or
        // the page renders inert in the dashboard app.
        const view = '<div data-role="page" id="probePage"><div id="probeMark"></div></div>'
            + '<script type="text/javascript">window.__sloptankViewScriptProbe = 42;</script>';

        await loadView({ url: '/web/configurationpage?name=Probe', view });

        const inserted = document.querySelector('#probePage');
        expect(inserted).not.toBeNull();
        expect(inserted.querySelector('script')).not.toBeNull();
    });

    it('keeps a script authored inside the page div in the view', async () => {
        const view = '<div data-role="page" id="probePage"><div id="probeMark"></div>'
            + '<script type="text/javascript">window.__sloptankViewScriptProbe = 42;</script></div>';

        await loadView({ url: '/web/configurationpage?name=Probe', view });

        const inserted = document.querySelector('#probePage');
        expect(inserted).not.toBeNull();
        expect(inserted.querySelector('script')).not.toBeNull();
    });
});
