// SlopTank modification notice: added or changed by SlopTank on 2026-10-01.
import path from 'node:path';

import type { Page } from '@playwright/test';

import {
    clickOsdControl,
    expect,
    login,
    onScreenState,
    requireAssSubtitleItemId,
    test,
    VIDEO_ROUTE
} from './fixtures';

test.setTimeout(240_000);

/**
 * Queue task c307: the Subtitles (CC) menu shows settings rows (icon, value,
 * chevron) and track rows (language badge, title, secondary text) as two
 * visibly distinct groups split by a divider. Placement is asserted with
 * onScreenState() (inside the viewport AND the element hit at its center),
 * because toBeVisible() also passes for rows laid out below the fold.
 */

const SCREENSHOT_DIR = process.env.C307_SCREENSHOT_DIR // allow-direct-env: e2e harness output location, test-only
    ?? path.resolve(__dirname, '../../deliverables/t_260927_190530_326');

const VIEWPORTS = [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'mobile', width: 390, height: 800 }
];

async function startPlayback(page: Page, config: { serverId: string }, itemId: string) {
    await page.goto(`/web/#/details?id=${itemId}&serverId=${config.serverId}`);
    await page.locator('.mainDetailButtons .btnPlay:visible').click();
    await page.waitForURL(VIDEO_ROUTE, { timeout: 60_000 });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 30_000 })
        .toBe(true);
}

async function expectGroupsOnScreen(page: Page) {
    const settingsRow = '.actionSheetMenuItem[data-id="subtitlesize"]';
    await expect(page.locator(settingsRow)).toBeVisible();

    // Settings group: icon, value as aside text, chevron.
    expect(await onScreenState(page, settingsRow)).toMatchObject({ found: true, insideViewport: true, reachable: true });
    await expect(page.locator(`${settingsRow} .actionsheetMenuItemIcon`)).toHaveCount(1);
    await expect(page.locator(`${settingsRow} .actionSheetItemAsideText`)).toHaveText(/^\d+%$/);
    await expect(page.locator(`${settingsRow} .actionSheetChevron`)).toHaveCount(1);

    // Track group: Off first, every track carries a badge pill.
    const offRow = '.actionSheetMenuItem[data-id="-1"]';
    expect(await onScreenState(page, offRow)).toMatchObject({ found: true, insideViewport: true, reachable: true });
    await expect(page.locator(`${offRow} .actionSheetBadge`)).toHaveCount(1);
    await expect(page.locator(`${offRow} .actionSheetChevron`)).toHaveCount(0);

    const trackCount = await page.locator('.actionSheetMenuItem:has(.actionSheetBadge)').count();
    expect(trackCount, 'Off plus at least one real track').toBeGreaterThan(1);

    // The first real track's badge is a pill a user can see and press.
    const firstTrackBadge = '.actionSheetMenuItem:has(.actionSheetBadge):not([data-id="-1"]) .actionSheetBadge';
    expect(await onScreenState(page, firstTrackBadge)).toMatchObject({ found: true, insideViewport: true, reachable: true });

    // Divider sits between the last settings row and Off.
    const divider = await page.locator('.actionsheetDivider').first().boundingBox();
    const lastSetting = await page.locator('.actionSheetMenuItem:has(.actionSheetChevron)').last().boundingBox();
    const off = await page.locator(offRow).boundingBox();
    expect(divider && lastSetting && off).toBeTruthy();
    expect(divider!.y).toBeGreaterThanOrEqual(lastSetting!.y + lastSetting!.height - 1);
    expect(off!.y).toBeGreaterThanOrEqual(divider!.y);

    // No row mixes the groups.
    await expect(page.locator('.actionSheetMenuItem:has(.actionSheetChevron):has(.actionSheetBadge)')).toHaveCount(0);

    // Off is checked until a track is chosen.
    await expect(page.locator('.actionSheetMenuItem-selected')).toHaveCount(1);
    await expect(page.locator('.actionSheetMenuItem-selected .actionSheetTrailingCheck')).toHaveCount(1);
}

for (const viewport of VIEWPORTS) {
    test(`Subtitles menu shows settings and track groups with language badges (${viewport.name})`, async ({ page, config }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await login(page, config.username, config.password);
        await startPlayback(page, config, requireAssSubtitleItemId());

        await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
        await expectGroupsOnScreen(page);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `cc-menu-${viewport.name}-off.png`) });

        // Choose a real track through its badge row, then reopen: the choice is the checked row
        // and the offset row joins the settings group.
        const firstTrack = page.locator('.actionSheetMenuItem:has(.actionSheetBadge):not([data-id="-1"])').first();
        const firstTrackId = await firstTrack.getAttribute('data-id');
        await firstTrack.click();
        await expect(page.locator('.dialogBackdrop')).toHaveCount(0);
        await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
        await expect(page.locator(`.actionSheetMenuItem-selected[data-id="${firstTrackId}"]`)).toHaveCount(1);
        await expect(page.locator('.actionSheetMenuItem[data-id="subtitleoffset"] .actionSheetItemAsideText')).toHaveText(/s$/);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `cc-menu-${viewport.name}-track-selected.png`) });
        await page.mouse.click(5, 5);
    });
}

test('Subtitles menu while the player is in Document PiP', async ({ page, config }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, config.username, config.password);
    await startPlayback(page, config, requireAssSubtitleItemId());
    // A hard failure, not a skip: the harness browser is expected to have Document PiP.
    const pipSupported = await page.evaluate(
        () => typeof window.documentPictureInPicture?.requestWindow === 'function');
    expect(pipSupported, 'Document PiP available in the harness browser').toBe(true);

    const pipPagePromise = page.context().waitForEvent('page');
    await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnPip');
    const pipPage = await pipPagePromise;
    await expect(pipPage.locator('.videoPlayerContainer video')).toBeVisible();

    const pipCc = pipPage.locator('.btnSubtitles:visible');
    const hasPipCc = (await pipCc.count()) > 0;
    testInfo.annotations.push({ type: 'pip-cc-button', description: hasPipCc ? 'present' : 'absent' });
    if (hasPipCc) {
        await pipCc.first().click();
    } else {
        // The PiP window has no CC button of its own; the menu opens from the main window while
        // the player lives in PiP, which is the path a user has.
        await clickOsdControl(page, '.videoOsdBottom-maincontrols .btnSubtitles');
    }
    const menuPage = hasPipCc ? pipPage : page;
    await expect(menuPage.locator('.actionSheetMenuItem[data-id="subtitlesize"]')).toBeVisible();
    await expect(menuPage.locator('.actionSheetBadge').first()).toBeVisible();
    expect(await onScreenState(menuPage, '.actionSheetMenuItem[data-id="subtitlesize"]'))
        .toMatchObject({ found: true, insideViewport: true, reachable: true });
    await menuPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'cc-menu-document-pip.png') });
    await pipPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'cc-menu-document-pip-window.png') });
    await menuPage.mouse.click(5, 5);
    await pipPage.close();
});
