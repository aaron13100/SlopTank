import type { BrowserContext, Page } from '@playwright/test';

import { expect, login, test } from './fixtures';

test.setTimeout(180_000);

interface SyncPlayGroup {
    GroupId: string
    GroupName: string
    Participants: string[]
    State: string
}

/**
 * Open the real SyncPlay toolbar menu and wait until it can receive input.
 *
 * @param page - Signed-in browser page under test.
 * @returns The visible SyncPlay menu.
 */
async function openSyncPlayMenu(page: Page) {
    const syncPlayButton = page.getByRole('button', { name: 'SyncPlay' });
    await expect(syncPlayButton).toBeVisible({ timeout: 30_000 });
    await syncPlayButton.click();

    const menu = page.locator('#app-sync-play-menu');
    await expect(menu).toBeVisible({ timeout: 15_000 });
    return menu;
}

/**
 * Leave a SyncPlay group through the public toolbar menu.
 *
 * @param page - Browser page whose session is currently in the group.
 */
async function leaveGroupThroughMenu(page: Page): Promise<void> {
    const menu = await openSyncPlayMenu(page);
    const responsePromise = page.waitForResponse(response => (
        response.url().endsWith('/SyncPlay/Leave')
        && response.request().method() === 'POST'
    ));
    await menu.getByRole('menuitem', { name: 'Leave group' }).click();
    const response = await responsePromise;
    expect(response.status(), `leave response: ${await response.text()}`).toBe(204);
}

/**
 * Remove a session from any group after a failed assertion so the real server
 * is not left with test state. A 403 means the session already left via UI.
 *
 * @param page - Browser page whose request context targets the Jellyfin server.
 * @param authorization - Authorization header copied from the real UI request.
 */
async function ensureSessionLeft(page: Page, authorization?: string): Promise<void> {
    if (!authorization) return;

    const response = await page.request.post('/SyncPlay/Leave', {
        headers: { Authorization: authorization }
    });
    expect(
        [ 204, 403 ],
        `cleanup leave returned ${response.status()}: ${await response.text()}`
    ).toContain(response.status());
}

test('creates a SyncPlay group and lets a second browser session join it', async ({ browser, page, config }) => {
    let ownerAuthorization: string | undefined;
    let participantAuthorization: string | undefined;
    let participantContext: BrowserContext | undefined;
    let participantPage: Page | undefined;

    await login(page, config.username, config.password);

    try {
        const menu = await openSyncPlayMenu(page);
        const createResponsePromise = page.waitForResponse(response => (
            response.url().endsWith('/SyncPlay/New')
            && response.request().method() === 'POST'
        ));
        await menu.getByRole('menuitem', { name: 'Create a new group' }).click();

        const createResponse = await createResponsePromise;
        const createRequest = createResponse.request();
        ownerAuthorization = (await createRequest.allHeaders()).authorization;
        const createResponseText = await createResponse.text();
        expect(createResponse.status(), `create response: ${createResponseText}`).toBe(200);

        const requestBody = createRequest.postDataJSON() as { GroupName: string };
        const group = JSON.parse(createResponseText) as SyncPlayGroup;
        expect(requestBody).toEqual({ GroupName: `${config.username}'s group` });
        expect(group).toEqual(expect.objectContaining({
            GroupId: expect.any(String),
            GroupName: requestBody.GroupName,
            Participants: expect.arrayContaining([ config.username ]),
            State: 'Idle'
        }));

        const ownerJoinedMenu = await openSyncPlayMenu(page);
        await expect(
            ownerJoinedMenu.getByRole('menuitem', { name: 'Leave group' }),
            `create returned ${createResponse.status()} with ${createResponseText}, but the owner UI did not enter the joined session`
        ).toBeVisible({ timeout: 15_000 });
        await expect(ownerJoinedMenu.getByText(group.GroupName, { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');

        participantContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
        participantPage = await participantContext.newPage();
        const groupsResponsePromise = participantPage.waitForResponse(response => (
            response.url().endsWith('/SyncPlay/List')
            && response.request().method() === 'GET'
        ));
        await login(participantPage, config.username, config.password);

        const participantMenu = await openSyncPlayMenu(participantPage);
        const listedGroups = await (await groupsResponsePromise).json() as SyncPlayGroup[];
        const createdGroupIndex = listedGroups.findIndex(listedGroup => listedGroup.GroupId === group.GroupId);
        expect(
            createdGroupIndex,
            `created group ${group.GroupId} was absent from /SyncPlay/List: ${JSON.stringify(listedGroups)}`
        ).toBeGreaterThanOrEqual(0);
        const joinResponsePromise = participantPage.waitForResponse(response => (
            response.url().endsWith('/SyncPlay/Join')
            && response.request().method() === 'POST'
        ));
        await participantMenu.getByRole('menuitem').nth(createdGroupIndex).click();

        const joinResponse = await joinResponsePromise;
        const joinRequest = joinResponse.request();
        participantAuthorization = (await joinRequest.allHeaders()).authorization;
        expect(joinRequest.postDataJSON()).toEqual({ GroupId: group.GroupId });
        expect(joinResponse.status(), `join response: ${await joinResponse.text()}`).toBe(204);

        const participantJoinedMenu = await openSyncPlayMenu(participantPage);
        await expect(
            participantJoinedMenu.getByRole('menuitem', { name: 'Leave group' }),
            `join returned ${joinResponse.status()}, but the participant UI did not enter the joined session`
        ).toBeVisible({ timeout: 15_000 });
        await expect(participantJoinedMenu.getByText(group.GroupName, { exact: true })).toBeVisible();
        await participantPage.keyboard.press('Escape');

        await leaveGroupThroughMenu(participantPage);
        await leaveGroupThroughMenu(page);
    } finally {
        if (participantPage) {
            await ensureSessionLeft(participantPage, participantAuthorization);
        }
        await ensureSessionLeft(page, ownerAuthorization);
        await participantContext?.close();
    }
});
