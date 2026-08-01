import { expect, login, test } from './fixtures';

// Regression coverage for the login() timeout diagnostic (see
// describeLoginFailure in fixtures.ts and the `workers: 1` comment in
// playwright.config.ts): a stalled login must say which side the evidence
// points to -- a healthy server (real regression) or an overloaded one (host
// contention) -- instead of surfacing an anonymous Playwright timeout that
// reads the same either way.
test.setTimeout(60_000);

/**
 * Runs login() to completion and returns the error it throws.
 *
 * @param page - Page under test.
 * @param username - Account name to submit.
 * @param password - Account password to submit.
 * @returns The rejection login() produced.
 */
async function captureLoginFailure(
    page: import('@playwright/test').Page,
    username: string,
    password: string
): Promise<Error> {
    try {
        await login(page, username, password);
    } catch (error) {
        return error as Error;
    }
    throw new Error('login() unexpectedly resolved under a route that never allows it to reach #/home'); // allow-raw-error: test setup fast-fail, matching fixtures.ts convention
}

test('login() reports a real regression when the server answers a health check quickly', async ({ page, config }) => {
    await page.route('**/Users/authenticatebyname*', route => route.abort());

    const failure = await captureLoginFailure(page, config.username, config.password);
    expect(failure.message).toContain('server looks healthy');
    expect(failure.message).toContain('real login/navigation regression, not host contention');
});

test('login() reports host contention when the server cannot answer a health check', async ({ page, config }) => {
    await page.route('**/Users/authenticatebyname*', route => route.abort());
    await page.route('**/System/Info/Public*', async route => {
        await new Promise(resolve => setTimeout(resolve, 6_000));
        await route.fulfill({ body: '{}', contentType: 'application/json' });
    });

    const failure = await captureLoginFailure(page, config.username, config.password);
    expect(failure.message).toContain('health check itself failed');
    expect(failure.message).toContain('host is overloaded or unreachable, not a UI regression');
});
