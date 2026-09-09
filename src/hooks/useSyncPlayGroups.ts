// SlopTank modification notice: added or changed by SlopTank on 2026-09-02, 2026-09-09.
import { useQuery } from '@tanstack/react-query';
import type { Api } from '@jellyfin/sdk/lib/api';
import { getSyncPlayApi } from '@jellyfin/sdk/lib/utils/api/sync-play-api';
import type { AxiosRequestConfig } from 'axios';

import { isPermalinkResolutionPath } from 'components/router/permalinkId';

import { useApi } from './useApi';

const fetchSyncPlayGroups = async (
    api: Api,
    options?: AxiosRequestConfig
) => {
    const response = await getSyncPlayApi(api)
        .syncPlayGetGroups(options);
    return response.data;
};

export const useSyncPlayGroups = () => {
    const { api } = useApi();
    return useQuery({
        queryKey: [ 'SyncPlay', 'Groups' ],
        queryFn: ({ signal }) => fetchSyncPlayGroups(api!, { signal }),
        // Not while a permalink route is resolving; this feeds a toolbar menu
        // on a page that is about to be replaced, and on a two-core host it
        // competes with the resolution the user is actually waiting for.
        enabled: !!api && !isPermalinkResolutionPath(window.location.pathname)
    });
};
