// SlopTank modification notice: added or changed by SlopTank on 2026-11-14.
import { getQuickConnectApi } from '@jellyfin/sdk/lib/utils/api/quick-connect-api';
import { useQuery } from '@tanstack/react-query';
import type { AxiosRequestConfig } from 'axios';

import { type JellyfinApiContext, useApi } from './useApi';

const fetchQuickConnectEnabled = async (
    apiContext: JellyfinApiContext,
    options?: AxiosRequestConfig
) => {
    const { api } = apiContext;
    if (!api) throw new Error('No API instance available');

    const response = await getQuickConnectApi(api)
        .getQuickConnectEnabled(options);
    return response.data;
};

export const useQuickConnectEnabled = () => {
    const currentApi = useApi();
    return useQuery({
        queryKey: [ 'QuickConnect', 'Enabled' ],
        queryFn: ({ signal }) => fetchQuickConnectEnabled(currentApi, { signal }),
        enabled: !!currentApi.api
    });
};
