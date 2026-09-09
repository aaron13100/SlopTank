// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
import toast from 'components/toast/toast';
import { DynamicImportError } from 'utils/dynamicImport';

type DynamicImportFailureEvent = Pick<PromiseRejectionEvent, 'preventDefault' | 'reason'>;
type DynamicImportFailurePresenter = (message: string) => void;
type DynamicImportFailureLogger = (message: string, cause: unknown) => void;

let installed = false;

export function handleUnhandledDynamicImportFailure(
    event: DynamicImportFailureEvent,
    present: DynamicImportFailurePresenter = toast,
    log: DynamicImportFailureLogger = (message, cause) => console.error(message, cause)
): boolean {
    if (!(event.reason instanceof DynamicImportError)) {
        return false;
    }

    event.preventDefault();
    log(`[dynamic-import] ${event.reason.moduleSpecifier}`, event.reason.cause);
    present(event.reason.message);
    return true;
}

export function installDynamicImportFailureReporter(): void {
    if (installed) {
        return;
    }

    window.addEventListener('unhandledrejection', event => {
        handleUnhandledDynamicImportFailure(event);
    });
    installed = true;
}
