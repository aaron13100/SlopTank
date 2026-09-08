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
    enabled: !!api
});
