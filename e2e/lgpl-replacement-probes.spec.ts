// SlopTank modification notice: added or changed by SlopTank on 2026-09-15.
/**
 * LGPL replacement-boundary probes (private release-evidence runs).
 *
 * These run ONLY against a probe server (tools/sloptank_lgpl_web_probe_server.py)
 * that serves a disposable copy of a release candidate whose
 * libraries/subtitles-octopus-worker*.js or *.wasm bytes were modified by
 * tools/sloptank_lgpl_web_probes.py. SLOPTANK_LGPL_PROBE names the scenario;
 * the suite is selected via `--project=lgpl-probes` (see playwright.config.ts)
 * and never runs in an ordinary regression pass.
 *
 * The browser-side assertion is only what a user can see: the item plays and
 * the libass canvas is presented. The boundary evidence itself (modified-copy
 * beacons from inside the worker, WASM fetch status) is read server-side from
 * the probe server's JSONL log by the orchestrator, because worker-context
 * requests are not reliably attributed to the page in Playwright.
 */

import { expect, login, requireAssSubtitleItemId, test, VIDEO_ROUTE } from './fixtures';

const SCENARIO = process.env.SLOPTANK_LGPL_PROBE || '';

test.describe(`LGPL replacement probe: ${SCENARIO || 'not requested'}`, () => {
    test('the item plays and presents the libass canvas over the modified boundary', async ({ page, config }) => {
        test.setTimeout(180_000);

        if (!SCENARIO) {
            throw new Error( // allow-raw-error: evidence-run setup fast-fail, not user-facing app code
                'SLOPTANK_LGPL_PROBE scenario is required: run via --project=lgpl-probes '
                + 'with tools/sloptank_lgpl_web_probes.py, never as an ordinary e2e run');
        }

        if (SCENARIO === 'legacy-worker-fallback') {
            // The library picks the legacy worker when WebAssembly is absent
            // (see @jellyfin/libass-wasm subtitles-octopus.js: the
            // supportsWebAssembly branch swaps workerUrl for
            // legacyWorkerUrl). Hide WebAssembly before the app boots, the
            // way a legacy-browser recipient would arrive, so the player must
            // load the modified legacy worker.
            await page.addInitScript(() => {
                delete (window as { WebAssembly?: unknown }).WebAssembly;
            });
        }

        await login(page, config.username, config.password);
        await page.goto(`/web/#/details?id=${requireAssSubtitleItemId()}&serverId=${config.serverId}`);
        await page.locator('.mainDetailButtons .btnPlay:visible').click();
        await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });

        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 20_000 });
        await expect
            .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 30_000 })
            .toBe(true);

        const canvas = page.locator(
            '.libassjs-canvas-parent:not(.libassjs-canvas-parent-secondary) .libassjs-canvas'
        );
        await expect(canvas.first()).toBeVisible({ timeout: 30_000 });
    });
});
