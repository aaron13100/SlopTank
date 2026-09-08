import React, { type FC, type PropsWithChildren, createContext, useContext, useEffect, useState } from 'react';

import type { WebConfig } from '../types/webConfig';
import defaultConfig from '../config.json';
import { getConfig } from '../scripts/settings/webSettings';

export const WebConfigContext = createContext<WebConfig>(defaultConfig);
export const useWebConfig = () => useContext(WebConfigContext);

export const WebConfigProvider: FC<PropsWithChildren<unknown>> = ({ children }) => {
    const [ config, setConfig ] = useState<WebConfig>(defaultConfig);

    useEffect(() => {
        getConfig()
            .then(configData => setConfig(configData))
            .catch(err => {
                console.warn('[WebConfigProvider] failed to load config', err);
            });
    }, [ setConfig ]);

    return (
        <WebConfigContext.Provider value={config}>
            {children}
        </WebConfigContext.Provider>
    );
};
