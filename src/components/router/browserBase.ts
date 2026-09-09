// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-08-11, 2026-09-09.
/** Returns Jellyfin's configured BaseUrl from the server-injected web base. */
export function getDeploymentBasePath(): string {
    const baseAnchor = document.createElement('a');
    baseAnchor.href = document.baseURI;
    let basePath = baseAnchor.pathname;
    while (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
    const webSuffix = '/web';

    if (basePath.endsWith(webSuffix)) {
        return basePath.slice(0, -webSuffix.length) || '/';
    }

    return '/';
}

/**
 * Removes the deployment BaseUrl from a browser pathname, yielding the path as
 * the router sees it.
 *
 * The router is created with `basename: getDeploymentBasePath()`, so its
 * locations are already base-relative while `window.location.pathname` is not.
 * Comparing the two without this returns a false mismatch on any deployment
 * served under a BaseUrl.
 *
 * @param pathname An absolute browser pathname, including the deployment base.
 * @returns The same path relative to the router's basename.
 */
export function stripDeploymentBase(pathname: string): string {
    const base = getDeploymentBasePath();
    if (base === '/' || !pathname.startsWith(base)) return pathname;
    return pathname.slice(base.length) || '/';
}

/** Prefixes an application route with the deployment BaseUrl. */
export function withDeploymentBase(path: string): string {
    const base = getDeploymentBasePath();
    const deploymentPrefix = base === '/' ? '' : base;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${deploymentPrefix}${normalizedPath}`;
}
