import { expect, login, test } from './fixtures';

test.setTimeout(120_000);

async function expectPlaybackToAdvance(video: import('@playwright/test').Locator, timeout: number) {
    await expect(video).toBeVisible({ timeout });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout })
        .toBe(false);
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout })
        .toBeGreaterThanOrEqual(2);

    const initialTime = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout })
        .toBeGreaterThan(initialTime + 0.5);
}

// Regression coverage for the durable video permalink feature and the two
// bugs found while building it this session (commit 634485a0de):
//   - appRouter.showVideoOsd(item) must encode id/serverId in the /video url
//     as soon as playback starts, with no user action required.
//   - reloading that url must resume playback, not bounce to /home.
// @covers video.permalink.reload.resumes_playback
test('video url becomes a durable permalink that survives a reload', async ({ page, config }) => {
    const browserDiagnostics: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
            browserDiagnostics.push(`console.${message.type()}: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
        browserDiagnostics.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
    });

    await login(page, config.username, config.password);

    await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}`);

    // The details page always renders one .btnPlay in .mainDetailButtons;
    // its title toggles between Play/Resume via JS, the class never changes.
    const playButton = page.locator('.mainDetailButtons .btnPlay');
    await playButton.click();

    await page.waitForURL(/#\/video\?id=/, { timeout: 60_000 });
    const video = page.locator('video').first();
    await expectPlaybackToAdvance(video, 20_000);

    // Exercise the real OSD controls. A paused or autoplay-blocked video must
    // retain a visible Play button instead of looking like a frozen page.
    await page.mouse.move(20, 20);
    await page.mouse.move(100, 100);
    const playPauseButton = page.locator('.videoOsdBottom-maincontrols .btnPause');
    await expect(playPauseButton).toBeVisible();
    await playPauseButton.click();
    await expect.poll(async () => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
    await page.waitForTimeout(4_000);
    await expect(playPauseButton).toBeVisible();
    await playPauseButton.click();
    await expectPlaybackToAdvance(video, 20_000);

    const urlAfterPlay = new URL(page.url());
    expect(urlAfterPlay.hash).toContain(`id=${config.itemId}`);
    expect(urlAfterPlay.hash).toContain(`serverId=${config.serverId}`);

    // Make both preparation phases deterministic. Completing PlaybackInfo is
    // not enough to hide the message: it must remain until the browser can
    // render an actual frame from the video response.
    await video.evaluate((el: HTMLVideoElement) => el.pause());
    await page.route('**/Items/*/PlaybackInfo*', async (route) => {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        await route.continue();
    }, { times: 1 });
    let releaseVideoResponse: () => void;
    const videoResponseGate = new Promise<void>((resolve) => {
        releaseVideoResponse = resolve;
    });
    let markVideoRequestSeen: () => void;
    const videoRequestSeen = new Promise<void>((resolve) => {
        markVideoRequestSeen = resolve;
    });
    await page.route(/\/Videos\/.*(?:stream|m3u8)/i, async (route) => {
        markVideoRequestSeen();
        await videoResponseGate;
        await route.continue();
    }, { times: 1 });
    await page.reload();

    const preparingStatus = page.getByRole('status');
    await expect(preparingStatus).toContainText('Preparing video');
    await expect(page.locator('#videoOsdPage')).toHaveAttribute('aria-busy', '');
    await videoRequestSeen;
    await expect(preparingStatus).toBeVisible();
    await expect(page.locator('.docspinner.mdlSpinnerActive')).toHaveCount(0);
    releaseVideoResponse();

    const videoContainer = page.locator('.videoPlayerContainer');
    await expect(videoContainer).toBeVisible({ timeout: 20_000 });
    await expect(videoContainer).not.toHaveClass(/videoPlayerContainer-onTop/);

    // The reload-redirects-home bug (bindToPlayer(null) double-call crash)
    // would send us back to #/home within a couple of seconds. Give it a
    // moment to happen, then assert we're still on the video route.
    await page.waitForTimeout(3_000);
    expect(page.url()).toContain(`#/video?id=${config.itemId}`);

    await expectPlaybackToAdvance(video, 20_000).finally(async () => {
        await test.info().attach('browser-diagnostics', {
            body: browserDiagnostics.join('\n') || 'No browser warnings, errors, or failed requests.',
            contentType: 'text/plain'
        });
    });
    await expect(preparingStatus).toBeHidden();

    // Exercise the browser-policy fallback as a second real navigation. When
    // autoplay is rejected, preparation ends once the media is seeked and
    // playable; the OSD must expose Play instead of retaining the message.
    // @covers video.permalink.autoplay_blocked.recovers_to_paused_ready
    await page.addInitScript(() => {
        const nativePlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            if (sessionStorage.getItem('e2e-block-autoplay') === '1') {
                this.autoplay = false;
                this.preload = 'auto';
                this.load();
                return Promise.reject(new DOMException('Autoplay blocked by test browser policy', 'NotAllowedError'));
            }

            return nativePlay.call(this);
        };
    });
    await page.evaluate(() => sessionStorage.setItem('e2e-block-autoplay', '1'));
    await page.reload();
    await expect(preparingStatus).toBeVisible();
    await expect(preparingStatus).toBeHidden({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
        .toBeGreaterThanOrEqual(2);
    await expect.poll(async () => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
    await page.mouse.move(20, 20);
    await page.mouse.move(100, 100);
    await expect(playPauseButton).toBeVisible();

    await page.evaluate(() => sessionStorage.removeItem('e2e-block-autoplay'));
    await playPauseButton.click();
    await expectPlaybackToAdvance(video, 20_000);
});
