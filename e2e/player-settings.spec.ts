import {
    VIDEO_ROUTE,
    WATCH_PERMALINK_ROUTE,
    clickOsdControl,
    expect,
    login,
    requireControlsItemId,
    test
} from './fixtures';

test.setTimeout(180_000);

/**
 * Real-browser coverage for player settings and track selection. Assertions
 * observe the playing video, real item metadata, stream reloads, and rendered
 * statistics instead of treating a menu click as proof of behavior.
 */

interface MediaStreamInfo { Index: number; Type: string }
interface ItemDetails { MediaStreams?: MediaStreamInfo[] }
interface WindowWithApiClient extends Window {
    ApiClient: {
        getCurrentUserId(): string;
        getItem(userId: string, itemId: string): Promise<ItemDetails>;
    };
}

async function startPlayback(page: import('@playwright/test').Page, config: { itemId: string, serverId: string }) {
    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.waitForURL(url => url.pathname !== '/web/details', { timeout: 90_000 });
    const canonicalInfoPath = new URL(page.url()).pathname;
    expect(canonicalInfoPath).toMatch(/^\/[^/]+$/);
    expect(canonicalInfoPath).not.toMatch(VIDEO_ROUTE);

    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 90_000 });
    await page.waitForURL(VIDEO_ROUTE, { timeout: 1_000 });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 30_000 })
        .toBe(true);
    return video;
}

/** The OSD's audio-track button, pressed through the shared wake-and-click loop. */
const AUDIO_BUTTON = '.videoOsdBottom-maincontrols .btnAudio';

async function openSettingsMenu(page: import('@playwright/test').Page) {
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
}

async function expectPlaybackResumed(video: import('@playwright/test').Locator, timeout: number) {
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout })
        .toBe(true);
}

async function fetchItem(page: import('@playwright/test').Page, itemId: string): Promise<ItemDetails> {
    return page.evaluate(async (id) => {
        const api = (window as unknown as WindowWithApiClient).ApiClient;
        return api.getItem(api.getCurrentUserId(), id);
    }, itemId);
}

test('play from a canonical item URL reaches the canonical video route', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);

    await page.waitForURL(url => url.pathname !== '/web/details', { timeout: 90_000 });
    const canonicalInfoPath = new URL(page.url()).pathname;
    expect(canonicalInfoPath).toMatch(/^\/[^/]+$/);
    expect(canonicalInfoPath).not.toMatch(VIDEO_ROUTE);

    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 90_000 });
    await page.waitForURL(VIDEO_ROUTE, { timeout: 1_000 });

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 30_000 })
        .toBe(true);
});

test('playback speed menu changes the real video rate and reflects the selection', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await expect(video).toHaveJSProperty('playbackRate', 1);

    await openSettingsMenu(page);
    await page.locator('.actionSheetMenuItem[data-id="playbackrate"]').click();
    await page.locator('.actionSheetMenuItem[data-id="1.5"]').click();

    await expect(video).toHaveJSProperty('playbackRate', 1.5);

    await openSettingsMenu(page);
    await expect(page.locator('.actionSheetMenuItem[data-id="playbackrate"] .actionSheetItemAsideText')).toHaveText('1.5x');
    await page.locator('.actionSheetMenuItem[data-id="playbackrate"]').click();
    await page.locator('.actionSheetMenuItem[data-id="1"]').click();
    await expect(video).toHaveJSProperty('playbackRate', 1);
});

test('playback stats overlay shows real session info and closes', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await startPlayback(page, config);

    await openSettingsMenu(page);
    await page.locator('.actionSheetMenuItem[data-id="stats"]').click();

    const stats = page.locator('.playerStats');
    await expect(stats).toBeVisible();

    const playMethodRow = stats.locator('.playerStats-stat', {
        has: page.locator('.playerStats-stat-label', { hasText: 'Play method' })
    });
    await expect(playMethodRow.locator('.playerStats-stat-value')).toHaveText('Direct playing');

    const playerRow = stats.locator('.playerStats-stat', {
        has: page.locator('.playerStats-stat-label', { hasText: /^Player$/ })
    });
    await expect(playerRow.locator('.playerStats-stat-value')).not.toBeEmpty();

    await page.locator('.playerStats-closeButton').click();
    await expect(stats).toBeHidden();
});

test('quality menu forces a real transcode, resumes playback, and reflects the cap', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);
    const stats = page.locator('.playerStats');

    try {
        await openSettingsMenu(page);
        await page.locator('.actionSheetMenuItem[data-id="quality"]').click();
        // 420000 is the lowest bitrate tier. It keeps the forced transcode cheap.
        await page.locator('.actionSheetMenuItem[data-id="420000"]').click();

        await expectPlaybackResumed(video, 60_000);

        await openSettingsMenu(page);
        await expect(page.locator('.actionSheetMenuItem[data-id="quality"] .actionSheetItemAsideText')).toHaveText('420 kbps');
        await page.locator('.actionSheetMenuItem[data-id="stats"]').click();

        const playMethodRow = stats.locator('.playerStats-stat', {
            has: page.locator('.playerStats-stat-label', { hasText: 'Play method' })
        });
        await expect(playMethodRow.locator('.playerStats-stat-value')).toHaveText('Transcoding', { timeout: 20_000 });
    } finally {
        if (await stats.isVisible()) {
            await page.locator('.playerStats-closeButton').click();
        }
        await openSettingsMenu(page);
        await page.locator('.actionSheetMenuItem[data-id="quality"]').click();
        await page.locator('.actionSheetMenuItem[data-id="0"]').click();
        await expectPlaybackResumed(video, 60_000);

        await openSettingsMenu(page);
        await expect(page.locator('.actionSheetMenuItem[data-id="quality"] .actionSheetItemAsideText')).toHaveText(/^Auto\b/);
    }
});

test('audio track menu switches the real playing track', async ({ page, config }) => {
    const itemId = requireControlsItemId();
    await login(page, config.username, config.password);
    const video = await startPlayback(page, { ...config, itemId });

    const item = await fetchItem(page, itemId);
    const audioStreams = (item.MediaStreams || []).filter(stream => stream.Type === 'Audio');
    expect(audioStreams.length).toBeGreaterThanOrEqual(2);

    await clickOsdControl(page, AUDIO_BUTTON);
    const menuItems = page.locator('.actionSheetMenuItem');
    await expect(menuItems).toHaveCount(audioStreams.length);

    let currentIndex: number | null = null;
    for (const stream of audioStreams) {
        const icon = page.locator(`.actionSheetMenuItem[data-id="${stream.Index}"] .actionsheetMenuItemIcon`);
        if (await icon.isVisible()) {
            currentIndex = stream.Index;
            break;
        }
    }
    expect(currentIndex).not.toBeNull();

    const otherStream = audioStreams.find(stream => stream.Index !== currentIndex);
    if (!otherStream) {
        throw new Error('No alternate audio track found to switch to.'); // allow-raw-error: test fixture invariant
    }

    await page.locator(`.actionSheetMenuItem[data-id="${otherStream.Index}"]`).click();
    try {
        await expectPlaybackResumed(video, 30_000);

        await clickOsdControl(page, AUDIO_BUTTON);
        await expect(page.locator(`.actionSheetMenuItem[data-id="${otherStream.Index}"] .actionsheetMenuItemIcon`)).toBeVisible();
        await expect(page.locator(`.actionSheetMenuItem[data-id="${currentIndex}"] .actionsheetMenuItemIcon`)).toBeHidden();
    } finally {
        const originalTrack = page.locator(`.actionSheetMenuItem[data-id="${currentIndex}"]`);
        if (!await originalTrack.isVisible()) {
            await clickOsdControl(page, AUDIO_BUTTON);
        }
        await originalTrack.click();
        await expectPlaybackResumed(video, 30_000);

        await clickOsdControl(page, AUDIO_BUTTON);
        await expect(originalTrack.locator('.actionsheetMenuItemIcon')).toBeVisible();
    }
});
