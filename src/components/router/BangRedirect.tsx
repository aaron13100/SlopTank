// SlopTank modification notice: added or changed by SlopTank on 2026-07-19, 2026-09-09.
import React, { useMemo } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

const BangRedirect = () => {
    const location = useLocation();

    const to = useMemo(() => {
        const _to = {
            search: location.search,
            hash: location.hash
        };

        if (location.pathname.startsWith('/!/')) {
            return { ..._to, pathname: location.pathname.substring(2) };
        } else if (location.pathname.startsWith('/!')) {
            return { ..._to, pathname: location.pathname.replace(/^\/!/, '/') };
        } else if (location.pathname.startsWith('!')) {
            return { ..._to, pathname: location.pathname.substring(1) };
        }
    }, [ location ]);

    if (!to) return null;

    console.warn('[BangRedirect] You are using a deprecated URL format. This will stop working in a future SlopTank update.');

    return (
        <Navigate
            replace
            to={to}
        />
    );
};

export default BangRedirect;
