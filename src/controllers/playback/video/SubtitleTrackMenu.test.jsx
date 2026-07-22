import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PropTypes from 'prop-types';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import SubtitleTrackMenu from './SubtitleTrackMenu';

function MenuHarness({ options }) {
    const buttonRef = useRef(null);

    useEffect(() => {
        const menu = new SubtitleTrackMenu({
            ...options,
            button: buttonRef.current
        });

        return () => menu.destroy();
    }, [ options ]);

    return <button ref={buttonRef}>Subtitles</button>;
}

MenuHarness.propTypes = {
    options: PropTypes.object.isRequired
};

function createHarness({ selectedIds, textSize = '', canApplyLive = true }) {
    let appearanceSettings = { textSize, verticalPosition: -3 };
    let liveApplyCount = 0;
    const player = canApplyLive ? {
        updateSubtitleAppearance: () => {
            liveApplyCount++;
        }
    } : {};
    const actionSheet = {
        calls: [],
        show: options => {
            actionSheet.calls.push(options);
            return Promise.resolve(selectedIds.shift());
        }
    };

    const playback = {
        secondarySelections: [],
        subtitleSelections: [],
        getSubtitleStream: () => undefined,
        getSubtitleStreamIndex: () => 3,
        getSecondarySubtitleStreamIndex: () => -1,
        playerHasSecondarySubtitleSupport: () => false,
        secondarySubtitleTracks: () => [],
        setSecondarySubtitleStreamIndex: index => playback.secondarySelections.push(index),
        setSubtitleStreamIndex: index => playback.subtitleSelections.push(index),
        subtitleTracks: () => [ { DisplayTitle: 'English', Index: 3 } ],
        trackHasSecondarySubtitleSupport: () => false
    };
    const settings = {
        savedAppearances: [],
        getSubtitleAppearanceSettings: () => ({ ...appearanceSettings }),
        setSubtitleAppearanceSettings: value => {
            appearanceSettings = { ...value };
            settings.savedAppearances.push({ ...value });
        }
    };
    let resetIdleCount = 0;
    let toggleSubtitleSyncCount = 0;
    const options = {
        getPlayer: () => player,
        loadActionSheet: () => Promise.resolve(actionSheet),
        playback,
        resetIdle: () => {
            resetIdleCount++;
        },
        settings,
        toggleSubtitleSync: () => {
            toggleSubtitleSyncCount++;
        },
        translate: key => key
    };

    return {
        actionSheet,
        getLiveApplyCount: () => liveApplyCount,
        getResetIdleCount: () => resetIdleCount,
        getToggleSubtitleSyncCount: () => toggleSubtitleSyncCount,
        options,
        playback,
        player,
        settings
    };
}

describe('SubtitleTrackMenu', () => {
    afterEach(cleanup);

    it('opens from the player button, applies 125% live, and shows it selected on replay', async () => {
        const harness = createHarness({
            selectedIds: [ 'subtitlesize', 'subtitle-size-125', 'subtitlesize', undefined ]
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));

        await waitFor(() => {
            expect(harness.settings.savedAppearances).toContainEqual({
                textSize: 'large',
                verticalPosition: -3
            });
        });
        expect(harness.getLiveApplyCount()).toBe(1);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(4));

        const replaySizeItems = harness.actionSheet.calls[3].items;
        expect(replaySizeItems.find(item => item.id === 'subtitle-size-125')).toEqual({
            id: 'subtitle-size-125',
            name: '125%',
            selected: true
        });
    });

    it('leaves tracks and appearance unchanged when the action sheet is dismissed', async () => {
        const harness = createHarness({ selectedIds: [ undefined ] });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(1));

        expect(harness.playback.subtitleSelections).toEqual([]);
        expect(harness.settings.savedAppearances).toEqual([]);
        expect(harness.getResetIdleCount()).toBe(1);
    });

    it('maps a legacy medium value to 100% and still persists when live apply is unavailable', async () => {
        const harness = createHarness({
            canApplyLive: false,
            selectedIds: [ 'subtitlesize', 'subtitle-size-150' ],
            textSize: 'medium'
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(2));

        const sizeItems = harness.actionSheet.calls[1].items;
        expect(sizeItems.find(item => item.id === 'subtitle-size-100')?.selected).toBe(true);
        expect(harness.settings.savedAppearances).toContainEqual({
            textSize: 'larger',
            verticalPosition: -3
        });
    });
});
