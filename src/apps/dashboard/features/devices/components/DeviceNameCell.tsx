import React, { FC } from 'react';

import { DeviceInfoCell } from 'apps/dashboard/features/devices/types/deviceInfoCell';
import globalize from 'lib/globalize';
import { getDeviceIcon } from 'utils/image';

const DeviceNameCell: FC<DeviceInfoCell> = ({ row, renderedCellValue }) => (
    <>
        <img
            alt={row.original.AppName || row.original.Name || globalize.translate('LabelDevice')}
            src={getDeviceIcon(row.original)}
            style={{
                display: 'inline-block',
                maxWidth: '1.5em',
                maxHeight: '1.5em',
                marginRight: '1rem'
            }}
        />
        {renderedCellValue}
    </>
);

export default DeviceNameCell;
