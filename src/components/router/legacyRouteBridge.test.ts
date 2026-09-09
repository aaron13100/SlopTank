// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
import { beforeEach, describe, expect, it } from 'vitest';

import { bridgeLegacyHashRoute } from './legacyRouteBridge';

function at(url: string) {
    window.history.replaceState({ retained: true }, '', url);
}

describe('bridgeLegacyHashRoute', () => {
    beforeEach(() => at('/web/'));

    it.each([
        ['/web/#/p/tt0062622', '/tt0062622'],
        ['/web/#/w/tt0062622?t=0', '/w/tt0062622?t=0'],
        ['/web/#/', '/web/home'],
        ['/web/#!/details?id=a%26b%3Dc&id=second', '/web/details?id=a%26b%3Dc&id=second'],
        ['/web/#!home', '/web/home']
    ])('bridges %s with one in-place replacement', (legacy, target) => {
        at(legacy);
        const length = window.history.length;

        expect(bridgeLegacyHashRoute()).toBe(true);
        expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(target);
        expect(window.history.length).toBe(length);
        expect(window.history.state).toEqual({ retained: true });
    });

    it('lets an inner query win over an outer query', () => {
        at('/web/?outer=1#/details?id=item-1&value=a%2Fb');
        bridgeLegacyHashRoute();
        expect(`${window.location.pathname}${window.location.search}`).toBe('/web/details?id=item-1&value=a%2Fb');
    });

    it('carries an outer query when the fragment has none', () => {
        at('/web/?server=one#/home');
        bridgeLegacyHashRoute();
        expect(`${window.location.pathname}${window.location.search}`).toBe('/web/home?server=one');
    });

    it('prefixes a configured BaseUrl exactly once', () => {
        document.head.insertAdjacentHTML('afterbegin', '<base href="/sloptank/web/">');
        at('/sloptank/web/#/w/tt0062622?t=0');

        bridgeLegacyHashRoute();

        expect(`${window.location.pathname}${window.location.search}`).toBe('/sloptank/w/tt0062622?t=0');
        document.querySelector('base')?.remove();
    });

    it('leaves ordinary anchors and malformed hash routes alone', () => {
        at('/web/details#cast');
        expect(bridgeLegacyHashRoute()).toBe(false);
        expect(window.location.href).toContain('/web/details#cast');
    });
});
