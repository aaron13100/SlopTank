const getProviderConfigurationUrl = (providerId: string) => {
    switch (providerId?.toLowerCase()) {
        case 'xmltv':
            return '/web/dashboard/livetv/guide?type=xmltv';
        case 'schedulesdirect':
            return '/web/dashboard/livetv/guide?type=schedulesdirect';
    }
};

export default getProviderConfigurationUrl;
