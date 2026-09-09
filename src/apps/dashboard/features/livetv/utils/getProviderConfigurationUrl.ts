// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
const getProviderConfigurationUrl = (providerId: string) => {
    switch (providerId?.toLowerCase()) {
        case 'xmltv':
            return '/web/dashboard/livetv/guide?type=xmltv';
        case 'schedulesdirect':
            return '/web/dashboard/livetv/guide?type=schedulesdirect';
    }
};

export default getProviderConfigurationUrl;
