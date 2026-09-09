// SlopTank modification notice: added or changed by SlopTank on 2026-03-12, 2026-07-19, 2026-09-08, 2026-09-09.
import React, { FC, useCallback } from 'react';
import PlaylistAdd from '@mui/icons-material/PlaylistAdd';
import Button from '@mui/material/Button';

import globalize from 'lib/globalize';
import { loadDynamicModule } from 'utils/dynamicImport';

interface NewPlaylistButtonProps {
    isTextVisible: boolean;
}

const NewPlaylistButton: FC<NewPlaylistButtonProps> = ({
    isTextVisible
}) => {
    const showPlaylistEditor = useCallback(() => {
        loadDynamicModule(() => import('components/playlisteditor/playlisteditor'),
            'components/playlisteditor/playlisteditor').then(
            ({ default: PlaylistEditor }) => {
                const serverId = window.ApiClient.serverId();
                const playlistEditor = new PlaylistEditor();
                playlistEditor.show({
                    items: [],
                    serverId
                }).catch(() => {
                    // closed playlist editor
                });
            }).catch(err => {
            console.error('[NewPlaylist] failed to load playlist editor', err);
        });
    }, []);

    return (
        <Button
            variant='contained'
            startIcon={isTextVisible ? <PlaylistAdd /> : undefined}
            onClick={showPlaylistEditor}
        >
            {isTextVisible ? (
                globalize.translate('NewPlaylist')
            ) : (
                <PlaylistAdd />
            )}
        </Button>
    );
};

export default NewPlaylistButton;
