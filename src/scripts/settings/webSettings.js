// SlopTank modification notice: added or changed by SlopTank on 2026-07-31, 2026-09-08, 2026-09-09.
import DefaultConfig from '../../config.json';
import fetchLocal from '../../utils/fetchLocal.ts';
import { trimTrailingSlashes } from '../../utils/url.ts';

let data;
let configPromise;

export async function getConfig() {
    if (data) return Promise.resolve(data);
    if (!configPromise) {
        configPromise = (async () => {
            try {
                const response = await fetchLocal('config.json', {
                    cache: 'no-store'
                });

                if (!response.ok) {
                    throw new Error('network response was not ok');
                }

                data = await response.json();
            } catch (error) {
                console.warn('failed to fetch the web config file:', error);
                data = DefaultConfig;
            }

            return data;
        })();
    }

    try {
        return await configPromise;
    } finally {
        if (!data) {
            configPromise = undefined;
        }
    }
}

export function getIncludeCorsCredentials() {
    return getConfig()
        .then(config => !!config.includeCorsCredentials)
        .catch(error => {
            console.log('cannot get web config:', error);
            return false;
        });
}

export function getMultiServer() {
    // Enable multi-server support when served by webpack
    if (__WEBPACK_SERVE__) {
        return Promise.resolve(true);
    }

    return getConfig().then(config => {
        return !!config.multiserver;
    }).catch(error => {
        console.log('cannot get web config:', error);
        return false;
    });
}

export function getServers() {
    return getConfig().then(config => {
        return config.servers || [];
    }).catch(error => {
        console.log('cannot get web config:', error);
        return [];
    });
}

/**
 * The one canonical public origin shared links are built from
 * (docs/internal/permalink-url-design.md section 3.7).
 *
 * A pasteable link needs a host, and `apiClient.serverAddress()` is whatever
 * connection mode the current session happens to use -- often a LAN address
 * that means nothing to the recipient. A deployment that is reachable under a
 * stable public name sets `shareOrigin` in its served `config.json`; anything
 * else keeps the connected server address, which is the best available answer
 * and is at least correct for the person sharing.
 *
 * @param {string} fallbackOrigin The connected server address to use when no canonical origin is configured.
 * @returns {Promise<string>} The origin to build share URLs from, without a trailing slash.
 */
export function getShareOrigin(fallbackOrigin) {
    return getConfig().then(config => {
        const configured = typeof config.shareOrigin === 'string' ? config.shareOrigin.trim() : '';
        return trimTrailingSlashes(configured || fallbackOrigin || '');
    }).catch(error => {
        console.log('cannot get web config:', error);
        return trimTrailingSlashes(fallbackOrigin || '');
    });
}

const baseDefaultTheme = {
    'name': 'Dark',
    'id': 'dark',
    'default': true
};

let internalDefaultTheme = baseDefaultTheme;

const checkDefaultTheme = (themes) => {
    if (themes) {
        const defaultTheme = themes.find((theme) => theme.default);

        if (defaultTheme) {
            internalDefaultTheme = defaultTheme;
            return;
        }
    }

    internalDefaultTheme = baseDefaultTheme;
};

export function getThemes() {
    return getConfig().then(config => {
        if (!Array.isArray(config.themes)) {
            console.error('web config is invalid, missing themes:', config);
        }
        const themes = Array.isArray(config.themes) ? config.themes : DefaultConfig.themes;
        checkDefaultTheme(themes);
        return themes;
    }).catch(error => {
        console.log('cannot get web config:', error);
        checkDefaultTheme();
        return DefaultConfig.themes;
    });
}

export const getDefaultTheme = () => internalDefaultTheme;

export function getMenuLinks() {
    return getConfig().then(config => {
        if (!config.menuLinks) {
            console.error('web config is invalid, missing menuLinks:', config);
        }
        return config.menuLinks || [];
    }).catch(error => {
        console.log('cannot get web config:', error);
        return [];
    });
}

export function getPlugins() {
    return getConfig().then(config => {
        if (!config.plugins) {
            console.error('web config is invalid, missing plugins:', config);
        }
        return config.plugins || DefaultConfig.plugins;
    }).catch(error => {
        console.log('cannot get web config:', error);
        return DefaultConfig.plugins;
    });
}
