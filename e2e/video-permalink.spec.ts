import { expect, login, test } from './fixtures';

// Regression coverage for the durable video permalink feature and the two
// bugs found while building it this session (commit 634485a0de):
//   - appRouter.showVideoOsd(item) must encode id/serverId in the /video url
//     as soon as playback starts, with no user action required.
//   - reloading that url must resume playback, not bounce to /home.
test('video url becomes a durable permalink that survives a reload', async ({ page, config }) => {
    await login(page, config.username, config.password);

    await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}`);

    // The details page always renders one .btnPlay in .mainDetailButtons;
    // its title toggles between Play/Resume via JS, the class never changes.
    const playButton = page.locator('.mainDetailButtons .btnPlay');
    await playButton.click();

    await page.waitForURL(/#\/video\?id=/, { timeout: 60_000 });
    const urlAfterPlay = new URL(page.url());
    expect(urlAfterPlay.hash).toContain(`id=${config.itemId}`);
    expect(urlAfterPlay.hash).toContain(`serverId=${config.serverId}`);

    await page.reload();

    // The reload-redirects-home bug (bindToPlayer(null) double-call crash)
    // would send us back to #/home within a couple of seconds. Give it a
    // moment to happen, then assert we're still on the video route.
    await page.waitForTimeout(3_000);
    expect(page.url()).toContain(`#/video?id=${config.itemId}`);

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 30_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2); // HAVE_CURRENT_DATA: a real frame has decoded, not just a stalled load
});
