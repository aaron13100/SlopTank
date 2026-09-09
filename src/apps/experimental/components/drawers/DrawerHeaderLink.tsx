// SlopTank modification notice: added or changed by SlopTank on 2026-07-19, 2026-07-22, 2026-09-09.
import Box from '@mui/material/Box';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import React from 'react';

import { useSystemInfo } from 'hooks/useSystemInfo';
import ListItemLink from 'components/ListItemLink';

import appIcon from 'assets/img/branding/sloptank-mark.svg';

const DrawerHeaderLink = () => {
    const { data: systemInfo } = useSystemInfo();

    return (
        <ListItemLink to='/'>
            <ListItemIcon sx={{ minWidth: 56 }}>
                <Box
                    component='img'
                    src={appIcon}
                    sx={{ height: '2.5rem' }}
                />
            </ListItemIcon>
            <ListItemText
                primary={systemInfo?.ServerName || 'SlopTank'}
                secondary={systemInfo?.Version}
                slotProps={{
                    primary: { variant: 'h6' }
                }}
            />
        </ListItemLink>);
};

export default DrawerHeaderLink;
