/**
 * E2E coverage for the webpack dev server's Jellyfin media proxy.
 *
 * Dynamic HLS URLs use a lowercase `/videos/` root while direct-play URLs use
 * uppercase `/Videos/`. A case-sensitive proxy matcher therefore makes real
 * transcodes receive the webpack history-fallback HTML instead of a manifest.
 * This drives the viewer's Play button and verifies the response at that real
 * browser boundary.
 */

import { expect, login, requireControlsItemId, test } from './fixtures';

test.setTimeout(120_000);

test('the dev server proxies a lowercase HLS manifest from real playback', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await page.goto(`/web/details?id=${requireControlsItemId()}&serverId=${config.serverId}`);

    const manifestResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname.startsWith('/videos/') && url.pathname.endsWith('/master.m3u8');
    }, { timeout: 60_000 });

    await page.locator('.mainDetailButtons .btnPlay').click();

    const response = await manifestResponse;
    const contentType = response.headers()['content-type'] || '';
    const body = await response.text();
    expect(contentType).toContain('application/vnd.apple.mpegurl');
    expect(body).toContain('#EXTM3U');
});
