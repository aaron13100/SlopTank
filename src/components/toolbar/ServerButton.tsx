// SlopTank modification notice: added or changed by SlopTank on 2026-07-19, 2026-07-22, 2026-09-09.
import icon from 'assets/img/branding/sloptank-mark.svg';
import Button from '@mui/material/Button/Button';
import React, { FC } from 'react';
import { Link } from 'react-router-dom';

import { useSystemInfo } from 'hooks/useSystemInfo';

const ServerButton: FC = () => {
    const {
        data: systemInfo,
        isPending
    } = useSystemInfo();

    return (
        <Button
            variant='text'
            size='large'
            color='inherit'
            startIcon={
                <img
                    src={icon}
                    alt=''
                    aria-hidden
                    style={{
                        height: '1.25em',
                        width: '1.25em'
                    }}
                />
            }
            component={Link}
            to='/'
        >
            {isPending ? '' : (systemInfo?.ServerName || 'SlopTank')}
        </Button>
    );
};

export default ServerButton;
