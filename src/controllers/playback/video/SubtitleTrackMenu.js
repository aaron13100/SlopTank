// SlopTank modification notice: added or changed by SlopTank on 2026-07-22, 2026-07-23, 2026-07-24, 2026-07-25, 2026-09-09, 2026-09-25, 2026-09-27, 2026-09-29.
/**
 * In-player subtitle track and appearance menu controller.
 * @module controllers/playback/video/SubtitleTrackMenu
 */

import { getTextSizeMultiplier } from '../../../components/subtitlesettings/subtitleappearancehelper';
import {
    buildSubtitleMenuItems,
    buildSubtitleTrackItems,
    languageBadge,
    OFFSET_MENU_ID,
    SECONDARY_MENU_ID,
    SIZE_MENU_ID
} from './SubtitleMenuItems';

/**
 * Preset fallback for players without the live preview API (remote players).
 * textSize values are the persisted numeric-multiplier format.
 */
const SIZE_PRESETS = [
    { id: 'subtitle-size-25', name: '25%', textSize: '0.25', multiplier: 0.25 },
    { id: 'subtitle-size-50', name: '50%', textSize: '0.5', multiplier: 0.5 },
    { id: 'subtitle-size-75', name: '75%', textSize: '0.75', multiplier: 0.75 },
    { id: 'subtitle-size-100', name: '100%', textSize: '1', multiplier: 1 },
    { id: 'subtitle-size-125', name: '125%', textSize: '1.25', multiplier: 1.25 },
    { id: 'subtitle-size-150', name: '150%', textSize: '1.5', multiplier: 1.5 },
    { id: 'subtitle-size-200', name: '200%', textSize: '2', multiplier: 2 }
];

/**
 * Owns the subtitle button interaction, including nested secondary-track and
 * text-size controls. Dependencies are replaceable for component-level tests;
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
     * @param {Function} options.loadSizer - Loads the SubtitleSizer overlay class.
     * @param {Function} options.showToast - Shows a transient message.
     * @param {Object} options.playback - Playback manager adapter.
     * @param {Object} options.settings - User settings adapter.
     * @param {Function} options.translate - String translation adapter.
     */
    constructor(options) {
        this.button = options.button;
        this.getPlayer = options.getPlayer;
        this.loadActionSheet = options.loadActionSheet;
        this.loadSizer = options.loadSizer;
        this.playback = options.playback;
        this.resetIdle = options.resetIdle;
        this.settings = options.settings;
        this.showToast = options.showToast;
        this.toggleSubtitleSync = options.toggleSubtitleSync;
        this.translate = options.translate;
        this.sizer = null;
        this.button.addEventListener('click', this.onClick);
    }

    onClick = () => {
        this.show().catch(error => {
            // Dismissing the sheet without choosing is a normal interaction,
            // not a failure.
            if (error?.code === 'ACTION_SHEET_CANCELED') {
                return;
            }
            console.error('[SubtitleTrackMenu] failed to show subtitle menu', error);
        });
    };

    /**
     * The overlay can close itself (its own button, Escape), so its owner
     * learns about it here instead of holding a reference to a dead overlay.
     * Resetting idle hands the OSD back its normal auto-hide behavior.
     */
    onSizerClosed = () => {
        this.sizer = null;
        this.resetIdle();
    };

    /**
     * Remove the DOM listener owned by this controller and close any overlay.
     * @returns {void}
     */
    destroy() {
        this.closeOverlays();
        this.button.removeEventListener('click', this.onClick);
    }

    /**
     * Whether an in-player overlay owned by this menu is currently on screen.
     * The OSD uses this to stay awake while the user is adjusting, and to route
     * a press outside the overlay to a dismissal.
     * @returns {boolean} True while the size overlay is open.
     */
    hasOpenOverlay() {
        return !!this.sizer;
    }

    /**
     * Close the size overlay if one is open (also ends its live preview).
     * The OSD calls this on player change and on a new item's playbackstart
     * so a stale overlay can never manipulate a released player or linger
     * into the next video.
     * @returns {void}
     */
    closeOverlays() {
        if (this.sizer) {
            this.sizer.destroy();
            this.sizer = null;
        }
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
        // The player can change while awaiting module loads or an open
        // sheet; acting on the captured one would drive a released player.
        if (this.getPlayer() !== player) {
            return;
        }

        const currentIndex = this.playback.getSubtitleStreamIndex(player) ?? -1;
        const tracks = this.playback.subtitleTracks(player);
        // Off counts as a stream for the secondary-support rule, as it always did.
        const streams = [ { Index: -1 }, ...tracks ];
        const secondaryStreams = this.playback.secondarySubtitleTracks(player);
        const showSecondary = this.canAddSecondarySubtitle(player, streams, secondaryStreams, currentIndex);
        const items = buildSubtitleMenuItems({
            streams: tracks,
            currentIndex,
            translate: this.translate,
            locale: this.getLocale(),
            appearanceValue: this.formatAppearanceValue(),
            offsetValue: this.formatOffsetValue(player),
            // The offset entry sits directly under appearance (owner decision
            // 2026-09-27: offset is a subtitle appearance control, not a
            // playback setting), and only when the player can act on it.
            showOffset: this.canShiftSubtitleOffset(player, currentIndex),
            showSecondary,
            // Only read the secondary selection when the row is shown.
            secondaryValue: showSecondary ? this.formatSecondaryValue(player, secondaryStreams) : undefined
        });

        try {
            const selectedId = await actionSheet.show({
                title: this.translate('Subtitles'),
                items,
                positionTo: this.button
            });

            if (this.getPlayer() !== player) {
                return;
            }

            if (selectedId === SIZE_MENU_ID) {
                await this.showSizeControl(actionSheet, player);
            } else if (selectedId === SECONDARY_MENU_ID) {
                await this.showSecondaryMenu(actionSheet, player);
            } else if (selectedId === OFFSET_MENU_ID) {
                // The exact path the gear entry used: the sync overlay only
                // renders its offset UI once the player has been told to
                // show it, so ordering these calls matters.
                this.playback.enableShowingSubtitleOffset(player);
                this.toggleSubtitleSync();
            } else if (selectedId != null) {
                const selectedIndex = parseInt(selectedId, 10);
                if (Number.isFinite(selectedIndex) && selectedIndex !== currentIndex) {
                    await this.playback.setSubtitleStreamIndex(selectedIndex, player);
                }
                this.toggleSubtitleSync();
            }
        } finally {
            this.resetIdle();
        }
    }

    /**
     * Locale for language names on track rows.
     * @returns {string|undefined} The document language, when set.
     */
    getLocale() {
        return document.documentElement.lang || undefined;
    }

    /**
     * Current text size as shown beside the Appearance row.
     * @returns {string} Percentage such as "100%".
     */
    formatAppearanceValue() {
        const { textSize } = this.settings.getSubtitleAppearanceSettings();
        return `${Math.round(getTextSizeMultiplier(textSize) * 100)}%`;
    }

    /**
     * Current subtitle offset as shown beside the Offset row.
     * @param {Object} player - Player captured at menu open.
     * @returns {string|undefined} Signed seconds such as "+0.5s", or undefined when the adapter cannot report one.
     */
    formatOffsetValue(player) {
        const offset = Number(this.playback.getPlayerSubtitleOffset?.(player));
        if (!Number.isFinite(offset)) {
            return undefined;
        }
        const rounded = Math.round(offset * 100) / 100;
        return `${rounded > 0 ? '+' : ''}${rounded}s`;
    }

    /**
     * Current secondary track as shown beside the Secondary Subtitles row.
     * @param {Object} player - Player captured at menu open.
     * @param {Object[]} secondaryStreams - Tracks eligible as secondary.
     * @returns {string} Language code of the active secondary track, or the translated Off.
     */
    formatSecondaryValue(player, secondaryStreams) {
        const index = this.playback.getSecondarySubtitleStreamIndex(player) ?? -1;
        const active = secondaryStreams.find(stream => stream.Index === index);
        const badge = active ? languageBadge(active) : null;
        return badge?.text ?? this.translate('Off');
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

    /**
     * Whether the offset entry belongs in the sheet for the captured player:
     * a subtitle track must be active, the player must support offsets at
     * all, and the active track's rendering path must accept one. Anything
     * else keeps the entry out of the sheet entirely -- the old gear entry
     * showed an explanation toast on click instead (owner decision
     * 2026-09-27 moved the entry here, which retired that toast path).
     * @param {Object} player - Player captured at menu open.
     * @param {number} currentIndex - Active subtitle stream index, -1 when Off.
     * @returns {boolean} True when selecting the entry can open a usable offset overlay.
     */
    canShiftSubtitleOffset(player, currentIndex) {
        // The offset API is optional on playback adapters (remote players,
        // test doubles); an absent method hides the entry instead of throwing,
        // the same way the size entry probes the player's preview API.
        return currentIndex !== -1
            && !!this.playback.supportSubtitleOffset?.(player)
            && !!this.playback.canHandleOffsetOnCurrentSubtitle?.(player);
    }

    async showSecondaryMenu(actionSheet, player) {
        if (!this.playback.playerHasSecondarySubtitleSupport(player)) {
            return;
        }

        const currentIndex = this.playback.getSecondarySubtitleStreamIndex(player) ?? -1;
        const selectedId = await actionSheet.show({
            title: this.translate('SecondarySubtitles'),
            items: buildSubtitleTrackItems({
                streams: this.playback.secondarySubtitleTracks(player),
                currentIndex,
                translate: this.translate,
                locale: this.getLocale()
            }),
            positionTo: this.button
        });

        if (this.getPlayer() !== player) {
            return;
        }

        if (selectedId != null) {
            const selectedIndex = parseInt(selectedId, 10);
            if (Number.isFinite(selectedIndex) && selectedIndex !== currentIndex) {
                await this.playback.setSecondarySubtitleStreamIndex(selectedIndex, player);
            }
        }
    }

    /**
     * Route the size entry by what the player can actually do: a live slider
     * overlay for the local player, the preset list for remote players that
     * transmit appearance settings, and an honest message for those that
     * cannot -- never a silent no-op.
     * @param {Object} actionSheet - Loaded action-sheet UI.
     * @param {Object} player - Player captured at menu open.
     * @returns {Promise<void>}
     */
    async showSizeControl(actionSheet, player) {
        if (typeof player.setSubtitleAppearancePreview === 'function') {
            await this.openSizer(player);
            return;
        }

        if (!player.supportsSubtitleAppearanceSettings) {
            this.showToast(this.translate('SubtitleSizeUnavailableForDevice'));
            return;
        }

        await this.showSizePresetMenu(actionSheet, player);
    }

    /**
     * Open the live slider overlay (closing any previous one first).
     * @param {Object} player - Player captured at menu open.
     * @returns {Promise<void>}
     */
    async openSizer(player) {
        const SubtitleSizer = await this.loadSizer();
        if (this.getPlayer() !== player) {
            return;
        }

        this.closeOverlays();
        // Both overlays occupy the same slot over the video; never stack them.
        this.toggleSubtitleSync('forceToHide');
        this.sizer = new SubtitleSizer({
            player,
            settings: this.settings,
            translate: this.translate,
            onInteract: this.resetIdle,
            onClose: this.onSizerClosed
        });
    }

    async showSizePresetMenu(actionSheet, player) {
        const appearanceSettings = this.settings.getSubtitleAppearanceSettings();
        const currentMultiplier = getTextSizeMultiplier(appearanceSettings.textSize);
        const selectedId = await actionSheet.show({
            title: this.translate('LabelTextSize'),
            items: SIZE_PRESETS.map(preset => ({
                id: preset.id,
                name: preset.name,
                selected: preset.multiplier === currentMultiplier
            })),
            positionTo: this.button
        });
        const selectedPreset = SIZE_PRESETS.find(preset => preset.id === selectedId);

        if (!selectedPreset || this.getPlayer() !== player) {
            return;
        }

        if (selectedPreset.multiplier !== currentMultiplier) {
            this.settings.setSubtitleAppearanceSettings({
                ...appearanceSettings,
                textSize: selectedPreset.textSize
            });
            if (typeof player.updateSubtitleAppearance === 'function') {
                player.updateSubtitleAppearance();
            }
        }

        // The receiver only picks appearance up from a new play message
        // (queue advancement inside the receiver does not resend it).
        this.showToast(this.translate('SubtitleSizeAppliesOnCastStart'));
    }
}
