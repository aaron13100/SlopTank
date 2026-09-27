// SlopTank regression: Similar items should not compete with detail-page playback before the section is approached.
import { expect, submitManualLogin, test } from './fixtures';

test('Similar items load when their section approaches the viewport', async ({ page, config }) => {
    const similarRequests: string[] = [];
    const isSimilarRequest = (url: string) => {
        const path = new URL(url).pathname;
        return path.endsWith(`/Items/${config.itemId}/Similar`);
    };

    page.on('request', (request) => {
        if (isSimilarRequest(request.url())) {
            similarRequests.push(request.url());
        }
    });

    // Avoid waiting for every lazily loaded asset on the dev bundle before
    // the login form is usable; the fixture below waits for its API/DOM cues.
    await page.goto('/web/#/login', { waitUntil: 'commit' });
    await submitManualLogin(page, config.username, config.password);
    await expect(page).toHaveURL(/(#\/home|\/web\/home)/);
    await page.goto(`/details?id=${config.itemId}&serverId=${config.serverId}`);
    await expect(page.locator('.mainDetailButtons .btnPlay:visible')).toBeVisible();

    const sectionTop = await page.locator('#similarCollapsible').evaluate((section) => section.getBoundingClientRect().top);
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(sectionTop).toBeGreaterThan(viewportHeight);

    // This is the negative control: reaching the primary Play action must not
    // have requested content from the below-the-fold Similar section.
    expect(similarRequests).toHaveLength(0);

    // A hidden details page is retained for back navigation. The observer
    // must survive that hide/show cycle so the still-unloaded section can
    // fetch when it later approaches the viewport.
    await page.getByRole('link', { name: 'Movies', exact: true }).click();
    await expect(page).toHaveURL(/\/movies/);
    await page.goBack();
    await expect(page.locator('.mainDetailButtons .btnPlay:visible')).toBeVisible();

    const similarSection = page.locator('#similarCollapsible');
    const similarRequest = page.waitForRequest((request) => isSimilarRequest(request.url()));
    await similarSection.scrollIntoViewIfNeeded();
    await similarRequest;

    // Completed content is one-shot: returning to details must not issue a
    // duplicate request after the original observer disconnected itself.
    await page.getByRole('link', { name: 'Movies', exact: true }).click();
    await expect(page).toHaveURL(/\/movies/);
    await page.goBack();
    await expect(page.locator('.mainDetailButtons .btnPlay:visible')).toBeVisible();
    await page.waitForLoadState('networkidle');

    // This is the positive control: the same section request starts once the
    // user approaches its content.
    expect(similarRequests).toHaveLength(1);
});
