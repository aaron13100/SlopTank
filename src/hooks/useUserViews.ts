// SlopTank modification notice: added or changed by SlopTank on 2026-09-02, 2026-09-09, 2026-11-14.
import type { Api } from '@jellyfin/sdk/lib/api';
import type { UserViewsApiGetUserViewsRequest } from '@jellyfin/sdk/lib/generated-client/api/user-views-api';
import { getUserViewsApi } from '@jellyfin/sdk/lib/utils/api/user-views-api';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { isPermalinkResolutionPath } from 'components/router/permalinkId';

import { useApi } from './useApi';

const fetchUserViews = async (
    api: Api,
    userId: string,
    params?: UserViewsApiGetUserViewsRequest
) => {
    const response = await getUserViewsApi(api)
        .getUserViews({ ...params, userId });
    return response.data;
};

export const getUserViewsQuery = (
    api?: Api,
    userId?: string,
    params?: UserViewsApiGetUserViewsRequest
) => queryOptions({
    queryKey: [ 'User', userId, 'Views', params ],
    // Imperative consumers may still await this shared request after React observers unmount.
    queryFn: () => fetchUserViews(api!, userId!, params),
    // On initial page load we request user views 3x. Setting a 1 second stale time
    // allows a single request to be made to resolve all 3.
    staleTime: 1000, // 1 second
    // Not while a permalink route is resolving. This feeds navigation chrome,
    // and a permalink route replaces itself with the real route as soon as the
    // server answers, so fetching it there competes with that answer and is
    // then thrown away. It is requested again, normally, the moment the real
    // route mounts. See isPermalinkResolutionPath for the measurements.
    enabled: !!api && !!userId && !isPermalinkResolutionPath(window.location.pathname)
});

export const useUserViews = (
    userId?: string,
    params?: UserViewsApiGetUserViewsRequest
) => {
    const apiContext = useApi();
    const { api } = apiContext;
    return useQuery(getUserViewsQuery(api, userId, params));
};
