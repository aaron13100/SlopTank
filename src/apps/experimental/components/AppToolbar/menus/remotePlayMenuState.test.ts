import { describe, expect, it } from 'vitest';

import type { PlayTarget } from 'types/playTarget';

import { getRemotePlayMenuState } from './remotePlayMenuState';

const target = { id: 'tv', name: 'Living Room TV' } as PlayTarget;

describe('getRemotePlayMenuState', () => {
    it('reports unsupported when the cast plugin never loaded', () => {
        expect(getRemotePlayMenuState(false, [])).toEqual({ kind: 'unsupported' });
    });

    it('reports discovering while the target lookup is still in flight', () => {
        expect(getRemotePlayMenuState(true, null)).toEqual({ kind: 'discovering' });
    });

    it('reports empty when discovery completed with no receivers', () => {
        // Regression: this case previously rendered an empty popover with no
        // message at all, leaving the user with a blank grey square.
        expect(getRemotePlayMenuState(true, [])).toEqual({ kind: 'empty' });
    });

    it('reports the targets when receivers are available', () => {
        expect(getRemotePlayMenuState(true, [target])).toEqual({
            kind: 'targets',
            targets: [target]
        });
    });

    it('never returns targets for an unloaded plugin', () => {
        expect(getRemotePlayMenuState(false, [target]).kind).toBe('unsupported');
    });
});
