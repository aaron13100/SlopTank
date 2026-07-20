/** How long to wait for the Cast sender SDK to report availability. */
const CAST_SDK_TIMEOUT_MS = 15000;

/**
 * Loads the Google Cast Chrome Sender SDK.
 *
 * The hosted cast_sender.js is only a loader shim: it tries to pull the real
 * implementation out of the browser's Cast component and, when it cannot,
 * reports the failure by calling window.__onGCastApiAvailable(false, reason).
 * That callback is the SDK's only channel for reporting an unavailable API, so
 * it is registered here rather than discarded.
 */
class CastSenderApi {
    /**
     * @returns {Promise<void>} resolves once chrome.cast is available, and
     *          rejects with a diagnosable reason when it is not. It never
     *          hangs unresolved: script errors and a missing availability
     *          callback both settle it.
     */
    load() {
        if (window.appMode === 'cordova' || window.appMode === 'android') {
            window.chrome = window.chrome || {};
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                fn(arg);
            };

            const timeoutId = setTimeout(() => {
                settle(reject, new Error(
                    `Cast SDK did not become available within ${CAST_SDK_TIMEOUT_MS}ms. `
                    + 'The browser may have Cast disabled, or gstatic.com may be blocked.'
                )); // allow-raw-error: surfaced via console.warn in plugin.js, no typed-error module exists in this vendored client
            }, CAST_SDK_TIMEOUT_MS);

            // The SDK calls this once it knows whether the API is usable.
            // Chain any previously registered handler so we do not clobber one.
            const previousHandler = window.__onGCastApiAvailable;
            window.__onGCastApiAvailable = function (isAvailable, reason) {
                if (typeof previousHandler === 'function') {
                    previousHandler(isAvailable, reason);
                }

                if (isAvailable) {
                    settle(resolve);
                } else {
                    settle(reject, new Error(
                        `Cast SDK reported unavailable: ${reason || 'no reason given'}`
                    )); // allow-raw-error: surfaced via console.warn in plugin.js, no typed-error module exists in this vendored client
                }
            };

            const fileref = document.createElement('script');
            fileref.setAttribute('type', 'text/javascript');
            fileref.onerror = function () {
                settle(reject, new Error(
                    'Failed to load the Cast sender SDK from gstatic.com (blocked or offline).'
                )); // allow-raw-error: surfaced via console.warn in plugin.js, no typed-error module exists in this vendored client
            };
            fileref.setAttribute('src', 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js');
            document.querySelector('head').appendChild(fileref);
        });
    }
}

export default CastSenderApi;
