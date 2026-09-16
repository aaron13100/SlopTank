// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-07-26, 2026-08-01, 2026-08-09, 2026-08-12, 2026-09-02, 2026-09-09.
import type { Locator, Page } from '@playwright/test';
import {
    clickOsdControl,
    expect,
    login,
    onScreenState,
    requireControlsItemId,
    requireDirectPlayChapterItemId,
    requireTranscodeChapterItemId,
    revealOsdControl,
    test,
    VIDEO_ROUTE,
    WATCH_PERMALINK_ROUTE,
    wakeOsd
} from './fixtures';

test.setTimeout(180_000);

/**
 * Real-browser coverage for player OSD timeline controls: chapter navigation
 * and markers, scrub preview rendering, volume and mute, and position seeking.
 * Range controls are driven by real pointer drags.
 */

interface ChapterInfo { StartPositionTicks: number; Name: string }
interface ItemDetails {
    Chapters?: ChapterInfo[];
    RunTimeTicks?: number;
}
interface WindowWithApiClient extends Window {
    ApiClient: {
        getCurrentUserId(): string;
        getItem(userId: string, itemId: string): Promise<ItemDetails>;
    };
}

async function startPlayback(
    page: Page,
    config: { itemId: string, serverId: string, playFromBeginning?: boolean }
) {
    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.waitForURL(url => url.pathname !== '/web/details', { timeout: 90_000 });
    const canonicalInfoPath = new URL(page.url()).pathname;
    expect(canonicalInfoPath).toMatch(/^\/[^/]+$/);
    expect(canonicalInfoPath).not.toMatch(VIDEO_ROUTE);

    const primaryPlayButton = page.locator('.mainDetailButtons .btnPlay:visible');
    await expect(primaryPlayButton).toBeVisible({ timeout: 30_000 });
    const replayButton = page.locator('.mainDetailButtons .btnReplay:visible');
    const playButton = config.playFromBeginning && await replayButton.isVisible() ?
        replayButton :
        primaryPlayButton;
    await playButton.click();
    await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 90_000 });
    await page.waitForURL(VIDEO_ROUTE, { timeout: 1_000 });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 30_000 })
        .toBe(true);
    return video;
}

async function openOsd(
    page: Page,
    controlSelector = '.videoOsdBottom-maincontrols',
    timeout = 10_000
) {
    await expect.poll(
        async () => {
            // Wake on every poll, not once before it: the OSD hides itself
            // after ~3s of inactivity, so a single wake races whatever the
            // control is waiting on and loses as soon as the host is busy.
            await wakeOsd(page);
            return onScreenState(page, controlSelector);
        },
        {
            message: `expected OSD control to be on screen and reachable: ${controlSelector}`,
            timeout
        }
    ).toMatchObject({
        found: true,
        insideViewport: true,
        reachable: true
    });
}

async function expectPlayMethod(page: Page, expected: 'Direct playing' | 'Transcoding') {
    // onScreenState's reachability math (what openOsd checks) reads this
    // control as off-viewport right after a forced transcode even though a
    // screenshot at the same instant shows it in its normal place (observed
    // 2026-09-16; see forceLowestQualityTranscode's comment). Use the
    // simpler, proven-robust visibility wait here instead.
    await revealOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings', 30_000);
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
    await page.locator('.actionSheetMenuItem[data-id="stats"]').click();

    const stats = page.locator('.playerStats');
    const playMethodRow = stats.locator('.playerStats-stat', {
        has: page.locator('.playerStats-stat-label', { hasText: 'Play method' })
    });
    await expect(playMethodRow.locator('.playerStats-stat-value')).toHaveText(expected, { timeout: 20_000 });
    await page.locator('.playerStats-closeButton').click();
}

/**
 * Force a real transcode via the lowest quality-menu bitrate cap, instead of
 * relying on the fixture item's own codec to require one.
 *
 * A pinned "needs transcoding" item rots: the library's own re-encode
 * backfill and rising browser codec support both trend every item toward
 * direct-play over time (observed 2026-09-16: E2E_TRANSCODE_CHAPTER_ITEM_ID
 * now reports SupportsDirectPlay=true and the test played it direct instead
 * of transcoded). Forcing the cap, the same mechanism player-settings.spec.ts
 * already uses for its own forced-transcode coverage, tests the real
 * transcoding code path regardless of what the item would do unforced.
 */
async function forceLowestQualityTranscode(page: Page, video: Locator) {
    // A quality change reloads the video element via a real changeStream
    // round trip; the element already satisfies "!paused && readyState>=2"
    // from the PREVIOUS (direct-play) stream while the new one is still
    // "Preparing", so that alone is not proof the forced-transcode stream
    // has landed (observed 2026-09-16: play-method check read stale "Direct
    // playing" while the aria snapshot still showed "Preparing video...").
    // Wait for the real signal: the video's stream URL actually changing.
    const srcBefore = await video.evaluate((el: HTMLVideoElement) => el.currentSrc);
    await openOsd(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings');
    await page.locator('.actionSheetMenuItem[data-id="quality"]').click();
    // 420000 is the lowest bitrate tier. It keeps the forced transcode cheap.
    await page.locator('.actionSheetMenuItem[data-id="420000"]').click();
    await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentSrc), { timeout: 60_000 })
        .not.toBe(srcBefore);
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 60_000 })
        .toBe(true);
    // The OSD chrome itself can take longer to settle than the video's own
    // readyState after a real transcode startup (server-side ffmpeg spin-up,
    // slower than a direct-play swap), so the caller's own openOsd call,
    // right after this returns, can race a still-settling player (observed
    // 2026-09-16: settings button reported unreachable by openOsd's own
    // bounding-rect check for 30s straight, yet the screenshot at that exact
    // moment shows a normal, fully rendered OSD with the button in its usual
    // place -- onScreenState's viewport math, not the app, is what is wrong
    // here). Settle on the fixtures.ts shared helper instead: it checks
    // plain visibility rather than a custom bounding-rect reachability
    // computation, matching how player-settings.spec.ts's own equivalent
    // forced-transcode flow (which does not hit this failure) waits.
    await revealOsdControl(page, '.videoOsdBottom-maincontrols .btnVideoOsdSettings', 30_000);
}

async function fetchItem(page: Page, itemId: string): Promise<ItemDetails> {
    return page.evaluate(async (id) => {
        const api = (window as unknown as WindowWithApiClient).ApiClient;
        return api.getItem(api.getCurrentUserId(), id);
    }, itemId);
}

/**
 * Drag an HTML range control to a fraction of its real pointer track.
 *
 * @param page - Browser page under test.
 * @param slider - Visible range input.
 * @param targetFraction - Desired position from 0 to 1.
 */
async function dragRangeTo(page: Page, slider: Locator, targetFraction: number) {
    await expect(slider).toBeVisible();
    const sliderBox = await slider.boundingBox();
    const trackBox = await slider.locator('xpath=..').locator('.sliderBubbleTrack').boundingBox();
    if (!sliderBox || !trackBox) {
        throw new Error('Range control has no layout box to drag.'); // allow-raw-error: test fixture invariant
    }
    const range = await slider.evaluate((el: HTMLInputElement) => ({
        min: Number(el.min),
        max: Number(el.max),
        value: Number(el.value)
    }));
    const currentFraction = (range.value - range.min) / (range.max - range.min);
    const vertical = await slider.getAttribute('data-slider-orientation') === 'vertical';
    const currentPoint = vertical ? {
        x: sliderBox.x + sliderBox.width / 2,
        y: trackBox.y + trackBox.height * (1 - currentFraction)
    } : {
        x: trackBox.x + trackBox.width * currentFraction,
        y: sliderBox.y + sliderBox.height / 2
    };
    const targetPoint = vertical ? {
        x: sliderBox.x + sliderBox.width / 2,
        y: trackBox.y + trackBox.height * (1 - targetFraction)
    } : {
        x: trackBox.x + trackBox.width * targetFraction,
        y: sliderBox.y + sliderBox.height / 2
    };

    await page.mouse.move(currentPoint.x, currentPoint.y);
    await page.mouse.down();
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 10 });
    await page.mouse.up();
}

async function expectPositionPercent(page: Page, slider: Locator, target: number, tolerance: number) {
    // The OSD hides itself after ~3s of inactivity, and slider is matched
    // with a :visible filter (needed for the legacy-view strict-mode issue
    // documented on nextButton/prevButton above): a poll that never wakes
    // the OSD stops matching any element a few seconds in and freezes on
    // whatever value it last read, well before the real seek lands (observed
    // 2026-09-16, progressive-transcoding case, reported as a stuck near-zero
    // position). Wake on every poll, same pattern as revealOsdControl.
    await expect.poll(
        async () => {
            await wakeOsd(page);
            return Math.abs(Number(await slider.inputValue()) - target);
        },
        {
            message: `expected absolute player position ${target}% within ${tolerance} percentage points`,
            timeout: 60_000
        }
    ).toBeLessThanOrEqual(tolerance);
}

async function expectConsecutiveChapterNavigation(page: Page, item: ItemDetails) {
    const chapters = item.Chapters || [];
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    expect(item.RunTimeTicks).toBeGreaterThan(0);
    const runtimeTicks = item.RunTimeTicks || 0;

    const nextButtonSelector = '.videoOsdBottom-maincontrols .btnNextChapter';
    const previousButtonSelector = '.videoOsdBottom-maincontrols .btnPreviousChapter';
    await revealOsdControl(page, nextButtonSelector, 30_000);
    // Legacy views stay mounted but hidden for fast back navigation (see
    // revealOsdControl's own comment in fixtures.ts), so an unfiltered
    // locator here can resolve to two DOM matches (observed 2026-09-16,
    // progressive-transcoding case only, presumably a remount the forced
    // quality change triggers): target the visible one, same as every other
    // OSD control in this suite.
    const nextButton = page.locator(`${nextButtonSelector}:visible`);
    const prevButton = page.locator(`${previousButtonSelector}:visible`);
    const positionSlider = page.locator('.videoOsdBottom-maincontrols .osdPositionSlider:visible');
    await expect(nextButton).toBeVisible();
    await expect(prevButton).toBeVisible();
    // Same :visible-filtered-poll-outlives-the-3s-auto-hide shape as
    // expectPositionPercent below: wake on every poll, not just before it.
    await expect
        .poll(async () => {
            await wakeOsd(page);
            return page.locator('.videoOsdBottom-maincontrols:visible .sliderMarkerContainer .sliderMarker').count();
        }, { timeout: 10_000 })
        .toBe(chapters.length);

    const toPercent = (ticks: number) => ticks / runtimeTicks * 100;
    const tolerance = 100_000_000 / runtimeTicks * 100 + 0.5;

    await revealOsdControl(page, nextButtonSelector, 30_000);
    await clickOsdControl(page, nextButtonSelector);
    await expectPositionPercent(page, positionSlider, toPercent(chapters[1].StartPositionTicks), tolerance);

    await revealOsdControl(page, nextButtonSelector, 30_000);
    await clickOsdControl(page, nextButtonSelector);
    await expectPositionPercent(page, positionSlider, toPercent(chapters[2].StartPositionTicks), tolerance);

    const adjustedTicks = chapters[2].StartPositionTicks - 100_000_000;
    const expectedChapter = [ ...chapters ].reverse()
        .find(chapter => chapter.StartPositionTicks <= adjustedTicks) || chapters[0];

    await revealOsdControl(page, previousButtonSelector, 30_000);
    await clickOsdControl(page, previousButtonSelector);
    await expectPositionPercent(page, positionSlider, toPercent(expectedChapter.StartPositionTicks), tolerance);
}

for (const playbackCase of [
    {
        name: 'direct play',
        itemId: requireDirectPlayChapterItemId,
        method: 'Direct playing' as const
    },
    {
        name: 'progressive transcoding',
        itemId: requireTranscodeChapterItemId,
        method: 'Transcoding' as const
    }
]) {
    test(`consecutive chapter buttons use absolute position during ${playbackCase.name}`, async ({ page, config }) => {
        const itemId = playbackCase.itemId();
        await login(page, config.username, config.password);
        const item = await fetchItem(page, itemId);

        const video = await startPlayback(page, { ...config, itemId, playFromBeginning: true });
        if (playbackCase.method === 'Transcoding') {
            await forceLowestQualityTranscode(page, video);
        }
        await expectPlayMethod(page, playbackCase.method);
        await expectConsecutiveChapterNavigation(page, item);
    });
}

test('seek bar trickplay preview renders a real thumbnail and updates its tile', async ({ page, config }) => {
    const itemId = requireControlsItemId();
    await login(page, config.username, config.password);
    await startPlayback(page, { ...config, itemId });

    await openOsd(page);
    const slider = page.locator('.videoOsdBottom-maincontrols .osdPositionSlider');
    const box = await slider.boundingBox();
    if (!box) {
        throw new Error('Seek slider has no layout box.'); // allow-raw-error: test fixture invariant
    }

    const bubble = slider.locator('xpath=..').locator('.sliderBubble');
    const successfulThumbnail = page.waitForResponse(
        response => response.url().includes('/Trickplay/')
            && new URL(response.url()).pathname.endsWith('.jpg')
            && response.ok()
    );
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
    await successfulThumbnail;
    await expect(bubble).toBeVisible();
    await expect(bubble).not.toBeEmpty();
    const thumbnail = bubble.locator('.chapterThumbWrapper');
    await expect(thumbnail).toBeVisible();
    await expect.poll(
        () => thumbnail.evaluate(element => {
            const style = getComputedStyle(element);
            return `${style.backgroundImage} ${style.backgroundPosition}`;
        }),
        { message: 'expected the trickplay thumbnail to render its first sprite tile' }
    ).toMatch(/^url\(".+"\) -?\d+px -?\d+px$/);
    const previewNear10Percent = await bubble.textContent();
    const firstTile = await thumbnail.evaluate(element => {
        const style = getComputedStyle(element);
        return `${style.backgroundImage} ${style.backgroundPosition}`;
    });

    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await expect.poll(() => bubble.textContent()).not.toBe(previewNear10Percent);
    await expect.poll(
        () => thumbnail.evaluate(element => {
            const style = getComputedStyle(element);
            return `${style.backgroundImage} ${style.backgroundPosition}`;
        }),
        { message: 'expected the trickplay thumbnail to advance to the hovered sprite tile' }
    ).not.toBe(firstTile);
});

test('playback title keeps readable contrast over bright video', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await startPlayback(page, config);
    await openOsd(page);

    const pageTitle = page.locator('.osdHeader .pageTitle');
    await expect(pageTitle).not.toBeEmpty();
    const titleStyle = await pageTitle.evaluate(element => {
        const style = getComputedStyle(element);
        return {
            backgroundColor: style.backgroundColor,
            textShadow: style.textShadow
        };
    });
    expect(titleStyle.backgroundColor).toMatch(/^rgba\(\d+, \d+, \d+, 0\.68\)$/);
    expect(titleStyle.textShadow).not.toBe('none');
});

test('volume slider and mute button change the real video state', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    await openOsd(page);
    const muteButton = page.locator('.videoOsdBottom-maincontrols .buttonMute');
    await muteButton.focus();
    const volumeSlider = page.locator('.videoOsdBottom-maincontrols .osdVolumeSlider');
    await expect.poll(
        () => onScreenState(page, '.videoOsdBottom-maincontrols .osdVolumeSliderContainer'),
        { message: 'expected the vertical volume popover to be fully on screen and reachable' }
    ).toMatchObject({ found: true, insideViewport: true, reachable: true });
    const volumeBox = await volumeSlider.boundingBox();
    expect(volumeBox, 'vertical volume slider should have a layout box').not.toBeNull();
    expect(volumeBox?.height).toBeGreaterThan((volumeBox?.width || 0) * 3);

    await dragRangeTo(page, volumeSlider, 0);
    await expect.poll(() => volumeSlider.inputValue()).toBe('0');
    await expect(video).toHaveJSProperty('volume', 0);

    await dragRangeTo(page, volumeSlider, 1);
    await expect.poll(() => volumeSlider.inputValue()).toBe('100');
    await expect(video).toHaveJSProperty('volume', 1);

    const muteIcon = muteButton.locator('.material-icons');

    await volumeSlider.focus();
    await volumeSlider.press('ArrowDown');
    await expect.poll(() => volumeSlider.inputValue()).toBe('99');
    await expect(video).toHaveJSProperty('volume', 0.970299);
    await volumeSlider.press('ArrowUp');
    await expect.poll(() => volumeSlider.inputValue()).toBe('100');
    await expect(video).toHaveJSProperty('volume', 1);

    await expect(video).toHaveJSProperty('muted', false);
    await muteButton.click();
    await expect(video).toHaveJSProperty('muted', true);
    await expect(muteIcon).toHaveClass(/volume_off/);

    await muteButton.click();
    await expect(video).toHaveJSProperty('muted', false);
    await expect(muteIcon).toHaveClass(/volume_up/);

    await expect(page.locator('.videoOsdBottom-maincontrols .btnEpisodes')).toBeHidden();
});

test('volume slider accepts real touch input across the track', async ({ browser, config }) => {
    const context = await browser.newContext({
        baseURL: String(test.info().project.use.baseURL),
        hasTouch: true,
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
        const removeWebpackOverlay = () => {
            document.querySelector('#webpack-dev-server-client-overlay')?.remove();
        };
        new MutationObserver(removeWebpackOverlay).observe(document, {
            childList: true,
            subtree: true
        });
        removeWebpackOverlay();
    });

    try {
        await login(page, config.username, config.password);
        const video = await startPlayback(page, config);
        await openOsd(page);

        const muteButton = page.locator('.videoOsdBottom-maincontrols .buttonMute');
        await muteButton.tap();
        await expect(video).toHaveJSProperty('muted', true);

        const volumeSlider = page.locator('.videoOsdBottom-maincontrols .osdVolumeSlider');
        const trackBox = await volumeSlider.locator('xpath=..').locator('.sliderBubbleTrack').boundingBox();
        if (!trackBox) {
            throw new Error('Touch volume track has no layout box.'); // allow-raw-error: test fixture invariant
        }

        await page.touchscreen.tap(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height - 1);
        await expect.poll(async () => Number(await volumeSlider.inputValue())).toBeLessThanOrEqual(1);
        await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.volume)).toBeLessThanOrEqual(0.0000011);

        await openOsd(page);
        await muteButton.tap();
        await expect(video).toHaveJSProperty('muted', false);
        const reopenedTrackBox = await volumeSlider.locator('xpath=..').locator('.sliderBubbleTrack').boundingBox();
        if (!reopenedTrackBox) {
            throw new Error('Reopened touch volume track has no layout box.'); // allow-raw-error: test fixture invariant
        }
        await page.touchscreen.tap(reopenedTrackBox.x + reopenedTrackBox.width / 2, reopenedTrackBox.y + 1);
        await expect.poll(async () => Number(await volumeSlider.inputValue())).toBeGreaterThanOrEqual(99);
        await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.volume)).toBeGreaterThanOrEqual(0.970299);
    } finally {
        await context.close();
    }
});

test('seek position slider drags to a real playback position', async ({ page, config }) => {
    await login(page, config.username, config.password);
    const video = await startPlayback(page, config);

    const duration = await video.evaluate((el: HTMLVideoElement) => el.duration);
    expect(duration).toBeGreaterThan(0);

    await openOsd(page);
    const positionSlider = page.locator('.videoOsdBottom-maincontrols .osdPositionSlider');
    const startTimeText = page.locator('.videoOsdBottom-maincontrols .startTimeText');
    const textBefore = await startTimeText.textContent();

    await dragRangeTo(page, positionSlider, 0.5);

    await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 20_000 })
        .toBeGreaterThan(duration * 0.4);
    const currentTime = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    expect(currentTime).toBeLessThan(duration * 0.6);
    await expect.poll(() => startTimeText.textContent()).not.toBe(textBefore);
});
