import { expect, login, submitManualLogin, test } from './fixtures';

const ELECTRIC_LAGOON_BACKGROUND = 'rgb(7, 16, 24)';

test.setTimeout(120_000);

test('public login keeps the SlopTank identity through an invalid sign-in', async ({ page, config }) => {
    await page.goto('/web/#/login');

    const brand = page.getByRole('img', { name: 'SlopTank' });
    await expect(brand).toBeVisible({ timeout: 30_000 });
    await expect(brand).toHaveAttribute('src', /sloptank-wordmark\.svg/);

    await page.getByRole('button', { name: config.username, exact: true }).click();
    const form = page.locator('.manualLoginForm:visible');
    await expect(form).toBeVisible();
    await form.locator('#txtManualName').fill(config.username);
    await form.locator('#txtManualPassword').fill('not-the-real-password');

    const spinner = page.locator('.docspinner.mdlSpinnerActive');
    if (await spinner.count() > 0) {
        await spinner.waitFor({ state: 'hidden', timeout: 15_000 });
    }

    const authenticationResponse = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && /\/Users\/AuthenticateByName$/i.test(response.url())
    ));
    await form.locator('.button-submit').click();
    const response = await authenticationResponse;
    expect({
        body: await response.text(),
        status: response.status()
    }).toEqual({
        body: 'Error processing request.',
        status: 401
    });
    await expect(page.locator('.toast')).toHaveText(
        'Invalid username or password. Please try again.',
        { timeout: 15_000 }
    );
    // /web/login, not #/login: root pretty URLs (6e4b9c4900) moved the app to
    // a browser router, and the legacy bridge replaceState's the hash away
    // before the router ever sees it.
    await expect(page).toHaveURL(/\/web\/login/);
    await expect(brand).toBeVisible({ timeout: 30_000 });
});

test('a disabled account reports authorization failure instead of a connection failure', async ({ page, config }) => {
    await page.route('**/Users/authenticatebyname*', route => route.fulfill({
        body: 'Account disabled',
        contentType: 'text/plain',
        status: 403
    }));
    await page.goto('/web/#/login');

    await submitManualLogin(page, config.username, 'not-the-real-password');

    await expect(page.locator('.toast')).toHaveText(
        'You are not authorized to access the server at this time. Please contact your server administrator for more information.',
        { timeout: 15_000 }
    );
    await expect(page.getByRole('heading', { name: 'Connection Failure' })).toHaveCount(0);
});

test('a transport failure retains its cause in the connection dialog', async ({ page, config }) => {
    await page.route('**/Users/authenticatebyname*', route => route.abort('connectionrefused'));
    await page.goto('/web/#/login');

    await submitManualLogin(page, config.username, 'not-the-real-password');

    await expect(page.getByRole('heading', { name: 'Connection Failure' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/unable to connect to the selected server.*Failed to fetch/i)).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0);
});

test('an unclassified HTTP failure retains its status in the connection dialog', async ({ page, config }) => {
    await page.route('**/Users/authenticatebyname*', route => route.fulfill({
        body: 'Service unavailable',
        contentType: 'text/plain',
        status: 503
    }));
    await page.goto('/web/#/login');

    await submitManualLogin(page, config.username, 'not-the-real-password');

    await expect(page.getByRole('heading', { name: 'Connection Failure' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/unable to connect to the selected server.*HTTP 503/i)).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0);
});

test('mobile login brand stays inside the viewport without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/web/#/login');

    const brand = page.getByRole('img', { name: 'SlopTank' });
    await expect(brand).toBeVisible({ timeout: 30_000 });

    const bounds = await brand.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('dark home and item details share the Electric Lagoon shell and focus treatment', async ({ page, config }) => {
    await login(page, config.username, config.password);

    await expect(page.locator('#indexPage.homePage')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.backgroundContainer')).toHaveCSS('background-color', ELECTRIC_LAGOON_BACKGROUND);

    const shellMark = page.locator('header img[src*="sloptank-mark.svg"]:visible, .MuiAppBar-root img[src*="sloptank-mark.svg"]:visible').first();
    await expect(shellMark).toBeVisible();

    await page.goto(`/web/#/details?id=${config.itemId}&serverId=${config.serverId}`);
    await expect(page.locator('#itemDetailPage')).toBeVisible();

    const detailAction = page.locator('.mainDetailButtons .detailButton:visible').first();
    await expect(detailAction).toBeVisible({ timeout: 30_000 });
    await detailAction.focus();
    await expect(detailAction.locator('.detailButton-content')).toHaveCSS('outline-style', 'solid');
});

test('every shipped SlopTank install icon resolves from the public manifest', async ({ page }) => {
    const manifestResponse = await page.request.get('/web/manifest.json');
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json() as {
        background_color: string,
        icons: Array<{ purpose?: string, sizes: string, src: string }>
        theme_color: string
    };

    expect(manifest.theme_color).toBe('#071018');
    expect(manifest.background_color).toBe('#071018');
    expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
        const response = await page.request.get(`/web/${icon.src}`);
        expect(response.ok(), `${icon.sizes} ${icon.purpose || 'any'}: ${icon.src}`).toBe(true);
    }

    const configResponse = await page.request.get('/web/config.json');
    expect(configResponse.ok()).toBe(true);
    const clientConfig = await configResponse.json() as {
        themes: Array<{ color: string, id: string }>
    };
    expect(clientConfig.themes.find(theme => theme.id === 'dark')?.color).toBe('#071018');
    expect(clientConfig.themes.filter(theme => theme.id !== 'dark'))
        .not.toContainEqual(expect.objectContaining({ color: '#071018' }));
});
