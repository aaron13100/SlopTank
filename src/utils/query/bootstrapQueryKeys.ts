// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
const normalizeServerAddress = (serverAddress?: string) =>
    serverAddress?.replace(/\/+$/, '') || '';

export const getBrandingOptionsQueryKey = (serverAddress?: string) => [
    'BrandingOptions',
    normalizeServerAddress(serverAddress)
] as const;

export const getSystemInfoQueryKey = (
    serverAddress?: string,
    userId?: string | null
) => [
    'SystemInfo',
    normalizeServerAddress(serverAddress),
    userId || ''
] as const;
