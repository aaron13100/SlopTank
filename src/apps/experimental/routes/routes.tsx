import React from 'react';
import { Navigate, RouteObject } from 'react-router-dom';

import ConnectionRequired from 'components/ConnectionRequired';
import { toAsyncPageRoute } from 'components/router/AsyncRoute';
import { toViewManagerPageRoute } from 'components/router/LegacyRoute';
import ErrorBoundary from 'components/router/ErrorBoundary';
import FallbackRoute from 'components/router/FallbackRoute';

import { ASYNC_USER_ROUTES } from './asyncRoutes';
import { LEGACY_PUBLIC_ROUTES, LEGACY_USER_ROUTES } from './legacyRoutes';

export const EXPERIMENTAL_APP_CHILD_ROUTES: RouteObject[] = [
    { index: true, element: <Navigate replace to='/web/home' /> },

    {
        /* User routes */
        Component: ConnectionRequired,
        children: [
            ...ASYNC_USER_ROUTES.map(toAsyncPageRoute),
            // The video page is an ordinary legacy view again: its
            // toolbar is drawn by the app layout, keyed on the
            // `video-osd` view type, so it no longer needs a component
            // of its own to combine new controls with the legacy view.
            ...LEGACY_USER_ROUTES.map(toViewManagerPageRoute)
        ],
        ErrorBoundary
    },

    {
        /* Public routes */
        element: <ConnectionRequired level='public' />,
        children: [
            ...LEGACY_PUBLIC_ROUTES.map(toViewManagerPageRoute),

            /* Fallback route for invalid paths */
            {
                path: '*',
                Component: FallbackRoute
            }
        ]
    }
];
