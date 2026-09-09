// SlopTank modification notice: added or changed by SlopTank on 2026-07-31, 2026-08-03, 2026-09-09.
/**
 * Removes every trailing slash from an origin or base url so a caller can
 * append its own path with exactly one separator.
 *
 * Written as a scan rather than a `/\/+$/` replace on purpose: a trailing-slash
 * regex backtracks super-linearly on adversarial input, and this runs on a
 * value that can come from server-served configuration.
 * @param value The origin or base url to normalize.
 * @returns The same value with any trailing slashes removed.
 */
export const trimTrailingSlashes = (value: string): string => {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') {
        end -= 1;
    }

    return value.slice(0, end);
};

let routeSearchOverride: string | null = null;

/** Supplies verified parameters to legacy controllers while a canonical route owns the URL. */
export const setRouteSearchOverride = (search: string | null) => {
    routeSearchOverride = search;
};

/**
 * Gets the url search string.
 * This function should be used instead of location.search alone, because the app router
 * includes search parameters in the hash portion of the url.
 * @returns The url search string.
 */
export const getLocationSearch = () => {
    if (routeSearchOverride !== null) {
        return routeSearchOverride;
    }
    // Check location.hash for a search string (this should be the case for our routing library)
    let index = window.location.hash.indexOf('?');
    if (index !== -1) {
        return window.location.hash.substring(index);
    }

    // Return location.search if it exists
    if (window.location.search) {
        return window.location.search;
    }

    // Fallback to checking the entire url
    index = window.location.href.indexOf('?');
    if (index !== -1) {
        return window.location.href.substring(index);
    }

    return '';
};

/**
 * Gets the value of a url search parameter by name.
 * @param name The parameter name.
 * @param url The url to search (optional).
 * @returns The parameter value.
 */
export const getParameterByName = (name: string, url?: string | null | undefined) => {
    if (!url) {
        url = getLocationSearch();
    }

    // eslint-disable-next-line compat/compat
    return new URLSearchParams(url).get(name) || '';
};
