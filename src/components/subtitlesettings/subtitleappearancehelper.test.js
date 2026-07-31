import { describe, expect, it } from 'vitest';

import {
    getAssSubtitleBottomPercentage,
    getAssSubtitleVerticalOffsetPercentage,
    getSecondarySubtitleOffset,
    getStyles,
    getSubtitleFontSize,
    getSubtitleVerticalPosition
} from './subtitleappearancehelper';

function getFontSize(textSize) {
    return getStyles({ textSize }, false).text.find(style => style.name === 'font-size')?.value;
}

describe('subtitle appearance sizing', () => {
    // @covers subtitle_controls.appearance_sizing.proportional_default
    it('uses the proportional video size as the comfortable 100% default', () => {
        expect(getFontSize('medium')).toBe('calc(var(--subtitle-font-size, 1em) * 1)');
        expect(getFontSize('')).toBe('calc(var(--subtitle-font-size, 1em) * 1)');
    });

    // @covers subtitle_controls.appearance_sizing.preset_multiplier_map
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

    // @covers subtitle_controls.appearance_sizing.numeric_multiplier_parse
    it.each([
        [ '0.25', 0.25 ],
        [ '0.6', 0.6 ],
        [ '1', 1 ],
        [ '1.35', 1.35 ],
        [ '2', 2 ],
        [ 1.5, 1.5 ]
    ])('parses the persisted numeric multiplier %s directly', (textSize, multiplier) => {
        expect(getFontSize(textSize)).toBe(`calc(var(--subtitle-font-size, 1em) * ${multiplier})`);
    });

    // @covers subtitle_controls.appearance_sizing.out_of_range_multiplier_clamped
    it.each([
        [ '0.1', 0.25 ],
        [ '0', 0.25 ],
        [ '-1', 0.25 ],
        [ '3.5', 2 ],
        [ '250', 2 ]
    ])('clamps the out-of-range numeric multiplier %s into 25%%-200%%', (textSize, multiplier) => {
        expect(getFontSize(textSize)).toBe(`calc(var(--subtitle-font-size, 1em) * ${multiplier})`);
    });

    // @covers subtitle_controls.appearance_sizing.non_finite_value_falls_back
    it.each([ 'NaN', 'Infinity', '-Infinity', '1.2.3px' ])(
        'fails a non-finite numeric-looking value (%s) safe to 100%%',
        textSize => {
            expect(getFontSize(textSize)).toBe('calc(var(--subtitle-font-size, 1em) * 1)');
        }
    );

    // @covers subtitle_controls.appearance_sizing.video_height_proportional_size
    it.each([
        [ 360, 16.2 ],
        [ 720, 32.4 ],
        [ 1080, 48.6 ]
    ])('sizes a %spx-tall video at 4.5%% of picture height', (videoHeight, expectedFontSize) => {
        expect(getSubtitleFontSize(videoHeight)).toBe(expectedFontSize);
    });

    // @covers subtitle_controls.appearance_sizing.native_cue_uses_concrete_size
    it('resolves a concrete pixel size for native cue compositors', () => {
        const fontSize = getStyles({ textSize: '1.5' }, false, 32.4).text
            .find(style => style.name === 'font-size')?.value;

        // CSS custom properties inside ::cue are not resolved by every
        // browser caption compositor, even when ordinary DOM previews support
        // them. The native path must receive the final value directly.
        expect(fontSize).toBe('48.6px');
    });

    // @covers subtitle_controls.appearance_sizing.unusable_video_height_rejected
    it.each([ 0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '720' ])(
        'rejects an unusable observed video height (%s)',
        videoHeight => {
            expect(getSubtitleFontSize(videoHeight)).toBeNull();
        }
    );
});

function getWindowStyle(settings, name) {
    return getStyles(settings, false).window.find(style => style.name === name)?.value;
}

describe('subtitle vertical position', () => {
    // @covers subtitle_controls.appearance_sizing.position_independent_of_text_size
    it.each([ '0.25', '1', '2' ])(
        'keeps the visible placement identical at text size %s',
        textSize => {
            expect(getWindowStyle(
                { textSize, verticalPosition: -12 },
                'top'
            )).toBe('47%');
            expect(getWindowStyle(
                { textSize, verticalPosition: -12 },
                'transform'
            )).toBe('translateY(-75%)');
        }
    );

    // @covers subtitle_controls.appearance_sizing.position_anchors_to_chosen_edge
    it('allows half a line above the top and clamps legacy out-of-range values', () => {
        expect(getSubtitleVerticalPosition(-20, '1')).toEqual({
            value: -20,
            fraction: 0,
            percentage: 3.0375,
            centerPercentage: 0
        });
        expect(getSubtitleVerticalPosition(-5, '1')).toEqual({
            value: -5,
            fraction: 0.9375,
            percentage: 88.31484375,
            centerPercentage: 88.125
        });
        expect(getSubtitleVerticalPosition(2, '1')).toEqual({
            value: -5,
            fraction: 0.9375,
            percentage: 88.31484375,
            centerPercentage: 88.125
        });
        expect(getWindowStyle({ verticalPosition: -20 }, 'top')).toBe('0%');
        expect(getWindowStyle({ verticalPosition: -20 }, 'bottom')).toBe('auto');
        expect(getWindowStyle({ verticalPosition: -20 }, 'transform'))
            .toBe('translateY(-50%)');
        expect(getWindowStyle({ verticalPosition: -5 }, 'top')).toBe('88.125%');
        expect(getWindowStyle({ verticalPosition: -5 }, 'bottom')).toBe('auto');
        expect(getWindowStyle({ verticalPosition: -5 }, 'transform'))
            .toBe('translateY(-96.875%)');
    });

    it('keeps half a line visible at the top for every text size', () => {
        expect(getSubtitleVerticalPosition(-20, '0.25').percentage)
            .toBe(0.759375);
        expect(getSubtitleVerticalPosition(-20, '1').percentage)
            .toBe(3.0375);
        expect(getSubtitleVerticalPosition(-20, '2').percentage)
            .toBe(6.075);
    });

    it('keeps ASS translation anchored to the authored baseline', () => {
        expect(getAssSubtitleVerticalOffsetPercentage(-20, '1'))
            .toBe(-90.9625);
        expect(getAssSubtitleVerticalOffsetPercentage(-5, '1'))
            .toBeCloseTo(-5.68515625, 12);
        expect(getAssSubtitleVerticalOffsetPercentage('not-a-position', '1'))
            .toBeCloseTo(-5.68515625, 12);
    });
});

describe('ASS subtitle preview position', () => {
    const header = `[Script Info]
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Sign,Arial,48,0,0,8,15,15,20
Style: Dialogue,Arial,48,2,0,2,15,15,15

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    it('uses ordinary authored dialogue instead of a positioned sign', () => {
        const content = `${header}Dialogue: 0,0:00:00.00,0:00:05.00,Sign,,0,0,0,,{\\pos(640,80)}Title
Dialogue: 0,0:00:05.00,0:00:10.00,Dialogue,,0,0,0,,Spoken line`;

        expect(getAssSubtitleBottomPercentage(content)).toBeCloseTo(
            100 - 17 * 100 / 720
        );
    });

    it('honors a dialogue event margin override', () => {
        const content = `${header}Dialogue: 0,0:00:00.00,0:00:05.00,Dialogue,,0,0,40,,Spoken line`;

        expect(getAssSubtitleBottomPercentage(content)).toBeCloseTo(
            100 - 42 * 100 / 720
        );
    });

    it.each([ '', 'not ass', '[Script Info]\\nPlayResY: 0' ])(
        'rejects content without a usable bottom dialogue style (%s)',
        content => {
            expect(getAssSubtitleBottomPercentage(content)).toBeNull();
        }
    );
});

describe('secondary subtitle separation', () => {
    const viewport = { top: 0, bottom: 720 };

    // @covers subtitle_controls.track_menu.ass_authored_layout_live_appearance_secondary_and_offset
    it('moves an overlapping bottom cue into a separate lane above the primary', () => {
        expect(getSecondarySubtitleOffset(
            { top: 620, right: 900, bottom: 680, left: 300 },
            { top: 620, right: 900, bottom: 680, left: 300 },
            viewport,
            10
        )).toBe(-70);
    });

    // @covers subtitle_controls.track_menu.ass_authored_layout_live_appearance_secondary_and_offset
    it('moves down when an authored top cue has no room above', () => {
        expect(getSecondarySubtitleOffset(
            { top: 20, right: 900, bottom: 80, left: 300 },
            { top: 20, right: 900, bottom: 80, left: 300 },
            viewport,
            10
        )).toBe(70);
    });

    // @covers subtitle_controls.track_menu.ass_authored_layout_live_appearance_secondary_and_offset
    it('does not disturb cues that already occupy separate regions', () => {
        expect(getSecondarySubtitleOffset(
            { top: 620, right: 900, bottom: 680, left: 300 },
            { top: 20, right: 900, bottom: 80, left: 300 },
            viewport,
            10
        )).toBe(0);
    });
});
