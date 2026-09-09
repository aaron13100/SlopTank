// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
import { buildPermalinkPath, parsePermalinkId } from './permalinkId';
import { withDeploymentBase } from './browserBase';

/**
 * Converts hash-router links before createBrowserRouter observes the location.
 * replaceState preserves Back semantics and performs no network navigation.
 */
export function bridgeLegacyHashRoute(): boolean {
    const hash = window.location.hash;
    let route: string;

    if (hash.startsWith('#!/')) {
        route = hash.slice(2);
    } else if (hash.startsWith('#!')) {
        route = `/${hash.slice(2)}`;
    } else if (hash.startsWith('#/')) {
        route = hash.slice(1);
    } else {
        return false;
    }

    const queryIndex = route.indexOf('?');
    const routePath = queryIndex === -1 ? route : route.slice(0, queryIndex);
    const innerSearch = queryIndex === -1 ? '' : route.slice(queryIndex);
    const search = innerSearch || window.location.search;
    const permalinkMatch = /^\/[pw]\/([^/?#]+)$/.exec(routePath);

    let targetPath: string;
    if (permalinkMatch && parsePermalinkId(permalinkMatch[1])) {
        targetPath = buildPermalinkPath(routePath.startsWith('/p/') ? 'info' : 'watch', permalinkMatch[1]);
    } else {
        targetPath = routePath === '/' ? '/web/home' : `/web${routePath}`;
    }

    window.history.replaceState(window.history.state, '', `${withDeploymentBase(targetPath)}${search}`);
    return true;
}
