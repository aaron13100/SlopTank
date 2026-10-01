// SlopTank modification notice: added or changed by SlopTank on 2026-09-30.
/**
 * SubtitleSizer renders the same template into the main document and into a
 * foreign document (the Document Picture-in-Picture popup). The v0
 * custom-element registry only upgrades elements of the main document, so the
 * component must not depend on it for classes or markup in the popup.
 */
import { describe, expect, it } from 'vitest';

import layoutManager from '../layoutManager';
import SubtitleSizer from './subtitlesizer';

function createPlayer(host, calls) {
    return {
        getSubtitleAppearanceOverlayHost: () => host,
        setSubtitleAppearancePreview: preview => calls.push([ 'preview', preview ]),
        clearSubtitleAppearancePreview: () => calls.push([ 'clear' ]),
        getSubtitleRenderingInfo: () => ({ canAdjustSize: true, path: 'dom' })
    };
}

function openInForeignDocument() {
    const foreign = document.implementation.createHTMLDocument('pip');
    const calls = [];
    const sizer = new SubtitleSizer({
        player: createPlayer(foreign.body, calls),
        settings: {
            getSubtitleAppearanceSettings: () => ({}),
            setSubtitleAppearanceSettings: value => calls.push([ 'save', value ])
        },
        translate: key => key
    });
    return { foreign, sizer, calls };
}

describe('SubtitleSizer in a foreign document', () => {
    it('gives the close button its button class without the custom-element callback', () => {
        const { foreign, calls } = openInForeignDocument();
        const close = foreign.querySelector('.subtitleSizer-closeButton');

        expect(close.ownerDocument).toBe(foreign);
        expect(close.classList.contains('paper-icon-button-light')).toBe(true);
        expect(calls[0][0]).toBe('preview');

        close.click();
        expect(calls.at(-1)).toEqual([ 'clear' ]);
        expect(foreign.querySelector('.subtitleSizer')).toBeNull();
    });

    it('upgrades sliders and selects itself', () => {
        const { foreign, sizer } = openInForeignDocument();

        const sliders = foreign.querySelectorAll('input[is="emby-slider"]');
        const selects = foreign.querySelectorAll('select[is="emby-select"]');
        expect(sliders.length).toBe(2);
        expect(selects.length).toBe(2);
        for (const slider of sliders) {
            expect(slider.classList.contains('mdl-slider')).toBe(true);
            expect(slider.parentElement.querySelector('.mdl-slider-background-flex')).not.toBeNull();
        }
        for (const select of selects) {
            expect(select.classList.contains('emby-select')).toBe(true);
            expect(select.parentElement.querySelector('.selectArrowContainer')).not.toBeNull();
        }
        sizer.destroy();
    });

    it('gives the close button the TV focus class in TV layout', () => {
        const original = layoutManager.tv;
        layoutManager.tv = true;
        try {
            const { foreign, sizer } = openInForeignDocument();
            expect(foreign.querySelector('.subtitleSizer-closeButton')
                .classList.contains('show-focus')).toBe(true);
            sizer.destroy();
        } finally {
            layoutManager.tv = original;
        }
    });
});
