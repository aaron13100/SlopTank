import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PropTypes from 'prop-types';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SubtitleSizer from '../../../components/subtitlesizer/subtitlesizer';
import SubtitleTrackMenu from './SubtitleTrackMenu';

function MenuHarness({ options }) {
    const buttonRef = useRef(null);

    useEffect(() => {
        const menu = new SubtitleTrackMenu({
            ...options,
            button: buttonRef.current
        });
        options.onMenu?.(menu);

        return () => menu.destroy();
    }, [ options ]);

    return <button ref={buttonRef}>Subtitles</button>;
}

MenuHarness.propTypes = {
    options: PropTypes.object.isRequired
};

/**
 * Build the menu with real collaborators wherever the environment allows: the
 * real SubtitleSizer overlay (rendered into jsdom's document) and a player
 * object exercised through the same preview API contract the HTML video
 * player implements, recording each call's effect on its own state.
 */
function createHarness({
    selectedIds,
    textSize = '',
    playerKind = 'local',
    withSecondary = false
}) {
    let appearanceSettings = { textSize, verticalPosition: -5 };
    let liveApplyCount = 0;
    const player = {
        previewLog: [],
        updateSubtitleAppearance: () => {
            liveApplyCount++;
        }
    };
    if (playerKind === 'local') {
        player.activePreview = null;
        player.setSubtitleAppearancePreview = preview => {
            player.activePreview = preview;
            player.previewLog.push(preview);
        };
        player.clearSubtitleAppearancePreview = () => {
            player.activePreview = null;
            player.previewLog.push(null);
        };
        player.getSubtitleRenderingInfo = () => ({
            path: 'custom', canAdjustSize: true, canAdjustOffset: true
        });
    } else if (playerKind === 'cast') {
        player.supportsSubtitleAppearanceSettings = true;
    }
    const actionSheet = {
        calls: [],
        show: options => {
            actionSheet.calls.push(options);
            const next = selectedIds.shift();
            if (next instanceof Error) {
                return Promise.reject(next);
            }
            return Promise.resolve(next);
        }
    };

    const playback = {
        secondarySelections: [],
        subtitleSelections: [],
        getSubtitleStream: (_, index) => [
            { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'English', Index: 3 },
            { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'French', Index: 4 }
        ].find(stream => stream.Index === index),
        getSubtitleStreamIndex: () => 3,
        getSecondarySubtitleStreamIndex: () => -1,
        playerHasSecondarySubtitleSupport: () => withSecondary,
        secondarySubtitleTracks: () => withSecondary ?
            [ { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'French', Index: 4 } ] :
            [],
        setSecondarySubtitleStreamIndex: index => playback.secondarySelections.push(index),
        setSubtitleStreamIndex: index => playback.subtitleSelections.push(index),
        subtitleTracks: () => [
            { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'English', Index: 3 }
        ],
        trackHasSecondarySubtitleSupport: () => withSecondary
    };
    const settings = {
        savedAppearances: [],
        getSubtitleAppearanceSettings: () => ({ ...appearanceSettings }),
        setSubtitleAppearanceSettings: value => {
            appearanceSettings = { ...value };
            settings.savedAppearances.push({ ...value });
        }
    };
    const toasts = [];
    const toggleSubtitleSyncActions = [];
    let resetIdleCount = 0;
    let toggleSubtitleSyncCount = 0;
    const options = {
        getPlayer: () => player,
        loadActionSheet: () => Promise.resolve(actionSheet),
        loadSizer: () => Promise.resolve(SubtitleSizer),
        playback,
        resetIdle: () => {
            resetIdleCount++;
        },
        settings,
        showToast: message => toasts.push(message),
        toggleSubtitleSync: action => {
            toggleSubtitleSyncCount++;
            toggleSubtitleSyncActions.push(action);
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
        settings,
        toasts,
        toggleSubtitleSyncActions
    };
}

const sizerContainer = () => document.querySelector('.subtitleSizerContainer');

describe('SubtitleTrackMenu', () => {
    afterEach(() => {
        cleanup();
        document.querySelectorAll('.subtitleSizer').forEach(el => {
            el.parentNode.remove();
        });
    });

    // @covers subtitle_controls.track_menu.open_sizer.live_preview_persists
    it('opens the live sizer overlay, previews slider moves, and persists on release', async () => {
        const harness = createHarness({ selectedIds: [ 'subtitlesize' ], textSize: '1.5' });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(sizerContainer()).toBeTruthy());

        // opening immediately begins a preview at the persisted size
        expect(harness.player.activePreview).toEqual({
            textSize: '1.5',
            verticalPosition: '-5',
            font: '',
            textWeight: 'normal',
            sampleText: 'SubtitleSizePreviewSample'
        });

        const slider = document.querySelector('.subtitleSizerSlider');
        slider.value = '25';
        fireEvent.input(slider);
        expect(harness.player.activePreview.textSize).toBe('0.25');
        expect(harness.settings.savedAppearances).toEqual([]);

        fireEvent.change(slider);
        expect(harness.settings.savedAppearances).toContainEqual({
            textSize: '0.25',
            verticalPosition: -5
        });

        // closing ends the preview and removes the overlay
        fireEvent.click(document.querySelector('.subtitleSizer-closeButton'));
        expect(harness.player.activePreview).toBeNull();
        expect(sizerContainer()).toBeNull();
    });

    it('previews and persists vertical position, font family, and font weight', async () => {
        const harness = createHarness({ selectedIds: [ 'subtitlesize' ], textSize: '1' });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(sizerContainer()).toBeTruthy());

        const position = document.querySelector('.subtitlePositionSlider');
        position.value = '-8';
        fireEvent.input(position);
        expect(harness.player.activePreview.verticalPosition).toBe('-8');
        expect(harness.settings.savedAppearances).toEqual([]);

        fireEvent.change(position);
        expect(harness.settings.savedAppearances.at(-1)).toMatchObject({
            textSize: '1',
            verticalPosition: '-8'
        });

        const font = document.querySelector('.subtitleFontSelect');
        font.value = 'console';
        fireEvent.change(font);
        expect(harness.player.activePreview.font).toBe('console');
        expect(harness.settings.savedAppearances.at(-1)).toMatchObject({
            font: 'console',
            verticalPosition: '-8'
        });

        const weight = document.querySelector('.subtitleWeightSelect');
        weight.value = 'bold';
        fireEvent.change(weight);
        expect(harness.player.activePreview.textWeight).toBe('bold');
        expect(harness.settings.savedAppearances.at(-1)).toMatchObject({
            font: 'console',
            textWeight: 'bold',
            verticalPosition: '-8'
        });
    });

    // @covers subtitle_controls.track_menu.sizer_dismissal_clears_sample_line
    it('dismisses on Escape, taking the live preview with it', async () => {
        const harness = createHarness({ selectedIds: [ 'subtitlesize' ] });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(sizerContainer()).toBeTruthy());
        expect(harness.player.activePreview).not.toBeNull();

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(sizerContainer()).toBeNull();
        expect(harness.player.activePreview).toBeNull();
    });

    it('reports an open overlay so the OSD can stay awake, and stops after dismissal', async () => {
        let menu;
        const harness = createHarness({ selectedIds: [ 'subtitlesize' ] });
        harness.options.onMenu = m => {
            menu = m;
        };
        render(<MenuHarness options={harness.options} />);

        expect(menu.hasOpenOverlay()).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(menu.hasOpenOverlay()).toBe(true));

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(menu.hasOpenOverlay()).toBe(false);
    });

    it('hides the offset overlay when opening the size overlay so they cannot stack', async () => {
        const harness = createHarness({ selectedIds: [ 'subtitlesize' ] });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(sizerContainer()).toBeTruthy());

        expect(harness.toggleSubtitleSyncActions).toContain('forceToHide');
    });

    it('keeps the secondary subtitle entry and selection flow alongside appearance', async () => {
        const harness = createHarness({
            selectedIds: [ 'secondarysubtitle', '4' ],
            withSecondary: true
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(2));

        expect(harness.actionSheet.calls[0].items.map(item => item.name)).toEqual([
            'HeaderSubtitleAppearance',
            'SecondarySubtitles',
            'Off',
            'English'
        ]);
        expect(harness.actionSheet.calls[1].title).toBe('SecondarySubtitles');
        expect(harness.playback.secondarySelections).toEqual([ 4 ]);
    });

    // @covers subtitle_controls.track_menu.reopen_replaces_overlay
    it('closes the previous sizer before opening another and on closeOverlays', async () => {
        let menu;
        const harness = createHarness({ selectedIds: [ 'subtitlesize', 'subtitlesize' ] });
        harness.options.onMenu = m => {
            menu = m;
        };
        render(<MenuHarness options={harness.options} />);

        const button = screen.getByRole('button', { name: 'Subtitles' });
        fireEvent.click(button);
        await waitFor(() => expect(sizerContainer()).toBeTruthy());
        fireEvent.click(button);
        await waitFor(() => expect(document.querySelectorAll('.subtitleSizerContainer')).toHaveLength(1));

        menu.closeOverlays();
        expect(sizerContainer()).toBeNull();
        expect(harness.player.activePreview).toBeNull();
    });

    // @covers subtitle_controls.track_menu.cast_player.presets_fallback
    it('falls back to presets plus an honest toast for a cast player', async () => {
        const harness = createHarness({
            playerKind: 'cast',
            selectedIds: [ 'subtitlesize', 'subtitle-size-125' ]
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));

        await waitFor(() => {
            expect(harness.settings.savedAppearances).toContainEqual({
                textSize: '1.25',
                verticalPosition: -5
            });
        });
        expect(harness.getLiveApplyCount()).toBe(1);
        expect(harness.toasts).toEqual([ 'SubtitleSizeAppliesOnCastStart' ]);
        expect(sizerContainer()).toBeNull();
    });

    it('shows the preset selected from a persisted numeric multiplier', async () => {
        const harness = createHarness({
            playerKind: 'cast',
            selectedIds: [ 'subtitlesize', undefined ],
            textSize: '1.5'
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(2));

        const sizeItems = harness.actionSheet.calls[1].items;
        expect(sizeItems.find(item => item.id === 'subtitle-size-150')?.selected).toBe(true);
        expect(sizeItems.map(item => item.name)).toEqual(
            [ '25%', '50%', '75%', '100%', '125%', '150%', '200%' ]);
    });

    // @covers subtitle_controls.track_menu.unsupported_player.explains_toast
    it('explains instead of silently no-oping for a player with no appearance support', async () => {
        const harness = createHarness({
            playerKind: 'remote',
            selectedIds: [ 'subtitlesize' ]
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));

        await waitFor(() => {
            expect(harness.toasts).toEqual([ 'SubtitleSizeUnavailableForDevice' ]);
        });
        expect(sizerContainer()).toBeNull();
        expect(harness.settings.savedAppearances).toEqual([]);
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

    it('treats a typed cancellation as a normal interaction, not an error', async () => {
        const cancelError = new Error('ActionSheet closed without resolving'); // allow-raw-error: mirrors the exact untyped rejection shape legacy action sheets produce
        cancelError.code = 'ACTION_SHEET_CANCELED';
        const harness = createHarness({ selectedIds: [ cancelError ] });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.getResetIdleCount()).toBe(1));

        expect(consoleError).not.toHaveBeenCalled();
    });
});
