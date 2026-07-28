import type { Api } from '@jellyfin/sdk';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client';
import type { ApiClient, Event } from 'jellyfin-apiclient';
import React, { type FC, type PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { ServerConnections } from 'lib/jellyfin-apiclient';
import events from 'utils/events';
import { toApi } from 'utils/jellyfin-apiclient/compat';

export interface JellyfinApiContext {
    __legacyApiClient__?: ApiClient
    api?: Api
    refreshUser?: () => Promise<void>
    user?: UserDto
}

export const ApiContext = createContext<JellyfinApiContext>({});
export const useApi = () => useContext(ApiContext);

export const ApiProvider: FC<PropsWithChildren<unknown>> = ({ children }) => {
    const [ legacyApiClient, setLegacyApiClient ] = useState<ApiClient>();
    const [ api, setApi ] = useState<Api>();
    const [ user, setUser ] = useState<UserDto>();

    const updateApiUser = useCallback((_e: Event | undefined, newUser: UserDto) => {
        setUser(newUser);

        if (newUser.ServerId) {
            setLegacyApiClient(ServerConnections.getApiClient(newUser.ServerId));
        }
    }, []);

    const refreshUser = useCallback(async () => {
        const apiClient = ServerConnections.currentApiClient();
        if (!apiClient) {
            return;
        }

        const newUser = await apiClient.getCurrentUser(false);
        updateApiUser(undefined, newUser);
    }, [ updateApiUser ]);

    const context = useMemo(() => ({
        __legacyApiClient__: legacyApiClient,
        api,
        refreshUser,
        user
    }), [ api, legacyApiClient, refreshUser, user ]);

    useEffect(() => {
        refreshUser().catch(err => {
            console.info('[ApiProvider] Could not get current user', err);
        });

        const resetApiUser = () => {
            setLegacyApiClient(undefined);
            setUser(undefined);
        };

        events.on(ServerConnections, 'localusersignedin', updateApiUser);
        events.on(ServerConnections, 'localusersignedout', resetApiUser);

        return () => {
            events.off(ServerConnections, 'localusersignedin', updateApiUser);
            events.off(ServerConnections, 'localusersignedout', resetApiUser);
        };
    }, [ refreshUser, updateApiUser ]);

    useEffect(() => {
        setApi(legacyApiClient ? toApi(legacyApiClient) : undefined);
    }, [ legacyApiClient, setApi ]);

    return (
        <ApiContext.Provider value={context}>
            {children}
        </ApiContext.Provider>
    );
};
