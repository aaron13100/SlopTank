// SlopTank modification notice: added or changed by SlopTank on 2026-09-15.
//
// Sign-in must not wait on the server's display preferences.
//
// The owner-set login budget (2026-09-15) is one second from submitted
// credentials to the home screen. setUserInfo's awaited
// GET /DisplayPreferences round trip was the only network await left on that
// path (measured 0.3-1.2s under box load), so sign-in reads the per-user
// cached preferences synchronously and refreshes them from the server in the
// background. These tests pin that contract: the promise resolves without
// waiting for the network, the cache is used until the refresh lands, the
// refresh result replaces the cache, and a failed refresh never fails or
// stalls sign-in.
import { beforeEach, describe, expect, it } from 'vitest';

import { UserSettings } from './userSettings';

describe('setUserInfo cache-first sign-in', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    function deferred() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    function apiClientReturning(preferencePromise) {
        const calls = [];
        return {
            calls,
            getDisplayPreferences(...args) {
                calls.push(args);
                return preferencePromise;
            },
            updateDisplayPreferences() {}
        };
    }

    it('resolves without waiting for the display preferences fetch', async () => {
        const settings = new UserSettings();
        const { promise } = deferred();
        const apiClient = apiClientReturning(promise);

        const settled = await settings.setUserInfo('user-1', apiClient);

        expect(settled).toBeUndefined();
        expect(apiClient.calls[0]).toEqual(['usersettings', 'user-1', 'emby']);
    });

    it('uses the per-user cache until the refresh completes', async () => {
        const settings = new UserSettings();
        const { promise, resolve } = deferred();

        // Seed the cache through one completed sign-in cycle.
        await settings.setUserInfo('user-1', apiClientReturning(Promise.resolve({
            CustomPrefs: { theme: 'dark' }
        })));
        await new Promise((r) => setTimeout(r, 0));

        await settings.setUserInfo('user-1', apiClientReturning(promise));
        expect(settings.get('theme', true)).toBe('dark');

        resolve({ CustomPrefs: { theme: 'light' } });
        await new Promise((r) => setTimeout(r, 0));
        expect(settings.get('theme', true)).toBe('light');
    });

    it('persists the refreshed preferences as the new cache', async () => {
        const settings = new UserSettings();
        const fresh = new UserSettings();

        await settings.setUserInfo('user-1', apiClientReturning(Promise.resolve({
            CustomPrefs: { sortBy: 'Name' }
        })));
        await new Promise((r) => setTimeout(r, 0));

        // A fresh instance (new page load) sees the cached value immediately.
        await fresh.setUserInfo('user-1', apiClientReturning(deferred().promise));
        expect(fresh.get('sortBy', true)).toBe('Name');
    });

    it('never fails or stalls sign-in when the refresh errors', async () => {
        const settings = new UserSettings();
        const failing = apiClientReturning(Promise.reject(new Error('server busy')));

        await expect(settings.setUserInfo('user-1', failing)).resolves.toBeUndefined();
        await new Promise((r) => setTimeout(r, 0));
    });

    it('clears preferences on sign-out', async () => {
        const settings = new UserSettings();
        await settings.setUserInfo('user-1', apiClientReturning(Promise.resolve({
            CustomPrefs: { theme: 'dark' }
        })));
        await new Promise((r) => setTimeout(r, 0));

        await settings.setUserInfo(null, null);

        expect(settings.displayPrefs).toBeNull();
    });
});
