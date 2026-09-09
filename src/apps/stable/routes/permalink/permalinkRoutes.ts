// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-09-09.
/**
 * Shared route declarations for permalink entry points that must be present
 * in every application layout.
 */
import type { AsyncRoute } from 'components/router/AsyncRoute';

/**
 * Routes that resolve permanent item links for information and playback.
 */
export const PERMALINK_ROUTES: AsyncRoute[] = [
    { path: 'p/:permalinkId', page: 'permalink/info' },
    { path: 'w/:permalinkId', page: 'permalink/watch' }
];
