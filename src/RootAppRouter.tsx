import { ThemeProvider } from '@mui/material/styles';
import React from 'react';
import {
    Navigate,
    RouterProvider,
    createBrowserRouter,
    Outlet,
    useLocation
} from 'react-router-dom';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';

import { DASHBOARD_APP_PATHS, DASHBOARD_APP_ROUTES } from 'apps/dashboard/routes/routes';
import { EXPERIMENTAL_APP_ROUTES } from 'apps/experimental/routes/routes';
import {
    LegacyRootRoute,
    PermalinkCompatibilityRoute,
    PermalinkRouteBoundary
} from 'apps/stable/routes/permalink/PermalinkRouteBoundary';
import { STABLE_APP_ROUTES } from 'apps/stable/routes/routes';
import AppLayout from 'apps/stable/AppLayout';
import { WIZARD_APP_ROUTES } from 'apps/wizard/routes/routes';
import AppHeader from 'components/AppHeader';
import Backdrop from 'components/Backdrop';
import ConnectionRequired from 'components/ConnectionRequired';
import FallbackRoute from 'components/router/FallbackRoute';
import { SETTING_KEY as LAYOUT_SETTING_KEY } from 'components/layoutManager';
import BangRedirect from 'components/router/BangRedirect';
import { appRouter } from 'components/router/appRouter';
import { getDeploymentBasePath } from 'components/router/browserBase';
import { bridgeLegacyHashRoute } from 'components/router/legacyRouteBridge';
import { createRouterHistory } from 'components/router/routerHistory';
import { CanonicalLibraryProvider } from 'components/router/canonicalLibrary';
import ViewManagerPage, { type ViewManagerPageProps } from 'components/viewManager/ViewManagerPage';
import { useApi } from 'hooks/useApi';
import { useUserViews } from 'hooks/useUserViews';
import { LayoutMode } from 'constants/layoutMode';
import browser from 'scripts/browser';
import appTheme from 'themes';
import { ThemeStorageManager } from 'themes/themeStorageManager';
import Movies from 'apps/experimental/routes/movies';
import Music from 'apps/experimental/routes/music';
import Shows from 'apps/experimental/routes/shows';
import HomeVideos from 'apps/experimental/routes/homevideos';

const layoutMode = browser.tv ? LayoutMode.Tv : localStorage.getItem(LAYOUT_SETTING_KEY);
const isExperimentalLayout = !layoutMode || layoutMode === LayoutMode.Experimental;

type CanonicalLibraryPath = 'movies' | 'music' | 'tv' | 'homevideos';

const canonicalLibraries: Record<CanonicalLibraryPath, {
    collectionType: CollectionType
    stablePage?: ViewManagerPageProps
    ExperimentalPage: React.ComponentType
}> = {
    movies: {
        collectionType: CollectionType.Movies,
        stablePage: { controller: 'movies/moviesrecommended', view: 'movies/movies.html' },
        ExperimentalPage: Movies
    },
    music: {
        collectionType: CollectionType.Music,
        stablePage: { controller: 'music/musicrecommended', view: 'music/music.html' },
        ExperimentalPage: Music
    },
    tv: {
        collectionType: CollectionType.Tvshows,
        stablePage: { controller: 'shows/tvrecommended', view: 'shows/tvrecommended.html' },
        ExperimentalPage: Shows
    },
    homevideos: {
        collectionType: CollectionType.Homevideos,
        ExperimentalPage: HomeVideos
    }
};

bridgeLegacyHashRoute();

const router = createBrowserRouter([
    {
        element: <RootAppLayout />,
        children: [
            {
                path: 'web/*',
                children: [
                    {
                        path: 'p/:permalinkId',
                        element: <PermalinkCompatibilityRoute purpose='info' />
                    },
                    {
                        path: 'w/:permalinkId',
                        element: <PermalinkCompatibilityRoute purpose='watch' />
                    },
                    ...(isExperimentalLayout ? EXPERIMENTAL_APP_ROUTES : STABLE_APP_ROUTES),
                    ...DASHBOARD_APP_ROUTES,
                    ...WIZARD_APP_ROUTES,
                    {
                        path: '!/*',
                        Component: BangRedirect
                    }
                ]
            },
            {
                // Root pretty URLs render the SAME chrome as /web/*, through
                // the same layout route. The toolbar lives in the layout, and
                // apps/stable/AppLayout has none, so wrapping these pages in
                // it unconditionally left them with no toolbar whenever the
                // experimental layout is configured -- which is the default.
                // The user was then stranded on a detail page with the
                // browser's own Back button as the only way out (2026-08-12).
                ...(isExperimentalLayout ?
                    { lazy: () => import('./apps/experimental/AppLayout') } :
                    { Component: AppLayout }),
                children: [
                    {
                        path: 'w/:permalinkId',
                        element: <PermalinkRouteBoundary purpose='watch' />
                    },
                    ...Object.keys(canonicalLibraries).map(path => ({
                        path,
                        element: <CanonicalLibraryPage path={path as CanonicalLibraryPath} />
                    })),
                    {
                        path: ':permalinkId',
                        element: <PermalinkRouteBoundary purpose='info' />
                    }
                ]
            },
            {
                path: '*',
                Component: LegacyRootRoute
            }
        ]
    }
], { basename: getDeploymentBasePath() });

export const history = createRouterHistory(router);

// The composition root hands the router-backed history to the appRouter
// singleton; appRouter must not import this module (the upward dependency
// used to force the whole route tree to load as an import side effect).
appRouter.initialize(history);

export default function RootAppRouter() {
    return <RouterProvider router={router} />;
}

/**
 * Layout component that renders legacy components required on all pages.
 * NOTE: The app will crash if these get removed from the DOM.
 */
function RootAppLayout() {
    const location = useLocation();
    const legacyLibraryPath = canonicalLibraryPath(location.pathname);
    if (legacyLibraryPath) {
        return <LegacyLibraryRedirect path={legacyLibraryPath} />;
    }

    const isNewLayoutPath = Object.values(DASHBOARD_APP_PATHS)
        .some(path => location.pathname.startsWith(`/web/${path}`));

    return (
        <ThemeProvider
            theme={appTheme}
            defaultMode='dark'
            storageManager={ThemeStorageManager}
        >
            <Backdrop />
            <AppHeader isHidden={isExperimentalLayout || isNewLayoutPath} />

            <Outlet />
        </ThemeProvider>
    );
}

function canonicalLibraryPath(pathname: string): CanonicalLibraryPath | null {
    switch (pathname) {
        case '/web/movies': return 'movies';
        case '/web/music': return 'music';
        case '/web/tv': return 'tv';
        case '/web/homevideos': return 'homevideos';
        default: return null;
    }
}

function LegacyLibraryRedirect({ path }: Readonly<{ path: CanonicalLibraryPath }>) {
    const location = useLocation();
    // eslint-disable-next-line compat/compat
    const source = new URLSearchParams(location.search);
    // eslint-disable-next-line compat/compat
    const target = new URLSearchParams();
    const tab = source.get('tab');
    if (tab !== null) target.set('tab', tab);

    return <Navigate replace to={{ pathname: `/${path}`, search: target.toString() }} />;
}

function CanonicalLibraryPage({ path }: Readonly<{ path: CanonicalLibraryPath }>) {
    // No layout wrapper here: the parent route owns the chrome, so that these
    // pages get whichever layout is configured rather than always the stable
    // one. Wrapping again would nest a second AppBody inside the first.
    return (
        <ConnectionRequired>
            <CanonicalLibraryContent path={path} />
        </ConnectionRequired>
    );
}

function CanonicalLibraryContent({ path }: Readonly<{ path: CanonicalLibraryPath }>) {
    const definition = canonicalLibraries[path];
    const location = useLocation();
    const { refreshUser, user } = useApi();
    const { data, isPending } = useUserViews(user?.Id);
    const library = data?.Items?.find(item => item.CollectionType === definition.collectionType);

    React.useEffect(() => {
        if (!user && refreshUser) {
            refreshUser().catch(error => {
                console.warn('[canonical-library] could not refresh the current user', error);
            });
        }
    }, [ refreshUser, user ]);

    if (isPending) return null;

    return (
        library?.Id ? (
            <CanonicalLibraryProvider libraryId={library.Id}>
                {isExperimentalLayout || !definition.stablePage ? (
                    <definition.ExperimentalPage />
                ) : (
                    <ViewManagerPage
                        {...definition.stablePage}
                        routeParameters={libraryRouteParameters(
                            location.search,
                            library.Id,
                            definition.collectionType
                        )}
                    />
                )}
            </CanonicalLibraryProvider>
        ) : <FallbackRoute />
    );
}

function libraryRouteParameters(
    search: string,
    libraryId: string,
    collectionType: CollectionType
) {
    // eslint-disable-next-line compat/compat
    const parameters = new URLSearchParams(search);
    parameters.set('topParentId', libraryId);
    parameters.set('collectionType', collectionType);
    return parameters;
}
