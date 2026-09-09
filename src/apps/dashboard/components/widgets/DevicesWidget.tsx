// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
import React from 'react';
import globalize from 'lib/globalize';
import Widget from './Widget';
import DeviceCard from 'apps/dashboard/features/devices/components/DeviceCard';
import Stack from '@mui/material/Stack';
import useLiveSessions from 'apps/dashboard/features/sessions/hooks/useLiveSessions';

const DevicesWidget = () => {
    const { data: devices } = useLiveSessions();

    return (
        <Widget
            title={globalize.translate('HeaderDevices')}
            href='/web/dashboard/devices'
        >
            <Stack direction='row' flexWrap='wrap' gap={2}>
                {devices?.map(device => (
                    <DeviceCard
                        key={device.Id}
                        device={device}
                    />
                ))}
            </Stack>
        </Widget>
    );
};

export default DevicesWidget;
