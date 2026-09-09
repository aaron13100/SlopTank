// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
import { useQuery } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';
import {
    BRANDING_OPTIONS_QUERY_KEY,
    getBrandingOptionsQuery
} from 'utils/query/brandingOptions';

export const QUERY_KEY = BRANDING_OPTIONS_QUERY_KEY;
export { getBrandingOptionsQuery };

export const useBrandingOptions = () => {
    const { api } = useApi();
    return useQuery(getBrandingOptionsQuery(api));
};
