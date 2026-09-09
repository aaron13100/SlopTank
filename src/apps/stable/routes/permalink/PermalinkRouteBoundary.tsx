// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-08-12, 2026-09-09.
import React, { type FC } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';

import PermalinkRedirectPage, { type PermalinkPurpose } from 'apps/stable/routes/permalink/PermalinkRedirectPage';
import ConnectionRequired from 'components/ConnectionRequired';
import FallbackRoute from 'components/router/FallbackRoute';
import { buildPermalinkPath, parsePermalinkId } from 'components/router/permalinkId';

const LEGACY_ONE_SEGMENT_ROUTES = new Set([
    'addserver', 'dashboard', 'details', 'forgotpassword', 'forgotpasswordpin',
    'home', 'homevideos', 'list', 'livetv', 'login', 'lyrics', 'metadata',
    'movies', 'music', 'mypreferencesmenu', 'queue', 'quickconnect', 'search',
    'selectserver', 'tv', 'userprofile', 'video', 'wizardstart'
]);

/**
 * Renders a root-level pretty permalink.
 *
 * Deliberately renders NO layout of its own. The parent route in
 * RootAppRouter owns the chrome, so these pages get whichever layout is
 * configured; this component used to hard-wire apps/stable/AppLayout, which
 * renders no toolbar, stranding the user on a detail page with no in-app way
 * back whenever the experimental layout was active (2026-08-12).
 */
export const PermalinkRouteBoundary: FC<{ purpose: PermalinkPurpose }> = ({ purpose }) => {
    const { permalinkId } = useParams();
    const location = useLocation();

    if (!permalinkId || !parsePermalinkId(permalinkId)) {
        if (purpose === 'info' && permalinkId && LEGACY_ONE_SEGMENT_ROUTES.has(permalinkId)) {
            return <Navigate replace to={{ ...location, pathname: `/web/${permalinkId}` }} />;
        }

        return <FallbackRoute />;
    }

    return (
        <ConnectionRequired>
            <PermalinkRedirectPage purpose={purpose} />
        </ConnectionRequired>
    );
};

export const PermalinkCompatibilityRoute: FC<{ purpose: PermalinkPurpose }> = ({ purpose }) => {
    const { permalinkId } = useParams();
    const location = useLocation();

    if (!permalinkId || !parsePermalinkId(permalinkId)) {
        return <FallbackRoute />;
    }

    return <Navigate replace to={{ pathname: buildPermalinkPath(purpose, permalinkId), search: location.search }} />;
};

export const LegacyRootRoute: FC = () => {
    const location = useLocation();
    const pathname = location.pathname === '/' ? 'home' : location.pathname.replace(/^\//, '');
    return <Navigate replace to={{ ...location, pathname: `/web/${pathname}` }} />;
};
