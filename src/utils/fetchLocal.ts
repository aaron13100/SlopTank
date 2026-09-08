interface FetchOptions {
    cache?: RequestCache
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

    return new Promise<Response>((resolve, reject) => {
        const xhr = new XMLHttpRequest;

        xhr.onload = () => {
            // Local-file XHR reports status 0 even after a successful read.
            /* eslint-disable-next-line compat/compat */
            resolve(new Response(xhr.responseText, { status: xhr.status || 200 }));
        };

        xhr.onerror = () => {
            reject(new TypeError('Local request failed'));
        };

        xhr.open('GET', requestUrl.href);

        if (options?.cache) {
            xhr.setRequestHeader('Cache-Control', options.cache);
        }

        xhr.send(null);
    });
}
