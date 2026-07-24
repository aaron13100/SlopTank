import { describe, expect, it } from 'vitest';

import { useCustomSubtitles } from './subtitleStyles';

describe('useCustomSubtitles()', () => {
    it('always selects the controllable element for plain text tracks', () => {
        expect(useCustomSubtitles()).toBe(true);
    });
});
