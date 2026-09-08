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
