// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-09-09.
import { AsyncRoute } from '../../../../components/router/AsyncRoute';
import { PERMALINK_ROUTES } from '../permalink/permalinkRoutes';

export const ASYNC_USER_ROUTES: AsyncRoute[] = [
    { path: 'mypreferencesmenu', page: 'user/settings' },
    ...PERMALINK_ROUTES,
    { path: 'quickconnect', page: 'quickConnect' },
    { path: 'search', page: 'search' },
    { path: 'userprofile', page: 'user/userprofile' }
];
