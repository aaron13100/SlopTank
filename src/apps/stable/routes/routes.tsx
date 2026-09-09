// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-08-27, 2026-08-30, 2026-09-09.
import { Navigate, RouteObject } from 'react-router-dom';
import React from 'react';

import ConnectionRequired from 'components/ConnectionRequired';
import { toAsyncPageRoute } from 'components/router/AsyncRoute';
import { toViewManagerPageRoute } from 'components/router/LegacyRoute';
import ErrorBoundary from 'components/router/ErrorBoundary';
import FallbackRoute from 'components/router/FallbackRoute';

import { ASYNC_PUBLIC_ROUTES, ASYNC_USER_ROUTES } from './asyncRoutes';
import { LEGACY_PUBLIC_ROUTES, LEGACY_USER_ROUTES } from './legacyRoutes';

export const STABLE_APP_CHILD_ROUTES: RouteObject[] = [
    { index: true, element: <Navigate replace to='/web/home' /> },

    {
        /* User routes */
        Component: ConnectionRequired,
        children: [
            ...ASYNC_USER_ROUTES.map(toAsyncPageRoute),
            ...LEGACY_USER_ROUTES.map(toViewManagerPageRoute)
        ],
        ErrorBoundary
    },

    {
        /* Public routes */
        element: <ConnectionRequired level='public' />,
        children: [
            ...ASYNC_PUBLIC_ROUTES.map(toAsyncPageRoute),
            ...LEGACY_PUBLIC_ROUTES.map(toViewManagerPageRoute),
            /* Fallback route for invalid paths */
            {
                path: '*',
                Component: FallbackRoute
            }
        ]
    }
];
