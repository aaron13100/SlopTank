/**
 * Subtitle settings visual helper.
 * @module components/subtitleSettings/subtitleAppearanceHelper
 */

const SUBTITLE_HEIGHT_RATIO = 0.045;

export const TEXT_SIZE_MIN_MULTIPLIER = 0.25;
export const TEXT_SIZE_MAX_MULTIPLIER = 2;

/**
 * Resolve a persisted subtitle text-size choice to a multiplier around the
 * proportional video-height baseline. The persisted value is either a numeric
 * multiplier (the current write format, clamped to [0.25, 2]) or one of the
 * legacy named presets, which keep parsing forever. Unknown values fail safe
 * to 100%.
 * @param {string|number} textSize - Persisted subtitle text-size value.
 * @returns {number} Multiplier applied to the proportional baseline.
 */
export function getTextSizeMultiplier(textSize) {
    // Number() rejects trailing garbage that parseFloat would prefix-parse;
    // the empty string (legacy 100% default) must skip numeric parsing
    // because Number('') is 0.
    const isNonEmptyString = typeof textSize === 'string' && textSize.trim() !== '';
    let numeric = NaN;
    if (typeof textSize === 'number') {
        numeric = textSize;
    } else if (isNonEmptyString) {
        numeric = Number(textSize);
    }
    if (Number.isFinite(numeric)) {
        return Math.min(TEXT_SIZE_MAX_MULTIPLIER, Math.max(TEXT_SIZE_MIN_MULTIPLIER, numeric));
    }

    switch (textSize || '') {
        case 'smaller':
        case 'small':
            return 0.75;
        case 'large':
            return 1.25;
        case 'larger':
            return 1.5;
        case 'extralarge':
            return 2;
        case 'medium':
        default:
            return 1;
    }
}

/**
 * Calculate the comfortable subtitle baseline from rendered video height.
 * Invalid observations return null so callers retain the last valid size.
 * @param {number} videoHeight - Rendered video height in CSS pixels.
 * @returns {number|null} Subtitle font size in CSS pixels.
 */
export function getSubtitleFontSize(videoHeight) {
    if (typeof videoHeight !== 'number' || !Number.isFinite(videoHeight) || videoHeight <= 0) {
        return null;
    }

    return Math.round(videoHeight * SUBTITLE_HEIGHT_RATIO * 100) / 100;
}

function getTextStyles(settings, preview) {
    const list = [];
    const textSizeMultiplier = getTextSizeMultiplier(settings.textSize);
    list.push({
        name: 'font-size',
        value: `calc(var(--subtitle-font-size, 1em) * ${textSizeMultiplier})`
    });

    switch (settings.textWeight || '') {
        case 'bold':
            list.push({ name: 'font-weight', value: 'bold' });
            break;
        case 'normal':
        default:
            list.push({ name: 'font-weight', value: 'normal' });
            break;
    }

    switch (settings.dropShadow || '') {
        case 'raised':
            list.push({ name: 'text-shadow', value: '-0.04em -0.04em #fff, 0px -0.04em #fff, -0.04em 0px #fff, 0.04em 0.04em #000, 0px 0.04em #000, 0.04em 0px #000' });
            break;
        case 'depressed':
            list.push({ name: 'text-shadow', value: '0.04em 0.04em #fff, 0px 0.04em #fff, 0.04em 0px #fff, -0.04em -0.04em #000, 0px -0.04em #000, -0.04em 0px #000' });
            break;
        case 'uniform':
            list.push({ name: 'text-shadow', value: '#000 0px 0.03em, #000 0px -0.03em, #000 0px 0.05em, #000 0px -0.05em, #000 0.03em 0px, #000 -0.03em 0px, #000 0.03em 0.03em, #000 -0.03em 0.03em, #000 0.03em -0.03em, #000 -0.03em -0.03em, #000 0.03em 0.05em, #000 -0.03em 0.05em, #000 0.03em -0.05em, #000 -0.03em -0.05em, #000 0.05em 0px, #000 -0.05em 0px, #000 0.05em 0.03em, #000 -0.05em 0.03em, #000 0.05em -0.03em, #000 -0.05em -0.03em' });
            break;
        case 'none':
            list.push({ name: 'text-shadow', value: 'none' });
            break;
        case 'dropshadow':
        default:
            list.push({ name: 'text-shadow', value: '#000000 0px 0px 7px' });
            break;
    }

    const background = settings.textBackground || 'transparent';
    if (background) {
        list.push({ name: 'background-color', value: background });
    }

    const textColor = settings.textColor || '#ffffff';
    if (textColor) {
        list.push({ name: 'color', value: textColor });
    }

    switch (settings.font || '') {
        case 'typewriter':
            list.push({ name: 'font-family', value: '"Courier New",monospace' });
            list.push({ name: 'font-variant', value: 'none' });
            break;
        case 'print':
            list.push({ name: 'font-family', value: 'Georgia,Times New Roman,Arial,Helvetica,serif' });
            list.push({ name: 'font-variant', value: 'none' });
            break;
        case 'console':
            list.push({ name: 'font-family', value: 'Consolas,Lucida Console,Menlo,Monaco,monospace' });
            list.push({ name: 'font-variant', value: 'none' });
            break;
        case 'cursive':
            list.push({ name: 'font-family', value: 'Lucida Handwriting,Brush Script MT,Segoe Script,cursive,Quintessential,system-ui,-apple-system,BlinkMacSystemFont,sans-serif' });
            list.push({ name: 'font-variant', value: 'none' });
            break;
        case 'casual':
            list.push({ name: 'font-family', value: 'Gabriola,Segoe Print,Comic Sans MS,Chalkboard,Short Stack,system-ui,-apple-system,BlinkMacSystemFont,sans-serif' });
            list.push({ name: 'font-variant', value: 'none' });
            break;
        case 'smallcaps':
            list.push({ name: 'font-family', value: 'Copperplate Gothic,Copperplate Gothic Bold,Copperplate,system-ui,-apple-system,BlinkMacSystemFont,sans-serif' });
            list.push({ name: 'font-variant', value: 'small-caps' });
            break;
        default:
            list.push({ name: 'font-family', value: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif,Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol' });
            list.push({ name: 'font-variant', value: 'none' });
            break;
    }

    if (!preview) {
        const pos = parseInt(settings.verticalPosition, 10);
        // Keep this in sync with the subtitle element's effective line height.
        const lineHeight = 1.35;
        // Distance from the anchored edge, measured in baseline lines against
        // the SAME proportional baseline the font-size is built on -- never in
        // `em`. `em` is the element's own font-size, which textSizeMultiplier
        // scales, so an em offset makes the subtitle slide up the screen as the
        // user enlarges it (out of the letterbox bar when small, into the
        // middle of the picture when large). Position and size are independent
        // axes: this keeps the offset tied to the video's size and nothing else.
        const linesFromEdge = margin => `calc(var(--subtitle-font-size, 1em) * ${margin})`;
        if (pos < 0) {
            const margin = Math.abs(pos + 1) * lineHeight;
            list.push({ name: 'margin-bottom', value: linesFromEdge(margin) });
            list.push({ name: 'margin-top', value: '' });
        } else {
            const margin = pos * lineHeight;
            list.push({ name: 'margin-bottom', value: '' });
            list.push({ name: 'margin-top', value: linesFromEdge(margin) });
        }
    }

    return list;
}

function getWindowStyles(settings, preview) {
    const list = [];

    if (!preview) {
        const pos = parseInt(settings.verticalPosition, 10);
        if (pos < 0) {
            list.push({ name: 'top', value: '' });
            list.push({ name: 'bottom', value: '0' });
        } else {
            list.push({ name: 'top', value: '0' });
            list.push({ name: 'bottom', value: '' });
        }
    }

    return list;
}

export function getStyles(settings, preview) {
    return {
        text: getTextStyles(settings, preview),
        window: getWindowStyles(settings, preview)
    };
}

function applyStyleList(styles, elem) {
    for (let i = 0, length = styles.length; i < length; i++) {
        const style = styles[i];

        elem.style[style.name] = style.value;
    }
}

export function applyStyles(elements, appearanceSettings) {
    const styles = getStyles(appearanceSettings, !!elements.preview);

    if (elements.text) {
        applyStyleList(styles.text, elements.text);
    }
    if (elements.window) {
        applyStyleList(styles.window, elements.window);
    }
}
export default {
    getStyles: getStyles,
    applyStyles: applyStyles,
    getSubtitleFontSize: getSubtitleFontSize,
    getTextSizeMultiplier: getTextSizeMultiplier
};
