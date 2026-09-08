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
    apiClient: ApiClient,
    refresh = false
) => {
    const identity = getIdentity(apiClient);
    const currentRequest = inFlightRequests.get(apiClient);
    if (currentRequest?.identity === identity) {
        return currentRequest.promise;
    }

    const promise = apiClient.getCurrentUser(refresh ? false : undefined);
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
