/**
 * In-player subtitle size overlay: a 25%-200% slider that live-applies the
 * size through the player's appearance-preview API (so the change, or a
 * sample line when no cue is on screen, is always visible) and persists the
 * chosen multiplier on release. When the current subtitle's rendering path
 * cannot be resized client-side (ASS/PGS self-styled formats, server
 * burn-in, broken native styling), the overlay explains why instead of
 * silently doing nothing.
 * @module components/subtitlesizer/subtitlesizer
 */

import { getTextSizeMultiplier } from '../subtitlesettings/subtitleappearancehelper';
import Events from '../../utils/events.ts';
import '../../elements/emby-slider/emby-slider';
import template from './subtitlesizer.template.html';
import './subtitlesizer.scss';

/**
 * Instance-scoped overlay controller. One instance per opening; the caller
 * (SubtitleTrackMenu) holds at most one and destroys it on player or item
 * change.
 */
export default class SubtitleSizer {
    /**
     * @param {Object} options - Overlay dependencies.
     * @param {Object} options.player - Player implementing the preview API
     * (setSubtitleAppearancePreview / clearSubtitleAppearancePreview /
     * getSubtitleRenderingInfo / updateSubtitleAppearance).
     * @param {Object} options.settings - User settings adapter
     * (getSubtitleAppearanceSettings / setSubtitleAppearanceSettings).
     * @param {Function} options.translate - String translation adapter.
     */
    constructor(options) {
        this.player = options.player;
        this.settings = options.settings;
        this.translate = options.translate;

        const parent = document.createElement('div');
        document.body.appendChild(parent);
        parent.innerHTML = template.replace('${Close}', this.translate('ButtonClose'));
        this.element = parent;

        this.slider = parent.querySelector('.subtitleSizerSlider');
        this.valueLabel = parent.querySelector('.subtitleSizerValue');
        this.message = parent.querySelector('.subtitleSizerMessage');
        this.sliderContainer = parent.querySelector('.subtitleSizerSliderContainer');

        const initialMultiplier = getTextSizeMultiplier(
            this.settings.getSubtitleAppearanceSettings().textSize);
        this.slider.value = String(Math.round(initialMultiplier * 100));
        this.updateValueLabel();

        this.slider.getBubbleHtml = (_, value) =>
            `<h1 class="sliderBubbleText">${Math.round(value)}%</h1>`;

        this.slider.addEventListener('input', this.onSliderInput);
        this.slider.addEventListener('change', this.onSliderChange);
        parent.querySelector('.subtitleSizer-closeButton')
            .addEventListener('click', this.onCloseClick);
        Events.on(this.player, 'subtitlerenderpathchange', this.onRenderPathChange);

        this.applyCapability();
        this.beginPreview();
    }

    onSliderInput = () => {
        this.updateValueLabel();
        this.beginPreview();
    };

    onSliderChange = () => {
        this.updateValueLabel();
        this.beginPreview();
        this.persist();
    };

    onCloseClick = () => {
        this.destroy();
    };

    onRenderPathChange = () => {
        this.applyCapability();
    };

    /**
     * Current slider position as a persisted-format multiplier string.
     * @private
     * @returns {string} Multiplier, e.g. '1.25'.
     */
    currentMultiplier() {
        return String(parseInt(this.slider.value, 10) / 100);
    }

    updateValueLabel() {
        this.valueLabel.textContent = `${parseInt(this.slider.value, 10)}%`;
    }

    /**
     * Live-apply the slider position through the player preview so the user
     * SEES the size: real cues resize immediately and a sample line renders
     * whenever no cue is on screen.
     * @private
     */
    beginPreview() {
        this.player.setSubtitleAppearancePreview({
            textSize: this.currentMultiplier(),
            sampleText: this.translate('SubtitleSizePreviewSample')
        });
    }

    /**
     * Persist the chosen size. Read-fresh-merge of textSize only, so this
     * write can never clobber other appearance fields saved elsewhere.
     * @private
     */
    persist() {
        const appearanceSettings = this.settings.getSubtitleAppearanceSettings();
        this.settings.setSubtitleAppearanceSettings({
            ...appearanceSettings,
            textSize: this.currentMultiplier()
        });
    }

    /**
     * Show the slider or, when the current rendering path cannot be resized
     * client-side, a message naming why. Re-run on every render-path change
     * so a burn-in determination that lands while the overlay is open
     * surfaces its explanation at the moment of truth.
     * @private
     */
    applyCapability() {
        const info = this.player.getSubtitleRenderingInfo();
        let messageText = null;

        if (!info.canAdjustSize) {
            if (info.path === 'burned') {
                messageText = this.translate('SubtitleSizeUnavailableBurnedIn');
            } else if (info.path === 'ass' || info.path === 'pgs') {
                messageText = this.translate('SubtitleSizeUnavailableSelfStyled');
            } else {
                messageText = this.translate('SubtitleSizeUnavailableNativeStyling');
            }
        }

        this.message.textContent = messageText || '';
        this.message.classList.toggle('hide', !messageText);
        this.sliderContainer.classList.toggle('hide', !!messageText);
        this.valueLabel.classList.toggle('hide', !!messageText);
    }

    /**
     * Tear down the overlay: end the preview on the player it was opened
     * with and remove the DOM. Idempotent.
     * @returns {void}
     */
    destroy() {
        if (!this.element) {
            return;
        }

        Events.off(this.player, 'subtitlerenderpathchange', this.onRenderPathChange);
        this.slider.removeEventListener('input', this.onSliderInput);
        this.slider.removeEventListener('change', this.onSliderChange);
        this.player.clearSubtitleAppearancePreview();
        this.element.remove();
        this.element = null;
    }
}
