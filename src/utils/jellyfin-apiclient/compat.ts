import { Api, Jellyfin } from '@jellyfin/sdk';
import { ApiClient } from 'jellyfin-apiclient';

/**
 * Returns an SDK Api instance using the same parameters as the provided ApiClient.
 * @param {ApiClient} apiClient The (legacy) ApiClient.
 * @returns {Api} An equivalent SDK Api instance.
 */
export const toApi = (apiClient: ApiClient): Api => {
    const serverAddress = apiClient.serverAddress();
    const cookieSession = (apiClient as ApiClient & {
        isExternalCookieSession?: () => boolean
    }).isExternalCookieSession?.() === true;
    const sdk = new Jellyfin({
        clientInfo: {
            name: apiClient.appName(),
            version: apiClient.appVersion()
        },
        deviceInfo: {
            name: apiClient.deviceName(),
            id: apiClient.deviceId()
        }
    });
    const api = sdk.createApi(
        serverAddress,
        apiClient.accessToken()
    );

    if (cookieSession) {
        // The SDK generates Authorization even when its accessToken is null
        // (including a literal Token="null"). That explicit credential
        // suppresses the server's ambient-cookie transport. This adapter
        // removes it only for the browser's same-origin cookie session;
        // ordinary local-token sessions retain their existing header path.
        const cookieTransport = api.axiosInstance.create({ withCredentials: true });
        cookieTransport.interceptors.request.use(config => {
            const requestOrigin = new URL(config.url || '', config.baseURL || serverAddress).origin;
            if (requestOrigin !== new URL(serverAddress).origin || requestOrigin !== window.location.origin) {
                throw new CookieSessionTransportError(requestOrigin);
            }

            config.headers.delete('Authorization');
            return config;
        });
        return sdk.createApi(serverAddress, undefined, cookieTransport);
    }

    return api;
};

/** Refuses sending a cookie-authenticated SDK request to another origin. */
class CookieSessionTransportError extends Error {
    readonly code = 'EXTERNAL_COOKIE_ORIGIN_MISMATCH';
    readonly hint = 'Use the same server origin that completed the external login.';

    constructor(origin: string) {
        super(`External cookie session cannot call ${origin}. Use the same server origin that completed the external login.`);
        this.name = 'CookieSessionTransportError';
    }
}
