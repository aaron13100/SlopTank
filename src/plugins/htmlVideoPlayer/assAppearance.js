// SlopTank modification notice: added by SlopTank on 2026-10-01 (c303), extracted from plugin.js.
/**
 * ASS/SSA typography overrides for the libass renderer: the user's font,
 * weight and text-size scale applied to an authored document while every
 * positioning, animation, colour, drawing and timing command passes through.
 * Extracted from the HTML video player plugin so that a transient size boost
 * (Document Picture-in-Picture) is a parameter of one pure function.
 * @module plugins/htmlVideoPlayer/assAppearance
 */
import caveatFontUrl from '@fontsource/caveat/files/caveat-latin-400-normal.woff2';
import caveatBoldFontUrl from '@fontsource/caveat/files/caveat-latin-700-normal.woff2';
import cinzelFontUrl from '@fontsource/cinzel/files/cinzel-latin-400-normal.woff2';
import cinzelBoldFontUrl from '@fontsource/cinzel/files/cinzel-latin-700-normal.woff2';
import comicNeueFontUrl from '@fontsource/comic-neue/files/comic-neue-latin-400-normal.woff2';
import comicNeueBoldFontUrl from '@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff2';
import courierPrimeFontUrl from '@fontsource/courier-prime/files/courier-prime-latin-400-normal.woff2';
import courierPrimeBoldFontUrl from '@fontsource/courier-prime/files/courier-prime-latin-700-normal.woff2';
import notoSerifFontUrl from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2';
import notoSerifBoldFontUrl from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff2';
import robotoMonoFontUrl from '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff2';
import robotoMonoBoldFontUrl from '@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff2';

import * as subtitleAppearanceHelper from 'components/subtitlesettings/subtitleappearancehelper';

const ASS_FONT_FAMILIES = {
    typewriter: 'Courier Prime',
    print: 'Noto Serif',
    console: 'Roboto Mono',
    cursive: 'Caveat',
    casual: 'Comic Neue',
    smallcaps: 'Cinzel'
};

export const ASS_USER_FONT_URLS = [
    caveatFontUrl,
    caveatBoldFontUrl,
    cinzelFontUrl,
    cinzelBoldFontUrl,
    comicNeueFontUrl,
    comicNeueBoldFontUrl,
    courierPrimeFontUrl,
    courierPrimeBoldFontUrl,
    notoSerifFontUrl,
    notoSerifBoldFontUrl,
    robotoMonoFontUrl,
    robotoMonoBoldFontUrl
];

/**
 * Apply user text overrides to an ASS event without touching any positioning,
 * animation, colour, or drawing commands. Inline font-size commands are
 * scaled from their authored value; explicit font/weight commands are
 * replaced by the user's current typography choices.
 * @param {string} text - Authored ASS event text.
 * @param {Object} appearance - Effective subtitle appearance.
 * @param {number} scaleBoost - Transient size factor (Document PiP) that
 * multiplies the user's scale without being part of the preference.
 * @returns {string} Event text with appearance overrides applied.
 */
function getAssEventTextWithAppearance(text, appearance, scaleBoost) {
    const multiplier = subtitleAppearanceHelper.getTextSizeMultiplier(appearance.textSize) * scaleBoost;
    let result = text.replace(/\\fs(\d+(?:\.\d+)?)/gi, (match, value) =>
        `\\fs${Math.round(Number(value) * multiplier * 100) / 100}`);
    const fontName = ASS_FONT_FAMILIES[appearance.font];
    const bold = appearance.textWeight === 'bold' ? 1 : 0;

    if (fontName) {
        result = result.replace(/\\fn[^\\}]*/gi, `\\fn${fontName}`);
    }
    result = result.replace(/\\b-?\d+/gi, `\\b${bold}`);

    const overrides = [
        fontName ? `\\fn${fontName}` : '',
        `\\b${bold}`
    ].join('');
    return `{${overrides}}${result}`;
}

function splitAssFields(value, fieldCount) {
    const fields = [];
    let remainder = value;
    for (let index = 1; index < fieldCount; index++) {
        const separator = remainder.indexOf(',');
        if (separator === -1) {
            return null;
        }
        fields.push(remainder.slice(0, separator));
        remainder = remainder.slice(separator + 1);
    }
    fields.push(remainder);
    return fields;
}

/**
 * Override only ASS typography while retaining the complete authored
 * composition. Style alignments/margins and event-level positioning,
 * animations, colours, drawings, and timing pass through byte-for-byte.
 * @param {string} content - Authored ASS/SSA document.
 * @param {Object} appearance - Effective subtitle appearance.
 * @param {number} [scaleBoost=1] - Transient size factor (Document PiP) that
 * multiplies the user's scale without being part of the preference.
 * @returns {string} ASS/SSA document ready for libass.
 */
export function getAssContentWithAppearance(content, appearance, scaleBoost = 1) {
    const multiplier = subtitleAppearanceHelper.getTextSizeMultiplier(appearance.textSize) * scaleBoost;
    const fontName = ASS_FONT_FAMILIES[appearance.font];
    const bold = appearance.textWeight === 'bold' ? '-1' : '0';
    let section = '';
    let format = [];

    return content.split(/\r?\n/).map(line => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
            section = trimmedLine.slice(1, -1).toLowerCase();
            format = [];
            return line;
        }

        const colonIndex = line.indexOf(':');
        const lineKey = colonIndex === -1 ?
            '' :
            line.slice(0, colonIndex).trim().toLowerCase();
        const lineValue = colonIndex === -1 ?
            '' :
            line.slice(colonIndex + 1).trimStart();

        if (lineKey === 'format') {
            format = lineValue.split(',').map(field => field.trim().toLowerCase());
            return line;
        }

        if ((section === 'v4+ styles' || section === 'v4 styles') && lineKey === 'style' && format.length) {
            const fields = splitAssFields(lineValue, format.length);
            if (!fields) {
                return line;
            }
            const fontSizeIndex = format.indexOf('fontsize');
            const fontNameIndex = format.indexOf('fontname');
            const boldIndex = format.indexOf('bold');
            if (fontSizeIndex !== -1) {
                const authoredSize = Number(fields[fontSizeIndex]);
                if (Number.isFinite(authoredSize)) {
                    fields[fontSizeIndex] = String(
                        Math.round(authoredSize * multiplier * 100) / 100
                    );
                }
            }
            if (fontName && fontNameIndex !== -1) {
                fields[fontNameIndex] = fontName;
            }
            if (boldIndex !== -1) {
                fields[boldIndex] = bold;
            }
            return `${line.slice(0, colonIndex + 1)} ${fields.join(',')}`;
        }

        if (section === 'events' && lineKey === 'dialogue' && format.length) {
            const fields = splitAssFields(lineValue, format.length);
            const textIndex = format.indexOf('text');
            if (!fields || textIndex === -1) {
                return line;
            }
            fields[textIndex] = getAssEventTextWithAppearance(fields[textIndex], appearance, scaleBoost);
            return `${line.slice(0, colonIndex + 1)} ${fields.join(',')}`;
        }

        return line;
    }).join('\n');
}
