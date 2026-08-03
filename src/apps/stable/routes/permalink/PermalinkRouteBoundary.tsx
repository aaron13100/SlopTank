import React, { type FC } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';

import AppLayout from 'apps/stable/AppLayout';
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

export const PermalinkRouteBoundary: FC<{ purpose: PermalinkPurpose }> = ({ purpose }) => {
    const { permalinkId } = useParams();
    const location = useLocation();

    if (!permalinkId || !parsePermalinkId(permalinkId)) {
        if (purpose === 'info' && permalinkId && LEGACY_ONE_SEGMENT_ROUTES.has(permalinkId)) {
            return <Navigate replace to={{ ...location, pathname: `/web/${permalinkId}` }} />;
        }

        return <AppLayout><FallbackRoute /></AppLayout>;
    }

    return (
        <AppLayout>
            <ConnectionRequired>
                <PermalinkRedirectPage purpose={purpose} />
            </ConnectionRequired>
        </AppLayout>
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
    const pathname = location.pathname === '/' ? '/home' : location.pathname;
    return <Navigate replace to={{ ...location, pathname: `/web${pathname}` }} />;
};
