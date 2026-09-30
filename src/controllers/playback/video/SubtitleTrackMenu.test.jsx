// SlopTank modification notice: added or changed by SlopTank on 2026-07-22, 2026-07-23, 2026-07-24, 2026-07-25, 2026-07-26, 2026-09-09, 2026-09-25, 2026-09-27, 2026-09-29.
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
/**
 * @param withOffset - Offset capability of the playback adapter: false (no
 *   offset support at all), true (offsets fully usable on the active track)
 *   or 'burnedIn' (the player supports offsets but the active track's
 *   rendering path cannot take one).
 * @param subtitleIndex - Stream index the adapter reports as the active
 *   subtitle track; -1 plays with subtitles Off.
 */
function createHarness({
    selectedIds,
    textSize = '',
    playerKind = 'local',
    withSecondary = false,
    withOffset = false,
    subtitleIndex = 3
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

    const offsetState = {
        supported: withOffset !== false,
        canHandle: withOffset === true,
        enableShowingCalls: []
    };
    const playback = {
        secondarySelections: [],
        subtitleSelections: [],
        canHandleOffsetOnCurrentSubtitle: () => offsetState.canHandle,
        enableShowingSubtitleOffset: p => offsetState.enableShowingCalls.push(p),
        getSubtitleStream: (_, index) => [
            { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'English', Index: 3 },
            { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'French', Index: 4 }
        ].find(stream => stream.Index === index),
        getSubtitleStreamIndex: () => subtitleIndex,
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
        supportSubtitleOffset: () => offsetState.supported,
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
        offsetState,
        options,
        playback,
        player,
        settings,
        toasts,
        toggleSubtitleSyncActions
    };
}

const sizerContainer = () => document.querySelector('.subtitleSizerContainer');

/** A promise plus its resolve, so a test controls when a boundary answers. */
function createDeferred() {
    let resolve;
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

        expect(harness.actionSheet.calls[0].items.map(item => item.divider ? '---' : item.name)).toEqual([
            'HeaderSubtitleAppearance',
            'SecondarySubtitles',
            '---',
            'Off',
            'English'
        ]);
        expect(harness.actionSheet.calls[1].title).toBe('SecondarySubtitles');
        expect(harness.playback.secondarySelections).toEqual([ 4 ]);
    });

    /**
     * Owner decision 2026-09-27: the subtitle offset entry belongs on this
     * Subtitles (CC) menu, next to appearance, where the rest of the subtitle
     * controls already live -- it used to sit behind the gear menu instead.
     * Selecting it must drive the exact same overlay path the gear entry
     * drove: tell the player to show offsets, then open the sync overlay.
     */
    it('lists Subtitle Offset right after appearance and opens the sync overlay', async () => {
        const harness = createHarness({
            selectedIds: [ 'subtitleoffset' ],
            withSecondary: true,
            withOffset: true
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(1));

        expect(harness.actionSheet.calls[0].items.map(item => item.divider ? '---' : item.name)).toEqual([
            'HeaderSubtitleAppearance',
            'SubtitleOffset',
            'SecondarySubtitles',
            '---',
            'Off',
            'English'
        ]);

        expect(harness.offsetState.enableShowingCalls).toEqual([ harness.player ]);
        expect(harness.getToggleSubtitleSyncCount()).toBe(1);
        expect(harness.toggleSubtitleSyncActions).toEqual([ undefined ]);
    });

    it('hides Subtitle Offset while subtitles are Off', async () => {
        const harness = createHarness({
            selectedIds: [ undefined ],
            subtitleIndex: -1,
            withOffset: true
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(1));

        expect(harness.actionSheet.calls[0].items.map(item => item.divider ? '---' : item.name)).toEqual([
            'HeaderSubtitleAppearance',
            '---',
            'Off',
            'English'
        ]);
        expect(harness.offsetState.enableShowingCalls).toEqual([]);
    });

    it('hides Subtitle Offset when the current track cannot take an offset', async () => {
        const harness = createHarness({
            selectedIds: [ undefined ],
            withOffset: 'burnedIn'
        });
        render(<MenuHarness options={harness.options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
        await waitFor(() => expect(harness.actionSheet.calls).toHaveLength(1));

        expect(harness.actionSheet.calls[0].items.map(item => item.name)).not.toContain('SubtitleOffset');
        expect(harness.offsetState.enableShowingCalls).toEqual([]);
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

    /**
     * Regression coverage for queue task c288: a sibling of that task's
     * audioTrackMenu.js fix, same shape as the c209 dropped-promise bugs.
     * `show()`'s `setSubtitleStreamIndex` call was not awaited, so the
     * `finally`'s `resetIdle()` fired before the new subtitle stream had
     * actually taken effect.
     */
    it('resets the OSD idle timer only after the picked subtitle stream has actually changed (c288 sibling)', async () => {
        const player = { id: 'player-1' };
        const setSubtitleStreamIndexDeferred = createDeferred();
        const subtitleSelections = [];
        let resetIdleCount = 0;
        const actionSheet = { show: () => Promise.resolve('4') };
        const menu = new SubtitleTrackMenu({
            button: document.createElement('button'),
            getPlayer: () => player,
            loadActionSheet: () => Promise.resolve(actionSheet),
            loadSizer: () => Promise.resolve(SubtitleSizer),
            playback: {
                getSubtitleStreamIndex: () => 3,
                playerHasSecondarySubtitleSupport: () => false,
                secondarySubtitleTracks: () => [],
                setSubtitleStreamIndex: (index, p) => {
                    subtitleSelections.push([ index, p ]);
                    return setSubtitleStreamIndexDeferred.promise;
                },
                subtitleTracks: () => [
                    { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'English', Index: 3 },
                    { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'French', Index: 4 }
                ]
            },
            resetIdle: () => {
                resetIdleCount++;
            },
            settings: { getSubtitleAppearanceSettings: () => ({ textSize: '', verticalPosition: -5 }) },
            showToast: () => undefined,
            toggleSubtitleSync: () => undefined,
            translate: key => key
        });

        const showPromise = menu.show();

        await waitFor(() => expect(subtitleSelections).toHaveLength(1));
        expect(subtitleSelections[0]).toEqual([ 4, player ]);

        // The stream change has not settled yet: the finally's idle reset
        // must not have fired.
        await sleep(30);
        expect(resetIdleCount).toBe(0);

        setSubtitleStreamIndexDeferred.resolve();
        await showPromise;
        expect(resetIdleCount).toBe(1);
    });

    /** Same regression as above, for the secondary-subtitle picker. */
    it('resets the OSD idle timer only after the picked secondary subtitle stream has actually changed (c288 sibling)', async () => {
        const player = { id: 'player-1' };
        const setSecondaryDeferred = createDeferred();
        const secondarySelections = [];
        let resetIdleCount = 0;
        const selections = [ 'secondarysubtitle', '4' ];
        const actionSheet = { show: () => Promise.resolve(selections.shift()) };
        const menu = new SubtitleTrackMenu({
            button: document.createElement('button'),
            getPlayer: () => player,
            loadActionSheet: () => Promise.resolve(actionSheet),
            loadSizer: () => Promise.resolve(SubtitleSizer),
            playback: {
                getSecondarySubtitleStreamIndex: () => -1,
                getSubtitleStream: (_, index) => [
                    { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'English', Index: 3 },
                    { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'French', Index: 4 }
                ].find(stream => stream.Index === index),
                getSubtitleStreamIndex: () => 3,
                playerHasSecondarySubtitleSupport: () => true,
                secondarySubtitleTracks: () => [
                    { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'French', Index: 4 }
                ],
                setSecondarySubtitleStreamIndex: (index, p) => {
                    secondarySelections.push([ index, p ]);
                    return setSecondaryDeferred.promise;
                },
                subtitleTracks: () => [
                    { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'English', Index: 3 },
                    { Codec: 'srt', DeliveryMethod: 'External', DisplayTitle: 'French', Index: 4 }
                ],
                trackHasSecondarySubtitleSupport: () => true
            },
            resetIdle: () => {
                resetIdleCount++;
            },
            settings: { getSubtitleAppearanceSettings: () => ({ textSize: '', verticalPosition: -5 }) },
            showToast: () => undefined,
            toggleSubtitleSync: () => undefined,
            translate: key => key
        });

        const showPromise = menu.show();

        await waitFor(() => expect(secondarySelections).toHaveLength(1));
        expect(secondarySelections[0]).toEqual([ 4, player ]);

        await sleep(30);
        expect(resetIdleCount).toBe(0);

        setSecondaryDeferred.resolve();
        await showPromise;
        expect(resetIdleCount).toBe(1);
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
