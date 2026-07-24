import { expect, login, test } from './fixtures';

test.setTimeout(60_000);

// Real, permanent IMDb id already present in this library's metadata (2001: A
// Space Odyssey, ProviderIds.Imdb). Hardcoded rather than read from
// .env.e2e.local: an IMDb id is exactly the kind of value this feature makes
// safe to hardcode -- unlike an internal item GUID, it never changes.
const REAL_IMDB_ID = 'tt0062622';
const REAL_IMDB_TITLE = '2001: A Space Odyssey';

test.describe('pretty permalinks (docs/internal/permalink-url-design.md)', () => {
    test('opening #/p/<imdb id> for a real item redirects to its details page', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/web/#/p/${REAL_IMDB_ID}`);

        await page.waitForURL(/#\/details\?id=/, { timeout: 20_000 });
        await expect(page.getByRole('heading', { name: REAL_IMDB_TITLE })).toBeVisible({ timeout: 20_000 });
    });

    test('opening #/w/<imdb id> for a real item redirects to the video route and starts playback', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/web/#/w/${REAL_IMDB_ID}`);

        await page.waitForURL(/#\/video\?id=/, { timeout: 20_000 });
        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 20_000 });
        await expect
            .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
            .toBeGreaterThanOrEqual(2);
    });

    test('a well-formed but unmatched permalink shows a not-found message, never a guess', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto('/web/#/p/tt0000001');

        await expect(page.locator('#permalinkMessagePage')).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('#permalinkMessagePage')).toContainText('tt0000001');
    });

    test('a malformed permalink id shows an invalid-link message without any network lookup', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto('/web/#/p/not-a-real-permalink');

        await expect(page.locator('#permalinkMessagePage')).toBeVisible({ timeout: 20_000 });
    });

    test('a previously shared #/details?...&autoplay=1 link still starts playback (regression: autoplay was silently dropped when the video route became the durable permalink)', async ({ page, config }) => {
        await login(page, config.username, config.password);

        await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}&autoplay=1`);

        await page.waitForURL(/#\/video\?id=/, { timeout: 20_000 });
        const video = page.locator('video').first();
        await expect(video).toBeVisible({ timeout: 20_000 });
        await expect
            .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
            .toBeGreaterThanOrEqual(2);
    });
});
