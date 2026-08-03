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

/** Prefixes an application route with the deployment BaseUrl. */
export function withDeploymentBase(path: string): string {
    const base = getDeploymentBasePath();
    const deploymentPrefix = base === '/' ? '' : base;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${deploymentPrefix}${normalizedPath}`;
}
