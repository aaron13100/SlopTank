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

    await page.goto(`/details?id=${process.env.LIVE_ITEM_ID}`, { waitUntil: 'domcontentloaded' });
    mark('detail-dcl');
    const play = page.locator('.btnPlay').first();
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
