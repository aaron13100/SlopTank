import type { RouteObject } from 'react-router-dom';

import { AppType } from 'constants/appType';
import { loadDynamicModule } from 'utils/dynamicImport';

export interface AsyncRoute {
    /** The URL path for this route. */
    path: string
    /**
     * The relative path to the page component in the routes directory.
     * Will fallback to using the `path` value if not specified.
     */
    page?: string
    /** The app that this page is part of. */
    type?: AppType
}

const importRoute = (page: string, type: AppType) => {
    switch (type) {
        case AppType.Dashboard:
            return loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../apps/dashboard/routes/${page}`), '../../apps/dashboard/routes/${page}');
        case AppType.Experimental:
            return loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../apps/experimental/routes/${page}`), '../../apps/experimental/routes/${page}');
        case AppType.Stable:
            return loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../apps/stable/routes/${page}`), '../../apps/stable/routes/${page}');
    }
};

export const toAsyncPageRoute = ({
    path,
    page,
    type = AppType.Stable
}: AsyncRoute): RouteObject => {
    return {
        path,
        lazy: async () => {
            const {
                // If there is a default export, use it as the Component for compatibility
                default: Component,
                ...route
            } = await importRoute(page ?? path, type);

            return {
                Component,
                ...route
            };
        }
    };
};
