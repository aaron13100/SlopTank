import { queryOptions, useQuery } from '@tanstack/react-query';
import type { Api } from '@jellyfin/sdk';
import { getSystemApi } from '@jellyfin/sdk/lib/utils/api/system-api';
import type { AxiosRequestConfig } from 'axios';

import { useApi } from './useApi';
import { getSystemInfoQueryKey } from 'utils/query/bootstrapQueryKeys';

const fetchSystemInfo = async (
    api: Api,
    options?: AxiosRequestConfig
) => {
    const response = await getSystemApi(api)
        .getSystemInfo(options);
    return response.data;
};

export const getSystemInfoQuery = (
    api?: Api,
    userId?: string
) => queryOptions({
    queryKey: getSystemInfoQueryKey(api?.basePath, userId),
    queryFn: ({ signal }) => fetchSystemInfo(api!, { signal, headers: { 'Cache-Control': 'no-cache' } }),
    // Allow for query reuse in legacy javascript.
    staleTime: 1000, // 1 second
    enabled: !!api
});

export const useSystemInfo = () => {
    const { api, user } = useApi();
    return useQuery(getSystemInfoQuery(api, user?.Id));
};
