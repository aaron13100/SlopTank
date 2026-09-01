import { expect } from '@playwright/test';

import { test, login, revealOsdControl, WATCH_PERMALINK_ROUTE } from './fixtures';

test.setTimeout(180_000);

/**
 * The intersection nothing covered: the in-player Subtitles menu opened while
 * the address bar is already the canonical `/w/<permalink>`.
 *
 * `e2e/video-permalink.spec.ts` covers the canonicalization itself (the URL
 * arrives and the same <video> element survives it) and
 * `e2e/subtitle-track-selection.spec.ts` covers the Subtitles menu, but the
 * reported 2026-08-09 failure lived precisely where they meet: the router's
 * location and the browser's had silently diverged during canonicalization,
 * and opening the Subtitles menu was what made the router re-read
 * window.location, match the root `w/:permalinkId` route and unmount the
 * player. Either test alone stays green while that bug is present.
 *
 * The element stamp is the load-bearing assertion. "A video is visible" is
 * also true of a player that was destroyed and rebuilt, which is the
 * regression itself; a stamp read back off the same element is not.
 */

// @covers video.permalink.canonicalized_url_survives_subtitle_menu
test('canonicalizing a playing GUID route keeps the same player and timeline', async ({ page, config }) => {
    await login(page, config.username, config.password);
    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);

    // Capture the player synchronously at the history write. Waiting for the
    // pretty URL before stamping would miss the destructive gap: the root
    // route can tear down the original video and create a replacement before
    // Playwright observes the address-bar change.
    await page.evaluate(() => {
        const probeWindow = window as typeof window & {
            permalinkCanonicalizationProbe?: {
                video: HTMLVideoElement | null
                timeline: number[]
                active: boolean
            }
        };
        const nativeReplaceState = window.history.replaceState.bind(window.history);

        window.history.replaceState = (data, unused, url) => {
            if (/\/w\//.test(String(url))) {
                const video = document.querySelector('video');
                video?.setAttribute('data-e2e-player-identity', 'before-canonicalization');
                const probe = {
                    video,
                    timeline: [] as number[],
                    active: true
                };
                probeWindow.permalinkCanonicalizationProbe = probe;

                const sampleTimeline = () => {
                    if (!probe.active) return;
                    probe.timeline.push(video?.currentTime ?? -1);
                    window.requestAnimationFrame(sampleTimeline);
                };
                sampleTimeline();
            }

            nativeReplaceState(data, unused, url);
        };
    });

    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 90_000 });

    await expect
        .poll(() => page.evaluate(() => {
            const probe = (window as typeof window & {
                permalinkCanonicalizationProbe?: { video: HTMLVideoElement | null }
            }).permalinkCanonicalizationProbe;
            return !!probe?.video && probe.video === document.querySelector('video');
        }), { timeout: 20_000 })
        .toBe(true);

    await expect
        .poll(() => page.evaluate(() => (window as typeof window & {
            permalinkCanonicalizationProbe?: { timeline: number[] }
        }).permalinkCanonicalizationProbe?.timeline.length ?? 0))
        .toBeGreaterThan(1);

    const timeline = await page.evaluate(() => {
        const probe = (window as typeof window & {
            permalinkCanonicalizationProbe?: {
                video: HTMLVideoElement | null
                timeline: number[]
                active: boolean
            }
        }).permalinkCanonicalizationProbe;
        if (probe) probe.active = false;
        const samples = probe?.timeline ?? [];
        const regressionIndex = samples.findIndex((sample, index) => (
            index > 0 && sample < samples[index - 1]
        ));
        return {
            samples,
            regressionIndex
        };
    });
    expect(timeline.regressionIndex, JSON.stringify(timeline)).toBe(-1);
    await expect(page.locator('video').first()).toHaveAttribute(
        'data-e2e-player-identity',
        'before-canonicalization'
    );
});

// @covers video.permalink.canonicalized_url_survives_subtitle_menu
test('the subtitle menu keeps the player mounted once the URL has canonicalized', async ({ page, config }) => {
    let documentLoads = 0;
    page.on('load', () => {
        documentLoads++;
    });

    await login(page, config.username, config.password);

    // config.itemId deliberately, not E2E_CONTROLS_ITEM_ID. That fixture is
    // AC3, which Chrome cannot decode, so the server transcodes it and the
    // test spends its whole budget measuring transcode throughput on a 2-core
    // box instead of the routing behaviour it is about. This item direct-plays.
    await page.goto(`/web/details?id=${config.itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();

    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 60_000 })
        .toBe(true);

    // The feature must actually be present before its interaction can be tested.
    // Failing here means canonicalization regressed, not the subtitle menu.
    await page.waitForURL(WATCH_PERMALINK_ROUTE, { timeout: 90_000 });

    // Settle before stamping so this test isolates the later menu interaction;
    // the strict test above separately guards the canonicalization transition.
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 60_000 })
        .toBe(true);

    await video.evaluate((el: HTMLVideoElement) => el.setAttribute('data-e2e-player-identity', 'canonicalized'));
    const loadsBefore = documentLoads;

    await (await revealOsdControl(page, '.btnSubtitles')).click();
    await expect(page.locator('.actionSheetMenuItem').first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');

    await expect(video).toHaveAttribute('data-e2e-player-identity', 'canonicalized');
    expect(documentLoads - loadsBefore).toBe(0);
    expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);
    await expect(page).toHaveURL(WATCH_PERMALINK_ROUTE);
});
