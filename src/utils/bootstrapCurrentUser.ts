// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
import type { ApiClient } from 'jellyfin-apiclient';

type InFlightUserRequest = {
    identity: string
    promise: ReturnType<ApiClient['getCurrentUser']>
};

const inFlightRequests = new WeakMap<ApiClient, InFlightUserRequest>();

const getIdentity = (apiClient: ApiClient) => [
    apiClient.serverId(),
    apiClient.getCurrentUserId(),
    apiClient.accessToken()
].join('\u0000');

/**
 * Coalesces only concurrent current-user bootstrap requests. The ApiClient
 * remains responsible for its resolved user cache and explicit refreshes.
 */
export const getBootstrapCurrentUser = (
    apiClient: ApiClient
) => {
    const identity = getIdentity(apiClient);
    const currentRequest = inFlightRequests.get(apiClient);
    if (currentRequest?.identity === identity) {
        return currentRequest.promise;
    }

    // The legacy client's default cache path starts a network request and can
    // then return an already-resolved persisted user instead of that request.
    // Owning the network promise is what keeps the in-flight entry alive until
    // the request actually settles; transport failures still use the client's
    // own persisted-user fallback.
    const promise = apiClient.getCurrentUser(false);
    inFlightRequests.set(apiClient, { identity, promise });

    const clearRequest = () => {
        const latestRequest = inFlightRequests.get(apiClient);
        if (latestRequest?.promise === promise) {
            inFlightRequests.delete(apiClient);
        }
    };
    promise.then(clearRequest, clearRequest);

    return promise;
};

export const invalidateBootstrapCurrentUser = (apiClient?: ApiClient | null) => {
    if (apiClient) {
        inFlightRequests.delete(apiClient);
    }
};
