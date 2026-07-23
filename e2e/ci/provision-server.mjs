#!/usr/bin/env node
/**
 * Provisions a fresh SlopTank/Jellyfin server for the public Playwright CI suite.
 * It uses only public HTTP APIs, waits for the generated media fixture to be
 * indexed, and prints GitHub Actions environment-file assignments to stdout.
 */

class ProvisioningError extends Error {
    /**
     * @param {string} code Stable diagnostic code.
     * @param {string} message Human-readable failure detail.
     * @param {string} hint Concrete recovery guidance.
     * @param {unknown} [cause] Underlying failure, when available.
     */
    constructor(code, message, hint, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'ProvisioningError';
        this.code = code;
        this.hint = hint;
    }
}

const requiredOptions = [
    'base-url',
    'media-path',
    'username',
    'password',
    'item-name',
    'transcode-item-name',
    'max-attempts',
    'poll-interval-ms'
];

/**
 * Parses the command line into the explicit configuration contract.
 * @param {string[]} argv Arguments after the node executable and script path.
 * @returns {Record<string, string>} Validated option values.
 */
function parseOptions(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || value === undefined) {
            throw new ProvisioningError(
                'INVALID_ARGUMENTS',
                `Expected --name value pairs, received ${flag ?? '(nothing)'}`,
                'Pass every required provisioning option with an explicit value.'
            );
        }
        options[flag.slice(2)] = value;
    }

    for (const name of requiredOptions) {
        if (!options[name]) {
            throw new ProvisioningError(
                'MISSING_ARGUMENT',
                `Missing required option --${name}`,
                `Pass --${name} with a non-empty value.`
            );
        }
    }

    const parsedUrl = new URL(options['base-url']);
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
        throw new ProvisioningError(
            'INVALID_BASE_URL',
            `Unsupported server URL ${options['base-url']}`,
            'Use an http(s) URL without embedded credentials.'
        );
    }

    for (const name of requiredOptions) {
        if (/[\r\n]/.test(options[name])) {
            throw new ProvisioningError(
                'UNSAFE_ARGUMENT',
                `Option --${name} contains a line break`,
                'Use single-line values so GitHub environment output cannot be injected.'
            );
        }
    }

    return options;
}

/**
 * Calls one Jellyfin API endpoint and returns its parsed response document.
 * @param {string} baseUrl Server origin.
 * @param {string} path Absolute API path, including query string.
 * @param {{ body?: unknown, method?: string, token?: string }} [options] Request options.
 * @returns {Promise<unknown>} Parsed JSON, or null for an empty successful response.
 */
async function requestJson(baseUrl, path, options = {}) {
    const method = options.method ?? 'GET';
    const headers = {
        Authorization: 'MediaBrowser Client="SlopTank E2E", Device="GitHub Actions", DeviceId="sloptank-ci", Version="1"'
    };
    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    if (options.token) {
        headers['X-Emby-Token'] = options.token;
    }

    let response;
    try {
        response = await fetch(new URL(path, baseUrl), { // allow-direct-http: this module is the CI Jellyfin API adapter
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            headers,
            method
        });
    } catch (cause) {
        throw new ProvisioningError(
            'SERVER_UNREACHABLE',
            `${method} ${path} could not reach the server`,
            'Inspect the SlopTank server startup log for an early process failure.',
            cause
        );
    }

    const text = await response.text();
    if (!response.ok) {
        const responseDetail = text ? `: ${text}` : '';
        throw new ProvisioningError(
            'API_REJECTED',
            `${method} ${path} returned HTTP ${response.status}${responseDetail}`,
            'Inspect the endpoint response and server log; provisioning never continues after a rejected step.'
        );
    }
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (cause) {
        throw new ProvisioningError(
            'INVALID_API_RESPONSE',
            `${method} ${path} returned invalid JSON`,
            'Confirm the pinned server revision still implements the expected public API contract.',
            cause
        );
    }
}

/**
 * Waits for the HTTP listener without hiding the final startup failure.
 * @param {Record<string, string>} options Provisioning options.
 * @returns {Promise<void>}
 */
async function waitForServer(options) {
    const attempts = Number.parseInt(options['max-attempts'], 10);
    const interval = Number.parseInt(options['poll-interval-ms'], 10);
    if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(interval) || interval < 0) {
        throw new ProvisioningError(
            'INVALID_POLL_CONFIG',
            'Polling options must be non-negative integers and max-attempts must be at least one',
            'Pass bounded integer polling values.'
        );
    }

    let lastFailure;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await requestJson(options['base-url'], '/Startup/Configuration');
            return;
        } catch (cause) {
            lastFailure = cause;
            if (attempt + 1 < attempts) {
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        }
    }

    throw new ProvisioningError(
        'SERVER_START_TIMEOUT',
        `SlopTank did not become ready after ${attempts} attempts`,
        'Inspect the server log emitted by the workflow cleanup step.',
        lastFailure
    );
}

/**
 * Waits until the generated movie is visible through the authenticated Items API.
 * @param {Record<string, string>} options Provisioning options.
 * @param {string} token Admin access token.
 * @param {string} itemName Exact fixture name.
 * @returns {Promise<string>} Indexed item ID.
 */
async function waitForFixture(options, token, itemName) {
    const attempts = Number.parseInt(options['max-attempts'], 10);
    const interval = Number.parseInt(options['poll-interval-ms'], 10);
    const query = new URLSearchParams({
        IncludeItemTypes: 'Movie',
        Recursive: 'true',
        SearchTerm: itemName
    });

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const document = await requestJson(
            options['base-url'],
            `/Items?${query.toString()}`,
            { token }
        );
        const items = document && typeof document === 'object' && Array.isArray(document.Items) ?
            document.Items :
            [];
        const fixture = items.find(item => item?.Name === itemName && typeof item.Id === 'string');
        if (fixture) {
            return fixture.Id;
        }
        if (attempt + 1 < attempts) {
            await new Promise(resolve => setTimeout(resolve, interval));
        }
    }

    throw new ProvisioningError(
        'FIXTURE_SCAN_TIMEOUT',
        `Media item ${itemName} was not indexed after ${attempts} attempts`,
        `Confirm ${options['media-path']} contains the generated fixture and inspect the library scan log.`
    );
}

/**
 * Runs the ordered first-start API flow and returns Playwright environment values.
 * @param {Record<string, string>} options Provisioning options.
 * @returns {Promise<Record<string, string>>} Environment variable mapping.
 */
async function provision(options) {
    await waitForServer(options);
    const baseUrl = options['base-url'];
    await requestJson(baseUrl, '/Startup/Configuration', {
        body: {
            MetadataCountryCode: 'US',
            PreferredMetadataLanguage: 'en',
            ServerName: 'SlopTank CI',
            UICulture: 'en-US'
        },
        method: 'POST'
    });
    await requestJson(baseUrl, '/Startup/User');
    await requestJson(baseUrl, '/Startup/User', {
        body: { Name: options.username, Password: options.password },
        method: 'POST'
    });
    await requestJson(baseUrl, '/Startup/RemoteAccess', {
        body: { EnableRemoteAccess: false },
        method: 'POST'
    });

    const libraryQuery = new URLSearchParams({
        collectionType: 'movies',
        name: 'E2E Movies',
        paths: options['media-path'],
        refreshLibrary: 'true'
    });
    await requestJson(baseUrl, `/Library/VirtualFolders?${libraryQuery.toString()}`, {
        body: {},
        method: 'POST'
    });
    await requestJson(baseUrl, '/Startup/Complete', { method: 'POST' });

    const authentication = await requestJson(baseUrl, '/Users/AuthenticateByName', {
        body: { Pw: options.password, Username: options.username },
        method: 'POST'
    });
    if (!authentication || typeof authentication !== 'object'
        || typeof authentication.AccessToken !== 'string'
        || typeof authentication.ServerId !== 'string') {
        throw new ProvisioningError(
            'INVALID_AUTH_RESPONSE',
            'The authentication response omitted AccessToken or ServerId',
            'Confirm the pinned server revision still returns the documented authentication result.'
        );
    }
    if (!authentication.User || typeof authentication.User !== 'object'
        || typeof authentication.User.Id !== 'string'
        || !authentication.User.Policy || typeof authentication.User.Policy !== 'object') {
        throw new ProvisioningError(
            'INVALID_AUTH_USER',
            'The authentication response omitted the user ID or policy',
            'Confirm the pinned server revision still returns the authenticated user document.'
        );
    }

    await requestJson(
        baseUrl,
        `/Users/${encodeURIComponent(authentication.User.Id)}/Policy`,
        {
            body: { ...authentication.User.Policy, IsHidden: false },
            method: 'POST',
            token: authentication.AccessToken
        }
    );

    const itemId = await waitForFixture(options, authentication.AccessToken, options['item-name']);
    const transcodeItemId = await waitForFixture(
        options,
        authentication.AccessToken,
        options['transcode-item-name']
    );
    return {
        E2E_BASE_URL: baseUrl,
        E2E_USERNAME: options.username,
        E2E_PASSWORD: options.password,
        E2E_ITEM_ID: itemId,
        E2E_TRANSCODE_ITEM_ID: transcodeItemId,
        E2E_SERVER_ID: authentication.ServerId
    };
}

/**
 * Formats an environment-file assignment after rejecting line injection.
 * @param {string} name Variable name.
 * @param {string} value Variable value.
 * @returns {string} GitHub Actions environment-file line.
 */
function environmentLine(name, value) {
    if (/[\r\n]/.test(value)) {
        throw new ProvisioningError(
            'UNSAFE_ENVIRONMENT_VALUE',
            `${name} contains a line break`,
            'Reject the server response rather than writing an unsafe GitHub environment file.'
        );
    }
    return `${name}=${value}`;
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    const environment = await provision(options);
    for (const [name, value] of Object.entries(environment)) {
        console.log(environmentLine(name, value));
    }
}

main().catch(error => {
    const code = error instanceof ProvisioningError ? error.code : 'UNEXPECTED_FAILURE';
    const hint = error instanceof ProvisioningError ?
        error.hint :
        'Inspect the full exception and server log before retrying.';
    const cause = error?.cause instanceof Error ? ` Cause: ${error.cause.message}` : '';
    console.error(`[${code}] ${error instanceof Error ? error.message : String(error)} Hint: ${hint}${cause}`);
    process.exitCode = 1;
});
