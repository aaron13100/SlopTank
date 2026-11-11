// SlopTank modification notice: added or changed by SlopTank on 2026-11-11.
/**
 * Whether the browser will let this origin display a notification.
 *
 * Both notification routes fail unless permission is 'granted':
 * ServiceWorkerRegistration.showNotification rejects with a TypeError and the
 * Notification constructor fires an error event. Checking first keeps a denied
 * or unanswered permission prompt from surfacing as a page error every time the
 * server reports a new library item or a restart.
 *
 * @param {{ permission?: string } | undefined} notificationApi window.Notification, or undefined where the API is absent.
 * @returns {boolean} true only when the API exists and permission is granted.
 */
export function canShowNotifications(notificationApi) {
    return Boolean(notificationApi) && notificationApi.permission === 'granted';
}
