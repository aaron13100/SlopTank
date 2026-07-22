import { describe, expect, it } from 'vitest';

import { getStyles, getSubtitleFontSize } from './subtitleappearancehelper';

function getFontSize(textSize) {
    return getStyles({ textSize }, false).text.find(style => style.name === 'font-size')?.value;
}

describe('subtitle appearance sizing', () => {
    it('uses the proportional video size as the comfortable 100% default', () => {
        expect(getFontSize('medium')).toBe('calc(var(--subtitle-font-size, 1em) * 1)');
        expect(getFontSize('')).toBe('calc(var(--subtitle-font-size, 1em) * 1)');
    });

    it.each([
        [ 'smaller', 0.75 ],
        [ 'small', 0.75 ],
        [ 'large', 1.25 ],
        [ 'larger', 1.5 ],
        [ 'extralarge', 2 ],
        [ 'unrecognized-value', 1 ]
    ])('maps the persisted %s preset to a %s multiplier', (textSize, multiplier) => {
        expect(getFontSize(textSize)).toBe(`calc(var(--subtitle-font-size, 1em) * ${multiplier})`);
    });

    it.each([
        [ 360, 16.2 ],
        [ 720, 32.4 ],
        [ 1080, 48.6 ]
    ])('sizes a %spx-tall video at 4.5%% of picture height', (videoHeight, expectedFontSize) => {
        expect(getSubtitleFontSize(videoHeight)).toBe(expectedFontSize);
    });

    it.each([ 0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '720' ])(
        'rejects an unusable observed video height (%s)',
        videoHeight => {
            expect(getSubtitleFontSize(videoHeight)).toBeNull();
        }
    );
});
