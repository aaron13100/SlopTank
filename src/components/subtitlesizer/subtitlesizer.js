/**
 * In-player subtitle appearance overlay. Size and vertical position are
 * adjusted with live sliders; font family and weight are adjusted with
 * selects. Every change flows through the player's appearance-preview API
 * so a real cue, or a sample line when no cue is active, visibly updates
 * before the setting is persisted.
 * @module components/subtitlesizer/subtitlesizer
 */

import {
    getTextSizeMultiplier,
    VERTICAL_POSITION_BOTTOM,
    VERTICAL_POSITION_DEFAULT,
    VERTICAL_POSITION_STEP,
    VERTICAL_POSITION_TOP
} from '../subtitlesettings/subtitleappearancehelper';
import Events from '../../utils/events.ts';
import '../../elements/emby-slider/emby-slider';
import '../../elements/emby-select/emby-select';
import layoutManager from '../layoutManager';
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
     * @param {Function} [options.onInteract] - Called on every adjustment, so
     * the host can keep its controls awake while the user is working.
     * @param {Function} [options.onClose] - Called once the overlay has torn
     * itself down, so the owner never holds a reference to a dead overlay.
     */
    constructor(options) {
        this.player = options.player;
        this.settings = options.settings;
        this.translate = options.translate;
        this.onInteract = options.onInteract;
        this.onClose = options.onClose;

        // The local HTML player exposes its video container as the host. It
        // moves into Document PiP with the video and subtitle layer, allowing
        // this panel to follow it. Remote/test players fall back to the body.
        const host = this.player.getSubtitleAppearanceOverlayHost?.() || document.body;
        this.ownerDocument = host.ownerDocument || document;
        const parent = this.ownerDocument.createElement('div');
        host.appendChild(parent);
        parent.innerHTML = this.renderTemplate();
        this.element = parent;

        this.slider = parent.querySelector('.subtitleSizerSlider');
        this.positionSlider = parent.querySelector('.subtitlePositionSlider');
        this.fontSelect = parent.querySelector('.subtitleFontSelect');
        this.weightSelect = parent.querySelector('.subtitleWeightSelect');
        this.valueLabel = parent.querySelector('.subtitleSizerValue');
        this.positionValueLabel = parent.querySelector('.subtitlePositionValue');
        this.message = parent.querySelector('.subtitleSizerMessage');
        this.controls = parent.querySelector('.subtitleSizerControls');

        if (layoutManager.tv) {
            [ this.slider, this.positionSlider, this.fontSelect, this.weightSelect ]
                .forEach(control => {
                    control.classList.add('focusable');
                });
            // Defer until the registered element attaches in Firefox.
            setTimeout(() => {
                this.slider.enableKeyboardDragging?.();
                this.positionSlider.enableKeyboardDragging?.();
            }, 0);
        }

        const appearanceSettings = this.settings.getSubtitleAppearanceSettings();
        const initialMultiplier = getTextSizeMultiplier(
            appearanceSettings.textSize);
        this.slider.value = String(Math.round(initialMultiplier * 100));
        this.positionSlider.min = String(VERTICAL_POSITION_TOP);
        this.positionSlider.max = String(VERTICAL_POSITION_BOTTOM);
        this.positionSlider.step = String(VERTICAL_POSITION_STEP);
        this.positionSlider.value = String(
            appearanceSettings.verticalPosition ?? VERTICAL_POSITION_DEFAULT);
        this.fontSelect.value = appearanceSettings.font || '';
        this.weightSelect.value = appearanceSettings.textWeight || 'normal';
        this.updateValueLabel();
        this.updatePositionValueLabel();

        this.slider.getBubbleHtml = (_, value) =>
            `<h1 class="sliderBubbleText">${Math.round(value)}%</h1>`;
        this.positionSlider.getBubbleHtml = (_, value) =>
            `<h1 class="sliderBubbleText">${this.formatPosition(value)}</h1>`;

        this.slider.addEventListener('input', this.onSliderInput);
        this.slider.addEventListener('change', this.onSliderChange);
        this.positionSlider.addEventListener('input', this.onPositionInput);
        this.positionSlider.addEventListener('change', this.onPositionChange);
        this.fontSelect.addEventListener('change', this.onAppearanceSelectChange);
        this.weightSelect.addEventListener('change', this.onAppearanceSelectChange);
        parent.querySelector('.subtitleSizer-closeButton')
            .addEventListener('click', this.onCloseClick);
        // Capture phase: dismissing this overlay is what Escape means while it
        // is open, so the key must not also reach the player's own handler.
        this.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
        Events.on(this.player, 'subtitlerenderpathchange', this.onRenderPathChange);

        this.applyCapability();
        this.beginPreview();
    }

    renderTemplate() {
        const translations = {
            Close: 'ButtonClose',
            Title: 'HeaderSubtitleAppearance',
            TextSize: 'LabelTextSize',
            VerticalPosition: 'LabelSubtitleVerticalPosition',
            Font: 'LabelFont',
            TextWeight: 'LabelTextWeight',
            Default: 'Default',
            Typewriter: 'Typewriter',
            Print: 'Print',
            Console: 'Console',
            Cursive: 'Cursive',
            Casual: 'Casual',
            SmallCaps: 'SmallCaps',
            Normal: 'Normal',
            Bold: 'Bold'
        };

        return Object.entries(translations).reduce(
            (html, [ token, key ]) => html.split(`\${${token}}`).join(this.translate(key)),
            template
        );
    }

    onSliderInput = () => {
        this.updateValueLabel();
        this.beginPreview();
        this.onInteract?.();
    };

    onSliderChange = () => {
        this.updateValueLabel();
        this.beginPreview();
        this.persist();
        this.onInteract?.();
    };

    onPositionInput = () => {
        this.updatePositionValueLabel();
        this.beginPreview();
        this.onInteract?.();
    };

    onPositionChange = () => {
        this.updatePositionValueLabel();
        this.beginPreview();
        this.persist({ verticalPosition: this.positionSlider.value });
        this.onInteract?.();
    };

    onAppearanceSelectChange = event => {
        this.beginPreview();
        const field = event.target === this.fontSelect ? 'font' : 'textWeight';
        this.persist({ [field]: event.target.value });
        this.onInteract?.();
    };

    onCloseClick = () => {
        this.destroy();
    };

    onKeyDown = event => {
        if (event.key !== 'Escape' && event.key !== 'Back') {
            return;
        }

        event.stopPropagation();
        event.preventDefault();
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

    updatePositionValueLabel() {
        this.positionValueLabel.textContent = this.formatPosition(
            this.positionSlider.value);
    }

    formatPosition(value) {
        return String(Math.round(Number(value) * 100) / 100);
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
            verticalPosition: this.positionSlider.value,
            font: this.fontSelect.value,
            textWeight: this.weightSelect.value,
            sampleText: this.translate('SubtitleSizePreviewSample')
        });
    }

    /**
     * Persist the chosen size. Read-fresh-merge of textSize only, so this
     * write can never clobber other appearance fields saved elsewhere.
     * @private
     */
    persist(changes = { textSize: this.currentMultiplier() }) {
        const appearanceSettings = this.settings.getSubtitleAppearanceSettings();
        this.settings.setSubtitleAppearanceSettings({
            ...appearanceSettings,
            ...changes
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
            } else if (info.path === 'pgs') {
                messageText = this.translate('SubtitleSizeUnavailableSelfStyled');
            } else {
                messageText = this.translate('SubtitleSizeUnavailableNativeStyling');
            }
        }

        this.message.textContent = messageText || '';
        this.message.classList.toggle('hide', !messageText);
        this.controls.classList.toggle('hide', !!messageText);
    }

    /**
     * Tear down the overlay: end the preview on the player it was opened
     * with, remove the DOM, and tell the owner it is gone (the overlay can
     * close itself, so the owner cannot infer this). Idempotent.
     * @returns {void}
     */
    destroy() {
        if (!this.element) {
            return;
        }

        Events.off(this.player, 'subtitlerenderpathchange', this.onRenderPathChange);
        this.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
        this.slider.removeEventListener('input', this.onSliderInput);
        this.slider.removeEventListener('change', this.onSliderChange);
        this.positionSlider.removeEventListener('input', this.onPositionInput);
        this.positionSlider.removeEventListener('change', this.onPositionChange);
        this.fontSelect.removeEventListener('change', this.onAppearanceSelectChange);
        this.weightSelect.removeEventListener('change', this.onAppearanceSelectChange);
        this.player.clearSubtitleAppearancePreview();
        this.element.remove();
        this.element = null;
        this.onClose?.();
    }
}
