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
