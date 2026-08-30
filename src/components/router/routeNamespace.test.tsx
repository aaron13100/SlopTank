import type { RouteObject } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DASHBOARD_APP_ROUTES } from 'apps/dashboard/routes/routes';
import * as experimentalRoutes from 'apps/experimental/routes/routes';
import * as stableRoutes from 'apps/stable/routes/routes';
import { WIZARD_APP_ROUTES } from 'apps/wizard/routes/routes';

import grammar from './permalink-grammar-v1.json';

const patterns = Object.values(grammar.patterns).map(pattern => new RegExp(pattern));

function flatten(routes: RouteObject[], parent = ''): string[] {
    return routes.flatMap(route => {
        const path = route.path ? `${parent}/${route.path}`.replace(/\/+/g, '/') : parent;
        return [ path, ...flatten(route.children ?? [], path) ];
    });
}

describe('browser route namespace', () => {
    it('keeps every ordinary route relative to the /web branch', () => {
        const ordinaryRoutes = flatten([
            ...stableRoutes.STABLE_APP_CHILD_ROUTES,
            ...experimentalRoutes.EXPERIMENTAL_APP_CHILD_ROUTES,
            ...DASHBOARD_APP_ROUTES,
            ...WIZARD_APP_ROUTES
        ]);

        expect(ordinaryRoutes.filter(path => path.includes('#'))).toEqual([]);
        expect(ordinaryRoutes.filter(path => path.startsWith('//'))).toEqual([]);
    });

    it('allows only the named classifier to claim a dynamic root segment', () => {
        const rootRoutes = [ 'web/*', 'w/:permalinkId', ':permalinkId', '*' ];
        const dynamicRoutes = rootRoutes.filter(path => path.startsWith(':'));
        const rootLiterals = rootRoutes
            .filter(path => !path.includes(':') && path !== '*')
            .map(path => path.split('/')[0]);

        expect(dynamicRoutes).toEqual([ ':permalinkId' ]);
        expect(rootLiterals.filter(segment => patterns.some(pattern => pattern.test(segment))))
            .toEqual([]);
    });

    it('keeps user app layout ownership in the composition root', () => {
        const selfWrappedRouteExports = [
            ...Object.keys(stableRoutes),
            ...Object.keys(experimentalRoutes)
        ].filter(name => name.endsWith('_APP_ROUTES'));

        expect(selfWrappedRouteExports).toEqual([]);
    });
});
