/**
 * In-player subtitle track and appearance menu controller.
 * @module controllers/playback/video/SubtitleTrackMenu
 */

import { getTextSizeMultiplier } from '../../../components/subtitlesettings/subtitleappearancehelper';

const SIZE_MENU_ID = 'subtitlesize';
const SECONDARY_MENU_ID = 'secondarysubtitle';
const SIZE_PRESETS = [
    { id: 'subtitle-size-75', name: '75%', textSize: 'smaller', multiplier: 0.75 },
    { id: 'subtitle-size-100', name: '100%', textSize: '', multiplier: 1 },
    { id: 'subtitle-size-125', name: '125%', textSize: 'large', multiplier: 1.25 },
    { id: 'subtitle-size-150', name: '150%', textSize: 'larger', multiplier: 1.5 },
    { id: 'subtitle-size-200', name: '200%', textSize: 'extralarge', multiplier: 2 }
];

/**
 * Owns the subtitle button interaction, including nested secondary-track and
 * text-size sheets. Dependencies are replaceable for component-level tests;
 * production callers normally provide only the button and OSD callbacks.
 */
export default class SubtitleTrackMenu {
    /**
     * @param {Object} options - Menu dependencies and OSD callbacks.
     * @param {HTMLElement} options.button - In-player subtitle button.
     * @param {Function} options.getPlayer - Returns the active player.
     * @param {Function} options.resetIdle - Resets the OSD idle state.
     * @param {Function} options.toggleSubtitleSync - Refreshes subtitle sync UI.
     * @param {Function} options.loadActionSheet - Loads the action-sheet UI.
     * @param {Object} options.playback - Playback manager adapter.
     * @param {Object} options.settings - User settings adapter.
     * @param {Function} options.translate - String translation adapter.
     */
    constructor(options) {
        this.button = options.button;
        this.getPlayer = options.getPlayer;
        this.loadActionSheet = options.loadActionSheet;
        this.playback = options.playback;
        this.resetIdle = options.resetIdle;
        this.settings = options.settings;
        this.toggleSubtitleSync = options.toggleSubtitleSync;
        this.translate = options.translate;
        this.button.addEventListener('click', this.onClick);
    }

    onClick = () => {
        this.show().catch(error => {
            console.error('[SubtitleTrackMenu] failed to show subtitle menu', error);
        });
    };

    /**
     * Remove the DOM listener owned by this controller.
     * @returns {void}
     */
    destroy() {
        this.button.removeEventListener('click', this.onClick);
    }

    /**
     * Show the primary subtitle action sheet for the active player.
     * @returns {Promise<void>}
     */
    async show() {
        const player = this.getPlayer();
        if (!player) {
            return;
        }

        const actionSheet = await this.loadActionSheet();
        const currentIndex = this.playback.getSubtitleStreamIndex(player) ?? -1;
        const streams = [
            { Index: -1, DisplayTitle: this.translate('Off') },
            ...this.playback.subtitleTracks(player)
        ];
        const secondaryStreams = this.playback.secondarySubtitleTracks(player);
        const items = streams.map(stream => ({
            id: stream.Index,
            name: stream.DisplayTitle,
            selected: stream.Index === currentIndex
        }));

        items.unshift({
            id: SIZE_MENU_ID,
            name: this.translate('SubtitleSize')
        });

        if (this.canAddSecondarySubtitle(player, streams, secondaryStreams, currentIndex)) {
            items.splice(1, 0, {
                id: SECONDARY_MENU_ID,
                name: this.translate('SecondarySubtitles')
            });
        }

        try {
            const selectedId = await actionSheet.show({
                title: this.translate('Subtitles'),
                items,
                positionTo: this.button
            });

            if (selectedId === SIZE_MENU_ID) {
                await this.showSizeMenu(actionSheet, player);
            } else if (selectedId === SECONDARY_MENU_ID) {
                await this.showSecondaryMenu(actionSheet, player);
            } else if (selectedId != null) {
                const selectedIndex = parseInt(selectedId, 10);
                if (Number.isFinite(selectedIndex) && selectedIndex !== currentIndex) {
                    this.playback.setSubtitleStreamIndex(selectedIndex, player);
                }
                this.toggleSubtitleSync();
            }
        } finally {
            this.resetIdle();
        }
    }

    canAddSecondarySubtitle(player, streams, secondaryStreams, currentIndex) {
        return this.playback.playerHasSecondarySubtitleSupport(player)
            && streams.length > 1
            && secondaryStreams.length > 0
            && currentIndex !== -1
            && this.playback.trackHasSecondarySubtitleSupport(
                this.playback.getSubtitleStream(player, currentIndex),
                player
            );
    }

    async showSecondaryMenu(actionSheet, player) {
        if (!this.playback.playerHasSecondarySubtitleSupport(player)) {
            return;
        }

        const currentIndex = this.playback.getSecondarySubtitleStreamIndex(player) ?? -1;
        const streams = [
            { Index: -1, DisplayTitle: this.translate('Off') },
            ...this.playback.secondarySubtitleTracks(player)
        ];
        const selectedId = await actionSheet.show({
            title: this.translate('SecondarySubtitles'),
            items: streams.map(stream => ({
                id: stream.Index,
                name: stream.DisplayTitle,
                selected: stream.Index === currentIndex
            })),
            positionTo: this.button
        });

        if (selectedId != null) {
            const selectedIndex = parseInt(selectedId, 10);
            if (Number.isFinite(selectedIndex) && selectedIndex !== currentIndex) {
                this.playback.setSecondarySubtitleStreamIndex(selectedIndex, player);
            }
        }
    }

    async showSizeMenu(actionSheet, player) {
        const appearanceSettings = this.settings.getSubtitleAppearanceSettings();
        const currentMultiplier = getTextSizeMultiplier(appearanceSettings.textSize);
        const selectedId = await actionSheet.show({
            title: this.translate('SubtitleSize'),
            items: SIZE_PRESETS.map(preset => ({
                id: preset.id,
                name: preset.name,
                selected: preset.multiplier === currentMultiplier
            })),
            positionTo: this.button
        });
        const selectedPreset = SIZE_PRESETS.find(preset => preset.id === selectedId);

        if (!selectedPreset || selectedPreset.multiplier === currentMultiplier) {
            return;
        }

        this.settings.setSubtitleAppearanceSettings({
            ...appearanceSettings,
            textSize: selectedPreset.textSize
        });
        if (typeof player.updateSubtitleAppearance === 'function') {
            player.updateSubtitleAppearance();
        }
    }
}
