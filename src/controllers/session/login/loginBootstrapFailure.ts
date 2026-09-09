// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
interface FetchFailureLike {
    message?: unknown
    name?: unknown
    status?: unknown
    statusText?: unknown
}

interface PublicUserFetchFailureActions {
    hideLoading: () => void
    log: (message: string, cause: unknown) => void
    showManualForm: () => void
    showToast: (message: string) => void
    unableToConnectMessage: string
}

export function describeLoginFetchFailure(failure: unknown): string {
    if (failure === null || typeof failure !== 'object') {
        return 'No HTTP status was returned';
    }

    const response = failure as FetchFailureLike;
    if (typeof response.status === 'number' && Number.isFinite(response.status) && response.status > 0) {
        const statusText = typeof response.statusText === 'string' && response.statusText.length > 0 ?
            ` ${response.statusText}` :
            '';
        return `HTTP ${response.status}${statusText}`;
    }

    if (typeof response.name === 'string'
        && response.name.length > 0
        && typeof response.message === 'string'
        && response.message.length > 0) {
        return `${response.name}: ${response.message}`;
    }

    return 'No HTTP status was returned';
}

export function handlePublicUserFetchFailure(
    failure: unknown,
    actions: PublicUserFetchFailureActions
): void {
    actions.log('[LoginPage] failed to load public users', failure);
    actions.hideLoading();
    actions.showManualForm();
    actions.showToast(
        `${actions.unableToConnectMessage} (${describeLoginFetchFailure(failure)})`
    );
}

export function handleBrandingFetchFailure(
    failure: unknown,
    log: (message: string, cause: unknown) => void
): void {
    log('[LoginPage] failed to load branding configuration', failure);
}
