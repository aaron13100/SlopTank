// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-09.
/**
 * Geometry policy for horizontal and vertical Emby sliders.
 * @module elements/emby-slider/sliderOrientation
 */

function isVertical(range) {
    return range.dataset.sliderOrientation === 'vertical';
}

/**
 * Resolve the effective numeric step used by pointer and keyboard input.
 * @param {HTMLInputElement} range - Slider element.
 * @param {number|undefined} step - Optional keyboard-specific step.
 * @returns {number} Positive step, defaulting to 1.
 */
export function normalizeSliderStep(range, step) {
    if (step > 0) return step;
    const rangeStep = parseFloat(range.step);
    return rangeStep > 0 ? rangeStep : 1;
}

/**
 * Map a browser pointer coordinate onto a slider track.
 * @param {Object} range - Slider with a bubble-track element.
 * @param {number} clientX - Pointer X-coordinate.
 * @param {number} clientY - Pointer Y-coordinate.
 * @param {boolean} isRtl - Whether horizontal direction is right-to-left.
 * @returns {number} Clamped fraction from 0 through 1.
 */
export function mapClientToSliderFraction(range, clientX, clientY, isRtl) {
    const rect = range.sliderBubbleTrack.getBoundingClientRect();
    let fraction;
    if (isVertical(range)) {
        fraction = (rect.bottom - clientY) / rect.height;
    } else if (isRtl) {
        fraction = (rect.right - clientX) / rect.width;
    } else {
        fraction = (clientX - rect.left) / rect.width;
    }
    const valueRange = range.max - range.min;
    if (range.step !== 'any' && valueRange !== 0 && Number.isFinite(valueRange)) {
        const step = normalizeSliderStep(range) / valueRange;
        fraction = Math.round(fraction / step) * step;
    }
    return Math.min(Math.max(fraction, 0), 1);
}

/**
 * Size the filled track along the slider's visible axis.
 * @param {Object} range - Slider element.
 * @param {HTMLElement} progress - Filled-track element.
 * @param {number} percent - Fill percentage.
 * @returns {void}
 */
export function setSliderProgress(range, progress, percent) {
    if (isVertical(range)) {
        progress.style.height = `${percent}%`;
        progress.style.width = '';
    } else {
        progress.style.width = `${percent}%`;
        progress.style.height = '';
    }
}

/**
 * Position the slider value bubble along its active axis.
 * @param {Object} range - Slider with a bubble-track element.
 * @param {HTMLElement} bubble - Value bubble element.
 * @param {number} percent - Slider percentage.
 * @param {boolean} isRtl - Whether horizontal direction is right-to-left.
 * @returns {void}
 */
export function positionSliderBubble(range, bubble, percent, isRtl) {
    const track = range.sliderBubbleTrack.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    if (isVertical(range)) {
        const position = Math.min(
            Math.max(track.height * percent / 100, bubbleRect.height / 2),
            track.height - bubbleRect.height / 2
        );
        bubble.style.left = '';
        bubble.style.bottom = `${position}px`;
        return;
    }

    let position = track.width * percent / 100;
    if (isRtl) position = track.width - position;
    position = Math.min(Math.max(position, bubbleRect.width / 2), track.width - bubbleRect.width / 2);
    bubble.style.left = `${position}px`;
    bubble.style.bottom = '';
}

/**
 * Resolve a directional key to a slider step direction.
 * @param {Object} range - Slider element.
 * @param {string} key - Normalized keyboard-navigation key.
 * @returns {-1|0|1} Decrease, ignore, or increase.
 */
export function getKeyboardStepDirection(range, key) {
    if ([ 'ArrowLeft', 'Left' ].includes(key)) return -1;
    if ([ 'ArrowRight', 'Right' ].includes(key)) return 1;
    if (isVertical(range) && [ 'ArrowDown', 'Down' ].includes(key)) return -1;
    if (isVertical(range) && [ 'ArrowUp', 'Up' ].includes(key)) return 1;
    return 0;
}

/**
 * Route vertical pointer and touch gestures through the same value policy as
 * keyboard input. Native vertical range direction differs between browsers.
 * @param {HTMLInputElement} range - Vertical range input.
 * @param {Function} fractionToValue - Converts a track fraction to a value.
 * @param {Function} getIsRtl - Reports the element's current text direction.
 * @returns {void}
 */
export function bindVerticalPointerInput(range, fractionToValue, getIsRtl) {
    if (!isVertical(range) || !window.PointerEvent) return;

    const pointerSurface = range.parentNode;

    const update = event => {
        const fraction = mapClientToSliderFraction(
            range,
            event.clientX,
            event.clientY,
            getIsRtl()
        );
        range.value = fractionToValue(range, fraction);
        range.dispatchEvent(new Event('input', { bubbles: true, cancelable: false }));
    };
    const finish = (event, updateFromPointer) => {
        if (!range.verticalPointerActive || event.pointerId !== range.verticalPointerId) return;
        if (updateFromPointer) update(event);
        range.verticalPointerActive = false;
        range.verticalPointerId = undefined;
        pointerSurface.releasePointerCapture?.(event.pointerId);
        range.dispatchEvent(new Event('change', { bubbles: true, cancelable: false }));
        event.preventDefault();
    };

    pointerSurface.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        range.verticalPointerActive = true;
        range.verticalPointerId = event.pointerId;
        range.focus();
        pointerSurface.setPointerCapture?.(event.pointerId);
        update(event);
        event.preventDefault();
    });
    pointerSurface.addEventListener('pointermove', event => {
        if (!range.verticalPointerActive || event.pointerId !== range.verticalPointerId) return;
        update(event);
        event.preventDefault();
    });
    pointerSurface.addEventListener('pointerup', event => finish(event, true));
    pointerSurface.addEventListener('pointercancel', event => finish(event, false));
}
