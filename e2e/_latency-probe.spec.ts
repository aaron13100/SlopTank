// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15, 2026-09-16, 2026-09-18.
import { test } from '@playwright/test';
import { login } from './fixtures';

/**
 * Phase-level latency probe for the live site: where do login seconds and
 * click-to-playing seconds actually go? Logs one LAT line per phase so the
 * output can be diffed against the owner's budgets (ideal <1s login, <3s
 * playback; never seem-broken >10s) and the dominant phase attacked first.
 *
 * Env: E2E_USERNAME, E2E_PASSWORD, E2E_BASE_URL, LIVE_ITEM_ID.
 */
const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;

// LIVE_ITEM_ID is normally injected per-run by tools/live_site_smoke.sh.
// Running this spec through the plain full-suite command leaves it unset,
// same as _verify-live-playback.spec.ts (fixed 2026-09-16): default to the
// standing "always playable" fixture so the spec is a real regression test
// in both contexts.
const ITEM_ID = process.env.LIVE_ITEM_ID || process.env.E2E_RENTAL_FAMILY_ITEM_ID;
if (!ITEM_ID) {
    throw new Error( // allow-raw-error: e2e setup fast-fail, not app code
        'Missing item id: set LIVE_ITEM_ID or E2E_RENTAL_FAMILY_ITEM_ID for the latency probe');
}

test.setTimeout(180_000);

test('latency probe: login and playback phases', async ({ page }) => {
    const marks: Record<string, number> = {};
    const mark = (name: string) => { marks[name] = Date.now(); };
    const report = (from: string, to: string) => Date.now() - marks[from];

    const playbackInfo: number[] = [];
    page.on('response', (response) => {
        if (response.url().includes('/PlaybackInfo')) {
            playbackInfo.push(Date.now());
        }
    });

    mark('start');
    await page.goto('/web/#/login', { waitUntil: 'commit' });
    mark('login-commit');
    await page.waitForLoadState('domcontentloaded');
    mark('login-dcl');
    await page.waitForLoadState('load');
    mark('login-load');
    await login(page, USERNAME, PASSWORD);
    mark('login-done');

    await page.goto(`/details?id=${ITEM_ID}`, { waitUntil: 'domcontentloaded' });
    mark('detail-dcl');
    // The details page renders both a Play button and, once the item has a
    // resume position, a hidden Resume variant of the same class; target the
    // visible one or the locator parks on the hidden variant forever.
    const play = page.locator('.btnPlay:visible').first();
    await play.waitFor({ state: 'visible', timeout: 60_000 });
    mark('play-visible');
    await play.click();
    mark('clicked');
    const video = page.locator('video').first();
    await video.waitFor({ state: 'visible', timeout: 60_000 });
    mark('video-element');
    await page.waitForFunction(
        () => {
            const el = document.querySelector('video');
            return !!el && el.readyState >= 2 && el.currentTime > 0;
        },
        { timeout: 90_000 });
    mark('playing');

    const navigation = await page.evaluate(() => {
        const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        return entries[0]
            ? { dcl: Math.round(entries[0].domContentLoadedEventEnd), load: Math.round(entries[0].loadEventEnd) }
            : { dcl: -1, load: -1 };
    });

    console.log(`LAT login: commit=${report('start', 'login-commit')}ms dcl=${report('login-commit', 'login-dcl')}ms load=${report('login-dcl', 'login-load')}ms form+auth=${report('login-load', 'login-done')}ms total=${report('start', 'login-done')}ms`);
    console.log(`LAT detail: dcl=${report('login-done', 'detail-dcl')}ms playVisible=${report('detail-dcl', 'play-visible')}ms`);
    console.log(`LAT play: clickToVideo=${report('clicked', 'video-element')}ms videoToData=${report('video-element', 'playing')}ms clickToPlaying=${report('clicked', 'playing')}ms playbackInfoResponses=${playbackInfo.length}`);
    console.log(`LAT nav-timing-last-page: dcl=${navigation.dcl}ms load=${navigation.load}ms`);
});
