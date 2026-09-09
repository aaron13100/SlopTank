// SlopTank modification notice: added or changed by SlopTank on 2026-07-28, 2026-09-09.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ApiProvider current-user refresh contract', () => {
    const source = readFileSync(
        resolve(process.cwd(), 'src/hooks/useApi.tsx'),
        'utf8'
    );

    it('exposes an uncached current-user refresh through the context', () => {
        expect(source).toContain('getCurrentUser(false)');
        expect(source).toMatch(/const context = useMemo\(\(\) => \(\{[\s\S]*refreshUser,/);
    });
});
