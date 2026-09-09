// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
type DynamicModuleLoader<T> = () => Promise<T>;

interface DynamicImportCause {
    request?: unknown
}

function describeCause(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}

function requestFromCause(cause: unknown): string | undefined {
    if (cause === null || typeof cause !== 'object') {
        return undefined;
    }

    const request = (cause as DynamicImportCause).request;
    return typeof request === 'string' && request.length > 0 ? request : undefined;
}

export class DynamicImportError extends Error {
    readonly cause: unknown;
    readonly moduleSpecifier: string;
    readonly request?: string;

    constructor(moduleSpecifier: string, cause: unknown) {
        const causeDescription = describeCause(cause);
        const request = requestFromCause(cause);
        const requestDescription = request && !causeDescription.includes(request) ?
            ` (${request})` :
            '';

        super(`Failed to load ${moduleSpecifier}: ${causeDescription}${requestDescription}`);
        this.name = 'DynamicImportError';
        this.cause = cause;
        this.moduleSpecifier = moduleSpecifier;
        this.request = request;

        // Required for Error subclasses after transpilation for legacy browsers.
        Object.setPrototypeOf(this, DynamicImportError.prototype);
    }
}

export function loadDynamicModule<T>(
    loader: DynamicModuleLoader<T>,
    moduleSpecifier: string
): Promise<T> {
    return Promise.resolve()
        .then(loader)
        .catch((cause: unknown) => {
            if (cause instanceof DynamicImportError) {
                throw cause;
            }

            throw new DynamicImportError(moduleSpecifier, cause);
        });
}
