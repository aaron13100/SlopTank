// SlopTank modification notice: added or changed by SlopTank on 2026-10-16.
import { expect, login, onScreenState, test } from './fixtures';

test.use({ locale: 'en-GB', trace: 'off', screenshot: 'off', video: 'off' });

test('a refused delete shows the server cause in the en-GB browser', async ({ page, config }) => {
    let deleteRequests = 0;

    await page.route('**/*', async route => {
        if (route.request().method() !== 'DELETE') {
            await route.continue();
            return;
        }

        deleteRequests += 1;
        expect(route.request().url()).toMatch(/\/Items\/[^/?]+(?:\?|$)/i);
        await route.fulfill({
            status: 409,
            contentType: 'application/problem+json',
            body: JSON.stringify({
                title: 'content-unreachable',
                status: 409,
                detail: "Current content for '/media/x.mp4' is unreachable."
            })
        });
    });

    await login(page, config.username, config.password);
    expect(await page.evaluate(() => navigator.language)).toBe('en-GB');
    await page.goto(`/web/details?id=${encodeURIComponent(config.itemId)}&serverId=${encodeURIComponent(config.serverId)}`);

    const moreCommands = page.locator('.btnMoreCommands:visible').first();
    await expect(moreCommands).toBeVisible();
    expect(await onScreenState(page, '.btnMoreCommands')).toMatchObject({ found: true, insideViewport: true, reachable: true });
    await moreCommands.click();

    const deleteCommand = page.locator('.actionSheetMenuItem[data-id="delete"]:visible').first();
    await expect(deleteCommand).toBeVisible();
    expect(await onScreenState(page, '.actionSheetMenuItem[data-id="delete"]')).toMatchObject({ found: true, insideViewport: true, reachable: true });
    await deleteCommand.click();

    const confirm = page.locator('.formDialog.opened [data-id="ok"]');
    await expect(confirm).toBeVisible();
    expect(await onScreenState(page, '.formDialog.opened [data-id="ok"]')).toMatchObject({ found: true, insideViewport: true, reachable: true });
    await confirm.click();

    const alertText = page.locator('.formDialog.opened .formDialogContent .text').last();
    await expect(alertText).toContainText('The server reported an error while deleting the item');
    await expect(alertText).toContainText('content-unreachable');
    await expect(alertText).not.toContainText(/write.?access/i);
    expect(await onScreenState(page, '.formDialog.opened .formDialogContent .text')).toMatchObject({ found: true, insideViewport: true, reachable: true });
    expect(deleteRequests).toBe(1);
});
