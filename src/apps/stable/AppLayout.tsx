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
