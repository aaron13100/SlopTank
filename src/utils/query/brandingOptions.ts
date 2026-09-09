// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
import type { Api } from '@jellyfin/sdk';
import { getBrandingApi } from '@jellyfin/sdk/lib/utils/api/branding-api';
import { queryOptions } from '@tanstack/react-query';
import type { AxiosRequestConfig } from 'axios';

import { getBrandingOptionsQueryKey } from './bootstrapQueryKeys';

export const BRANDING_OPTIONS_QUERY_KEY = 'BrandingOptions';

const fetchBrandingOptions = async (
    api: Api,
    options?: AxiosRequestConfig
) => {
    return getBrandingApi(api)
        .getBrandingOptions(options)
        .then(({ data }) => data);
};

export const getBrandingOptionsQuery = (
    api?: Api
) => queryOptions({
    queryKey: getBrandingOptionsQueryKey(api?.basePath),
    queryFn: ({ signal }) => fetchBrandingOptions(api!, { signal }),
    // Branding changes only through explicit administration and those writes
    // invalidate this query. Keep sequential bootstrap consumers from
    // immediately repeating the same request after the first one settles.
    staleTime: Infinity,
    enabled: !!api
});
