// SlopTank modification notice: added or changed by SlopTank on 2026-07-18, 2026-07-19, 2026-07-23, 2026-08-01, 2026-09-09.
import { defineConfig } from '@playwright/test';

/**
 * E2E config for real-browser regression coverage of behavior the legacy
 * view/router layer cannot be unit tested for (see vite.config.ts comment
 * history / commit 634485a0de). Targets a real, already-running Jellyfin
 * instance -- this suite does not start a server itself.
 */
export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    retries: 0,
    // The disposable server has one mutable user and one playback session, and
    // local runs target a real, resource-constrained host (2-core i5-5250U @
    // 1.6GHz). Measured 2026-08-01: two workers running real playback specs
    // concurrently made every test 2-4x slower than solo, force-killed a
    // worker stuck mid-transcode after a 300s stop timeout, and failed an
    // unrelated OSD-control assertion because the page never became
    // responsive in time (e2e/player-settings.spec.ts "quality menu forces a
    // real transcode..."). The bottleneck is this host's CPU/IO budget, not a
    // Jellyfin per-user session cap, so per-worker user isolation would not
    // fix it -- pin workers everywhere so the config stops implying local
    // parallelism is safe.
    workers: 1,
    reporter: [ [ 'list' ] ],
    // No video/trace retained on success; only on failure, and cleaned up
    // between runs by `npm run test:e2e` (see package.json).
    use: {
        baseURL: process.env.E2E_BASE_URL || 'http://localhost:8096',
        trace: 'retain-on-failure',
        video: 'off',
        screenshot: 'only-on-failure'
    },
    projects: [
        {
            name: 'chromium',
            use: { channel: 'chrome' }
        }
    ]
});
