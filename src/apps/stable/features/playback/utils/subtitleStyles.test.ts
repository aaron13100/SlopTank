// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-09-09.
import { describe, expect, it } from 'vitest';

import { useCustomSubtitles } from './subtitleStyles';

describe('useCustomSubtitles()', () => {
    it('always selects the controllable element for plain text tracks', () => {
        expect(useCustomSubtitles()).toBe(true);
    });
});
