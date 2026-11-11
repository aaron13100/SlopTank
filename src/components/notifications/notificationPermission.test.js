// SlopTank modification notice: added or changed by SlopTank on 2026-11-11.
import { describe, expect, it } from 'vitest';
import { canShowNotifications } from './notificationPermission';

describe('canShowNotifications', () => {
    it('allows notifications once the origin holds granted permission', () => {
        expect(canShowNotifications({ permission: 'granted' })).toBe(true);
    });

    it.each(['default', 'denied'])('refuses while permission is %s, the state in which showNotification rejects', (permission) => {
        expect(canShowNotifications({ permission })).toBe(false);
    });

    it('refuses where the Notification API is absent', () => {
        expect(canShowNotifications(undefined)).toBe(false);
    });
});
