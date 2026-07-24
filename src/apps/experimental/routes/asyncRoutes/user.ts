import { AsyncRoute } from 'components/router/AsyncRoute';
import { AppType } from 'constants/appType';
import { PERMALINK_ROUTES } from 'apps/stable/routes/permalink/permalinkRoutes';

export const ASYNC_USER_ROUTES: AsyncRoute[] = [
    { path: 'home', type: AppType.Experimental },
    { path: 'homevideos', type: AppType.Experimental },
    { path: 'livetv', type: AppType.Experimental },
    { path: 'movies', type: AppType.Experimental },
    { path: 'music', type: AppType.Experimental },
    { path: 'mypreferencesdisplay', page: 'user/display', type: AppType.Experimental },
    { path: 'mypreferencesmenu', page: 'user/settings' },
    ...PERMALINK_ROUTES,
    { path: 'quickconnect', page: 'quickConnect' },
    { path: 'search' },
    { path: 'tv', page: 'shows', type: AppType.Experimental },
    { path: 'userprofile', page: 'user/userprofile' }
];
