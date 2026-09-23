// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
import { afterEach, describe, expect, it } from 'vitest';

import { EventType } from 'constants/eventType';
import Events from '../../../utils/events.ts';

import PersistentTitleControl from './PersistentTitleControl';

function createHarness() {
    document.body.innerHTML = '<div class="persistentVideoTitle hide" aria-hidden="true"></div>';
    const view = document.body;
    const control = new PersistentTitleControl({ view });
    control.bind();
    const element = view.querySelector('.persistentVideoTitle');
    return { control, element };
}

function showTitle(title) {
    Events.trigger(document, EventType.VIDEO_TITLE_CHANGE, [ title ]);
}

function showOsd(isShowing) {
    Events.trigger(document, EventType.SHOW_VIDEO_OSD, [ isShowing ]);
}

describe('PersistentTitleControl', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('shows the composed title once the OSD auto-hides', () => {
        const { element } = createHarness();

        showTitle('Brooklyn Nine-Nine - S2:E3 - The Jimmy Jab Games');
        expect(element.classList.contains('hide')).toBe(true);

        showOsd(false);
        expect(element.classList.contains('hide')).toBe(false);
        expect(element.textContent).toBe('Brooklyn Nine-Nine - S2:E3 - The Jimmy Jab Games');
    });

    it('hides again while the OSD is up, showing only one title on screen', () => {
        const { element } = createHarness();

        showTitle('The Breakfast Club (1985)');
        showOsd(false);
        expect(element.classList.contains('hide')).toBe(false);

        showOsd(true);
        expect(element.classList.contains('hide')).toBe(true);
    });

    it('never renders with an empty title, even while the OSD is hidden', () => {
        const { element } = createHarness();

        showOsd(false);
        expect(element.classList.contains('hide')).toBe(true);

        showTitle('');
        expect(element.classList.contains('hide')).toBe(true);
        expect(element.textContent).toBe('');
    });

    // @covers video.persistent_title.transition_clears_previous_title
    it('replaces the previous episode title when the next one starts', () => {
        const { element } = createHarness();

        showTitle('Brooklyn Nine-Nine - S2:E3 - The Jimmy Jab Games');
        showOsd(false);
        showTitle('Brooklyn Nine-Nine - S2:E4 - Halloween II');
        expect(element.textContent).toBe('Brooklyn Nine-Nine - S2:E4 - Halloween II');
        expect(element.classList.contains('hide')).toBe(false);
    });

    it('stops listening after destroy, leaving no listener on the document', () => {
        const { control, element } = createHarness();

        showOsd(false);
        showTitle('The Breakfast Club (1985)');
        expect(element.classList.contains('hide')).toBe(false);

        control.destroy();
        showTitle('Brooklyn Nine-Nine - S2:E3 - The Jimmy Jab Games');
        expect(element.textContent).toBe('The Breakfast Club (1985)');
    });
});
