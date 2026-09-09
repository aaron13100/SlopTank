// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
import { describe, expect, it } from 'vitest';

import { getDeploymentBasePath } from './browserBase';

describe('getDeploymentBasePath', () => {
    it('derives an empty BaseUrl from the fixed web base', () => {
        document.head.insertAdjacentHTML('afterbegin', '<base href="/web/">');
        expect(getDeploymentBasePath()).toBe('/');
        document.querySelector('base')?.remove();
    });

    it('derives a configured BaseUrl without including /web', () => {
        document.head.insertAdjacentHTML('afterbegin', '<base href="/sloptank/web/">');
        expect(getDeploymentBasePath()).toBe('/sloptank');
        document.querySelector('base')?.remove();
    });
});
