interface FetchOptions {
    cache?: RequestCache
}

const PACKAGED_RESOURCE_ERROR = 'Packaged resource request failed';

function readPackagedResource(requestUrl: URL, cache?: RequestCache) {
    const request = new XMLHttpRequest();
    request.open('GET', requestUrl.href);

    if (cache) {
        request.setRequestHeader('Cache-Control', cache);
    }

    const completion = new Promise<Response>((accept, decline) => {
        request.addEventListener('load', () => {
            // A successful file:// XMLHttpRequest has status 0.
            const responseStatus = request.status === 0 ? 200 : request.status;
            /* eslint-disable-next-line compat/compat */
            accept(new Response(request.responseText, { status: responseStatus }));
        });
        request.addEventListener('error', () => {
            decline(new TypeError(PACKAGED_RESOURCE_ERROR));
        });
    });

    request.send();
    return completion;
}

/**
 * Fetch text resources while retaining support for packaged file:// clients.
 * Network resources use the platform fetch implementation. XMLHttpRequest is
 * reserved for local files because fetch does not consistently expose them.
 */
export default async function fetchLocal(url: string, options?: FetchOptions) {
    const requestUrl = new URL(url, document.baseURI);
    if (requestUrl.protocol !== 'file:') {
        return fetch(url, { cache: options?.cache });
    }
    return readPackagedResource(requestUrl, options?.cache);
}
