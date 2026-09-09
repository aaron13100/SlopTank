// SlopTank modification notice: added or changed by SlopTank on 2026-08-12, 2026-09-09.
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Typography from '@mui/material/Typography';
import React, { useEffect, useRef, useState, type FC } from 'react';

import AppToolbar from 'components/toolbar/AppToolbar';
import { EventType } from 'constants/eventType';
import Events, { type Event } from 'utils/events';

import RemotePlayButton from './RemotePlayButton';
import SyncPlayButton from './SyncPlayButton';

/**
 * The toolbar drawn over a playing video: a way back, the title of what is
 * playing, and the cast controls.
 *
 * It appears and fades with the playback controls, driven by the same
 * SHOW_VIDEO_OSD event the legacy OSD raises for its own bottom bar, so the
 * two never disagree about whether the viewer is being shown any controls.
 *
 * Rendered by the app layout in place of the navigation toolbar, rather than
 * by the video page itself, so that exactly one component decides what the
 * chrome across the top of the screen is at any moment. The previous
 * arrangement had the video page draw this one while the layout separately
 * decided, from the URL, whether to draw the navigation one; the two got out
 * of step the moment a playing video's address canonicalized (2026-08-12).
 *
 * allow-no-test-found: e2e/video-osd-chrome.spec.ts drives this through the
 * real player, which is the only place the fade is observable.
 */
const VideoOsdToolbar: FC = () => {
    const documentRef = useRef<Document>(document);
    const [ isVisible, setIsVisible ] = useState(true);
    const [ videoTitle, setVideoTitle ] = useState<string>('');

    useEffect(() => {
        const doc = documentRef.current;
        if (!doc) return;

        const onShowVideoOsd = (_e: Event, isShowing: boolean) => {
            setIsVisible(isShowing);
        };

        const onTitleChange = (_e: Event, title: string) => {
            setVideoTitle(title);
        };

        Events.on(doc, EventType.SHOW_VIDEO_OSD, onShowVideoOsd);
        Events.on(doc, EventType.VIDEO_TITLE_CHANGE, onTitleChange);

        return () => {
            Events.off(doc, EventType.SHOW_VIDEO_OSD, onShowVideoOsd);
            Events.off(doc, EventType.VIDEO_TITLE_CHANGE, onTitleChange);
        };
    }, []);

    return (
        <Fade
            in={isVisible}
            easing='fade-out'
        >
            <Box sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                // The player container is a fixed, full-viewport element
                // outside the React tree, and raises itself to z-index 1000 in
                // some modes. Without a stacking order of its own this toolbar
                // would be painted behind the video it belongs to.
                zIndex: 'appBar',
                color: 'white'
            }}>
                <AppToolbar
                    isDrawerAvailable={false}
                    isDrawerOpen={false}
                    isBackButtonAvailable
                    isUserMenuAvailable={false}
                    buttons={
                        <>
                            <SyncPlayButton />
                            <RemotePlayButton />
                        </>
                    }
                >
                    <Typography>{videoTitle}</Typography>
                </AppToolbar>
            </Box>
        </Fade>
    );
};

export default VideoOsdToolbar;
