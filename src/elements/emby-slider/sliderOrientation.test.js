import { describe, expect, it } from 'vitest';

import {
    getKeyboardStepDirection,
    mapClientToSliderFraction,
    positionSliderBubble,
    setSliderProgress
} from './sliderOrientation';

function createRange(orientation = 'horizontal') {
    return {
        dataset: { sliderOrientation: orientation },
        sliderBubbleTrack: {
            getBoundingClientRect: () => ({ left: 10, right: 110, top: 20, bottom: 220, width: 100, height: 200 })
        }
    };
}

describe('sliderOrientation', () => {
    it('maps vertical pointer positions from bottom zero to top one', () => {
        const range = createRange('vertical');
        expect(mapClientToSliderFraction(range, 60, 220, false)).toBe(0);
        expect(mapClientToSliderFraction(range, 60, 120, false)).toBe(0.5);
        expect(mapClientToSliderFraction(range, 60, 20, false)).toBe(1);
    });

    it('preserves horizontal left-to-right and right-to-left mapping', () => {
        const range = createRange();
        expect(mapClientToSliderFraction(range, 35, 0, false)).toBe(0.25);
        expect(mapClientToSliderFraction(range, 35, 0, true)).toBe(0.75);
    });

    it('uses height and bottom placement only for vertical progress and bubbles', () => {
        const range = createRange('vertical');
        const progress = { style: { width: 'old', height: '' } };
        const bubble = {
            style: { left: 'old', bottom: '' },
            getBoundingClientRect: () => ({ width: 20, height: 20 })
        };

        setSliderProgress(range, progress, 40);
        positionSliderBubble(range, bubble, 50, false);

        expect(progress.style).toEqual({ width: '', height: '40%' });
        expect(bubble.style.left).toBe('');
        expect(bubble.style.bottom).toBe('100px');
    });

    it('maps remote directions along the visible axis without losing left and right', () => {
        const vertical = createRange('vertical');
        const horizontal = createRange();
        expect(getKeyboardStepDirection(vertical, 'ArrowUp')).toBe(1);
        expect(getKeyboardStepDirection(vertical, 'ArrowDown')).toBe(-1);
        expect(getKeyboardStepDirection(vertical, 'ArrowRight')).toBe(1);
        expect(getKeyboardStepDirection(horizontal, 'ArrowLeft')).toBe(-1);
        expect(getKeyboardStepDirection(horizontal, 'ArrowUp')).toBe(0);
    });
});
