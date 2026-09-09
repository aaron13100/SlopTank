// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-09-09.
import { describe, expect, it } from 'vitest';

import { ASYNC_USER_ROUTES as EXPERIMENTAL_ASYNC_USER_ROUTES } from 'apps/experimental/routes/asyncRoutes';
import {
    LEGACY_PUBLIC_ROUTES as EXPERIMENTAL_LEGACY_PUBLIC_ROUTES,
    LEGACY_USER_ROUTES as EXPERIMENTAL_LEGACY_USER_ROUTES
} from 'apps/experimental/routes/legacyRoutes';
import { ASYNC_PUBLIC_ROUTES, ASYNC_USER_ROUTES } from 'apps/stable/routes/asyncRoutes';
import { LEGACY_PUBLIC_ROUTES, LEGACY_USER_ROUTES } from 'apps/stable/routes/legacyRoutes';
import { PERMALINK_MARKER_SEGMENTS } from 'components/router/permalinkId';

describe('permalink route registration', () => {
    const layouts = [
        {
            name: 'stable',
            routes: [
                ...ASYNC_USER_ROUTES,
                ...ASYNC_PUBLIC_ROUTES,
                ...LEGACY_USER_ROUTES,
                ...LEGACY_PUBLIC_ROUTES
            ]
        },
        {
            name: 'experimental',
            routes: [
                ...EXPERIMENTAL_ASYNC_USER_ROUTES,
                ...EXPERIMENTAL_LEGACY_USER_ROUTES,
                ...EXPERIMENTAL_LEGACY_PUBLIC_ROUTES
            ]
        }
    ];

    it.each(layouts)('$name layout exposes each marker through exactly one permalink route', ({ routes }) => {
        for (const marker of PERMALINK_MARKER_SEGMENTS) {
            const claimants = routes.filter(route => route.path.split('/')[0] === marker);
            expect(claimants, `route claimants for ${marker}`).toHaveLength(1);
            expect(claimants[0].path).toBe(`${marker}/:permalinkId`);
        }
    });
});
