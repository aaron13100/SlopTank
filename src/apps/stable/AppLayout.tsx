// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
import React, { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

import AppBody from 'components/AppBody';
import CustomCss from 'components/CustomCss';
import ThemeCss from 'components/ThemeCss';

export default function AppLayout({ children }: Readonly<{ children?: ReactNode }>) {
    return (
        <>
            <AppBody>
                {children ?? <Outlet />}
            </AppBody>
            <ThemeCss />
            <CustomCss />
        </>
    );
}
