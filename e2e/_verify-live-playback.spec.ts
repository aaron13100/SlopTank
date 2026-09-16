// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.
import { test, expect } from '@playwright/test';
import { login } from './fixtures';

const USERNAME = process.env.E2E_USERNAME as string;
const PASSWORD = process.env.E2E_PASSWORD as string;

// LIVE_ITEM / LIVE_ITEM_ID are normally injected per-run by
// tools/live_site_smoke.sh (once per probed title). Running this spec
// through the plain full-suite command (no smoke-script wrapper, as the
// goal's "full e2e suite green twice" criterion does) left them unset, so
// the test navigated to /details?id=undefined and failed looking like a
// player bug (2026-09-16). Default to the standing "always playable"
// fixture so the spec is a real regression test in both contexts.
const ITEM_NAME = process.env.LIVE_ITEM || 'Rental Family';
const ITEM_ID = process.env.LIVE_ITEM_ID || process.env.E2E_RENTAL_FAMILY_ITEM_ID;
if (!ITEM_ID) {
    throw new Error( // allow-raw-error: e2e setup fast-fail, not app code
        'Missing item id: set LIVE_ITEM_ID or E2E_RENTAL_FAMILY_ITEM_ID for the live playback check');
}

test.setTimeout(300_000);

test(`live playback: ${ITEM_NAME} starts promptly from search`, async ({ page }) => {
    const startedAt = Date.now();
    await login(page, USERNAME, PASSWORD);
    const loginMs = Date.now() - startedAt;

    // Home page interactive after login.
    await expect(page.getByRole('button', { name: 'User Menu' })).toBeVisible({ timeout: 60_000 });
    const homeMs = Date.now() - startedAt;

    // Open the movie's detail page directly by id (the API-verified item).
    // The details page renders both a Play button and, once the item has a
    // resume position, a hidden Resume variant of the same class; target the
    // visible one or the locator parks on the hidden variant forever
    // (observed failing the nightly smoke on 2026-09-15 after the item
    // gained a resume position).
    await page.goto(`/details?id=${ITEM_ID}`);
    await expect(page.locator('.btnPlay:visible').first())
        .toBeVisible({ timeout: 60_000 });
    const detailMs = Date.now() - startedAt;

    // Play it and require actual video data, not a spinner.
    await page.locator('.btnPlay:visible').first().click();
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 120_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 180_000 })
        .toBeGreaterThanOrEqual(2);
    const playedMs = Date.now() - startedAt;

    const currentSrc = await video.evaluate((el: HTMLVideoElement) => el.currentSrc);
    console.log(`LIVE_PLAYBACK ${ITEM_NAME} login=${loginMs}ms home=${homeMs}ms detail=${detailMs}ms playing=${playedMs}ms`);
    console.log(`LIVE_PLAYBACK_SRC ${currentSrc.slice(0, 160)}`);
    await page.screenshot({ path: `/tmp/live-playback-${ITEM_NAME.replace(/[^a-z0-9]+/gi, '-')}.png` });
});
