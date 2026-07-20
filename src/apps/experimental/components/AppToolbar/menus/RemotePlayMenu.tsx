import Warning from '@mui/icons-material/Warning';
import CircularProgress from '@mui/material/CircularProgress';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu, { type MenuProps } from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import React, { FC, useEffect, useState } from 'react';

import globalize from 'lib/globalize';
import type { PlayTarget } from 'types/playTarget';

import PlayTargetIcon from '../../PlayTargetIcon';
import { getRemotePlayMenuState } from './remotePlayMenuState';

interface RemotePlayMenuProps extends MenuProps {
    onMenuClose: () => void
    /** Supplies the available play targets. */
    fetchTargets: () => Promise<PlayTarget[]>
    /** Whether the cast plugin was loaded at startup. */
    isCastPluginLoaded: boolean
    /** Invoked with the target the user picked. */
    onSelectTarget: (target: PlayTarget) => void
}

export const ID = 'app-remote-play-menu';

/**
 * Presentational menu listing the available remote play targets.
 *
 * Deliberately holds no reference to the playback or plugin singletons: its
 * data arrives through props so the menu can be rendered and asserted on
 * without booting the rest of the app.
 */
const RemotePlayMenu: FC<RemotePlayMenuProps> = ({
    anchorEl,
    open,
    onMenuClose,
    fetchTargets,
    isCastPluginLoaded,
    onSelectTarget
}) => {
    // null means the lookup has not completed yet, which is rendered as a
    // "searching" state rather than being conflated with "found nothing".
    const [ playbackTargets, setPlaybackTargets ] = useState<PlayTarget[] | null>(null);

    const onPlayTargetClick = (target: PlayTarget) => {
        onSelectTarget(target);
        onMenuClose();
    };

    useEffect(() => {
        const fetchPlaybackTargets = async () => {
            setPlaybackTargets(await fetchTargets());
        };

        if (open) {
            setPlaybackTargets(null);
            fetchPlaybackTargets()
                .catch(err => {
                    console.error('[AppRemotePlayMenu] unable to get playback targets', err);
                    // Surface the failure as "none found" instead of leaving the
                    // menu stuck on the searching state forever.
                    setPlaybackTargets([]);
                });
        }
    }, [ open, setPlaybackTargets, fetchTargets ]);

    const menuState = getRemotePlayMenuState(isCastPluginLoaded, playbackTargets);

    return (
        <Menu
            anchorEl={anchorEl}
            anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'right'
            }}
            transformOrigin={{
                vertical: 'top',
                horizontal: 'right'
            }}
            id={ID}
            keepMounted
            open={open}
            onClose={onMenuClose}
        >
            {menuState.kind === 'unsupported' && (
                <MenuItem disabled>
                    <ListItemIcon>
                        <Warning />
                    </ListItemIcon>
                    <ListItemText>
                        {globalize.translate('GoogleCastUnsupported')}
                    </ListItemText>
                </MenuItem>
            )}

            {menuState.kind === 'discovering' && (
                <MenuItem disabled>
                    <ListItemIcon>
                        <CircularProgress size={20} />
                    </ListItemIcon>
                    <ListItemText>
                        {globalize.translate('SearchingForCastDevices')}
                    </ListItemText>
                </MenuItem>
            )}

            {menuState.kind === 'empty' && (
                <MenuItem disabled>
                    <ListItemIcon>
                        <Warning />
                    </ListItemIcon>
                    <ListItemText>
                        {globalize.translate('NoCastDevicesFound')}
                    </ListItemText>
                </MenuItem>
            )}

            {menuState.kind === 'targets' && menuState.targets.map(target => (
                <MenuItem
                    key={target.id}
                    // Since we are looping over targets there is no good way to avoid creating a new function here
                    // eslint-disable-next-line react/jsx-no-bind
                    onClick={() => onPlayTargetClick(target)}
                >
                    <ListItemIcon>
                        <PlayTargetIcon target={target} />
                    </ListItemIcon>
                    <ListItemText
                        primary={ target.appName ? `${target.name} - ${target.appName}` : target.name }
                        secondary={ target.user?.Name }
                    />
                </MenuItem>
            ))}
        </Menu>
    );
};

export default RemotePlayMenu;
