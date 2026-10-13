import type { ApiClient } from 'jellyfin-apiclient';
import { describe, expect, it } from 'vitest';

import { toApi } from './compat';

const client = (externalCookieSession: boolean, token: string | null) => ({
    appName: () => 'SlopTank',
    appVersion: () => '1.0',
    deviceName: () => 'Browser',
    deviceId: () => 'browser-test',
    serverAddress: () => window.location.origin,
    accessToken: () => token,
    isExternalCookieSession: () => externalCookieSession
}) as unknown as ApiClient;

describe('toApi external cookie transport', () => {
    it('sends the existing explicit credential for a local password session', async () => {
        const api = toApi(client(false, 'local-token'));
        let sentAuthorization: string | undefined;
        await api.axiosInstance.request({
            url: `${window.location.origin}/Users/Me`,
            headers: api.configuration.baseOptions?.headers,
            adapter: async config => {
                sentAuthorization = config.headers.get('Authorization')?.toString();
                return { config, data: {}, headers: {}, status: 200, statusText: 'OK' };
            }
        });
        expect(sentAuthorization).toContain('Token="local-token"');
    });

    it('sends a cookie session with credentials and no explicit Authorization header', async () => {
        const api = toApi(client(true, null));
        let sentAuthorization: string | undefined;
        let withCredentials: boolean | undefined;
        await api.axiosInstance.request({
            url: `${window.location.origin}/Users/Me`,
            headers: api.configuration.baseOptions?.headers,
            adapter: async config => {
                sentAuthorization = config.headers.get('Authorization')?.toString();
                withCredentials = config.withCredentials;
                return { config, data: {}, headers: {}, status: 200, statusText: 'OK' };
            }
        });
        expect({ sentAuthorization, withCredentials }).toEqual({
            sentAuthorization: undefined,
            withCredentials: true
        });
    });
});
