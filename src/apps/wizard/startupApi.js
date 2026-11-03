// SlopTank modification notice: added or changed by SlopTank on 2026-11-03.
/**
 * Adapter for the server startup wizard endpoints.
 * @module apps/wizard/startupApi
 */

/**
 * Describes a startup wizard request failure with a stable operation code.
 */
export class StartupWizardApiError extends Error {
    /**
     * @param {string} code - Stable identifier for the failed wizard operation.
     * @param {string} message - Context about the failed operation.
     * @param {string} hint - A useful next action for the user.
     * @param {unknown} cause - The underlying API or navigation failure.
     */
    constructor(code, message, hint, cause) {
        super(message);
        this.name = 'StartupWizardApiError';
        this.code = code;
        this.hint = hint;
        this.cause = cause;
    }
}

function requestFailure(code, message, hint, cause) {
    return new StartupWizardApiError(code, message, hint, cause);
}

/**
 * Loads the existing server values used to prefill the first wizard step.
 * @param {object} apiClient - The connected Jellyfin API client.
 * @returns {Promise<{systemInfo: object, configuration: object, languages: Array, startupUser: object}>}
 */
export async function loadStartupWizardData(apiClient) {
    const load = async (route, code, message) => {
        try {
            return await apiClient.getJSON(apiClient.getUrl(route));
        } catch (cause) {
            throw requestFailure(code, message, 'Reload the page and try again.', cause);
        }
    };

    let systemInfo;
    try {
        systemInfo = await apiClient.getPublicSystemInfo();
    } catch (cause) {
        throw requestFailure(
            'startup-system-info-load-failed',
            'Could not load the server information.',
            'Check the server connection and reload the page.',
            cause
        );
    }

    const [configuration, languages, startupUser] = await Promise.all([
        load('Startup/Configuration', 'startup-configuration-load-failed', 'Could not load the server preferences.'),
        load('Localization/Options', 'startup-language-options-load-failed', 'Could not load display languages.'),
        load('Startup/User', 'startup-user-load-failed', 'Could not load the administrator account details.')
    ]);

    return { systemInfo, configuration, languages, startupUser };
}

/**
 * Saves the administrator account and initial server preferences.
 * The account is saved first because the server uses one existing first-user
 * record; if the preferences request fails, retrying both updates is safe.
 * @param {object} apiClient - The connected Jellyfin API client.
 * @param {{configuration: object, user: {Name: string, Password: string}}} data - Values entered in the first wizard step.
 * @returns {Promise<void>}
 */
export async function saveStartupWizardData(apiClient, data) {
    try {
        await apiClient.ajax({
            type: 'POST',
            data: JSON.stringify(data.user),
            url: apiClient.getUrl('Startup/User'),
            contentType: 'application/json'
        });
    } catch (cause) {
        throw requestFailure(
            'startup-user-save-failed',
            'The administrator account could not be saved.',
            'Check the account details and try again.',
            cause
        );
    }

    try {
        await apiClient.ajax({
            type: 'POST',
            data: JSON.stringify(data.configuration),
            url: apiClient.getUrl('Startup/Configuration'),
            contentType: 'application/json'
        });
    } catch (cause) {
        throw requestFailure(
            'startup-configuration-save-failed',
            'The administrator account was saved, but the server preferences were not.',
            'Submit again to retry saving the server preferences.',
            cause
        );
    }
}

/**
 * Marks the startup wizard complete. The server persists this flag; the
 * normal initial library scan is started by library additions with refresh
 * enabled.
 * @param {object} apiClient - The connected Jellyfin API client.
 * @returns {Promise<void>}
 */
export async function completeStartupWizard(apiClient) {
    try {
        await apiClient.ajax({
            url: apiClient.getUrl('Startup/Complete'),
            type: 'POST'
        });
    } catch (cause) {
        throw requestFailure(
            'startup-completion-failed',
            'The startup wizard could not be completed.',
            'Try again after checking the server connection.',
            cause
        );
    }
}

/**
 * Builds a visible diagnostic from a typed wizard failure and its HTTP cause.
 * @param {unknown} error - The startup request or navigation error.
 * @param {string} context - User-facing context for the failed action.
 * @returns {Promise<string>} The context and underlying status or error detail.
 */
export async function formatStartupWizardError(error, context) {
    const failure = error instanceof StartupWizardApiError ? error : null;
    let cause = failure?.cause || error;
    const chain = new Set();
    while (cause && cause.cause && !chain.has(cause)) {
        chain.add(cause);
        cause = cause.cause;
    }

    if (cause && Number.isInteger(cause.status)) {
        let responseDetail = '';
        if (typeof cause.clone === 'function') {
            try {
                const body = await cause.clone().text();
                if (body.trim()) {
                    try {
                        const problem = JSON.parse(body);
                        responseDetail = [problem.title, problem.detail].filter(Boolean).join(': ');
                    } catch (parseCause) {
                        responseDetail = body.trim();
                    }
                }
            } catch (readCause) {
                responseDetail = `response body unavailable: ${readCause.name}: ${readCause.message}`;
            }
        }

        const statusText = cause.statusText ? ` ${cause.statusText}` : '';
        const operation = failure?.code ? `${failure.code}; ` : '';
        const detail = responseDetail ? `: ${responseDetail}` : '';
        return `${context} (${operation}HTTP ${cause.status}${statusText}${detail})`;
    }

    const code = failure?.code || cause?.code || cause?.name || 'unknown-error';
    const detail = cause?.message ? `: ${cause.message}` : '';
    const hint = failure?.hint ? ` ${failure.hint}` : '';
    return `${context} (${code}${detail}).${hint}`;
}
