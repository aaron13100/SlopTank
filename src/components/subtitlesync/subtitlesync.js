// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-09-09.
/**
 * In-player subtitle timing (offset) overlay. Instance-scoped: the player and
 * DOM references live on the instance, so destroying an older overlay can
 * never reset the offset on whichever player a shared module global happened
 * to point at.
 * @module components/subtitlesync/subtitlesync
 */

import { playbackManager } from '../playback/playbackmanager';
import layoutManager from '../layoutManager';
import template from './subtitlesync.template.html';
import './subtitlesync.scss';

class SubtitleSync {
    /**
     * @param {Object} currentPlayer - Player whose subtitle offset this overlay controls.
     */
    constructor(currentPlayer) {
        this.player = currentPlayer;
        this.init();
    }

    /**
     * Build the overlay DOM and wire its slider/text field.
     * @private
     */
    init() {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        parent.innerHTML = template;

        this.subtitleSyncSlider = parent.querySelector('.subtitleSyncSlider');
        this.subtitleSyncTextField = parent.querySelector('.subtitleSyncTextField');
        this.subtitleSyncCloseButton = parent.querySelector('.subtitleSync-closeButton');
        this.subtitleSyncContainer = parent.querySelector('.subtitleSyncContainer');
        const instance = this;

        if (layoutManager.tv) {
            this.subtitleSyncSlider.classList.add('focusable');
            // HACK: Delay to give time for registered element attach (Firefox)
            setTimeout(() => {
                this.subtitleSyncSlider.enableKeyboardDragging();
            }, 0);
        }

        this.subtitleSyncContainer.classList.add('hide');

        this.subtitleSyncTextField.updateOffset = function (offset) {
            this.textContent = offset + 's';
        };

        this.subtitleSyncTextField.addEventListener('click', function () {
            // keep focus to prevent fade with osd
            this.hasFocus = true;
        });

        this.subtitleSyncTextField.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                // if input key is enter search for float pattern
                let inputOffset = /[-+]?\d+\.?\d*/g.exec(this.textContent);
                if (inputOffset) {
                    inputOffset = inputOffset[0];
                    inputOffset = parseFloat(inputOffset);

                    instance.subtitleSyncSlider.updateOffset(inputOffset);
                } else {
                    this.textContent = (playbackManager.getPlayerSubtitleOffset(instance.player) || 0) + 's';
                }
                this.hasFocus = false;
                event.preventDefault();
            } else {
                // keep focus to prevent fade with osd
                this.hasFocus = true;
                if (event.key.match(/[+-\d.s]/) === null) {
                    event.preventDefault();
                }
            }

            // FIXME: TV layout will require special handling for navigation keys. But now field is not focusable
            event.stopPropagation();
        });

        this.subtitleSyncTextField.blur = function () {
            // prevent textfield to blur while element has focus
            if (!this.hasFocus && this.prototype) {
                this.prototype.blur();
            }
        };

        function updateSubtitleOffset() {
            const value = parseFloat(instance.subtitleSyncSlider.value);
            // set new offset
            playbackManager.setSubtitleOffset(value, instance.player);
            // synchronize with textField value
            instance.subtitleSyncTextField.updateOffset(value);
        }

        this.subtitleSyncSlider.updateOffset = function (sliderValue) {
            // default value is 0s = 0ms
            this.value = sliderValue === undefined ? 0 : sliderValue;

            updateSubtitleOffset();
        };

        this.subtitleSyncSlider.addEventListener('change', () => updateSubtitleOffset());

        this.subtitleSyncSlider.getBubbleHtml = function (_, value) {
            return '<h1 class="sliderBubbleText">'
                + (value > 0 ? '+' : '') + parseFloat(value) + 's'
                + '</h1>';
        };

        this.subtitleSyncCloseButton.addEventListener('click', () => {
            playbackManager.disableShowingSubtitleOffset(this.player);
            this.toggle('forceToHide');
        });

        this.element = parent;
    }

    destroy() {
        this.toggle('forceToHide');
        if (this.player) {
            playbackManager.disableShowingSubtitleOffset(this.player);
            playbackManager.setSubtitleOffset(0, this.player);
        }
        const elem = this.element;
        if (elem) {
            elem.parentNode.removeChild(elem);
            this.element = null;
        }
    }

    toggle(action) {
        if (action && !['hide', 'forceToHide'].includes(action)) {
            console.warn('SubtitleSync.toggle called with invalid action', action);
            return;
        }

        const player = this.player;
        if (player && playbackManager.supportSubtitleOffset(player)) {
            if (!action) {
                // if showing subtitle sync is enabled and if there is an external subtitle stream enabled
                if (playbackManager.isShowingSubtitleOffsetEnabled(player) && playbackManager.canHandleOffsetOnCurrentSubtitle(player)) {
                    // if no subtitle offset is defined or element has focus (offset being defined)
                    if (!(playbackManager.getPlayerSubtitleOffset(player) || this.subtitleSyncTextField.hasFocus)) {
                        // set default offset to '0' = 0ms
                        this.subtitleSyncSlider.value = '0';
                        this.subtitleSyncTextField.textContent = '0s';
                        playbackManager.setSubtitleOffset(0, player);
                    }
                    // show subtitle sync
                    this.subtitleSyncContainer.classList.remove('hide');
                    return;
                }
            } else if (action === 'hide' && this.subtitleSyncTextField.hasFocus) {
                // do not hide if element has focus
                return;
            }

            this.subtitleSyncContainer.classList.add('hide');
        }
    }

    update(offset) {
        this.toggle();

        const value = parseFloat(this.subtitleSyncSlider.value) + offset;
        this.subtitleSyncSlider.updateOffset(value);
    }

    incrementOffset() {
        this.update(+this.subtitleSyncSlider.step);
    }

    decrementOffset() {
        this.update(-this.subtitleSyncSlider.step);
    }
}

export default SubtitleSync;
