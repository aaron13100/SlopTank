// SlopTank modification notice: added or changed by SlopTank on 2026-07-21, 2026-09-09.
import { describe, expect, it } from 'vitest';

import manifest from './manifest.json';

/**
 * The PWA manifest is a shipped product-identity artifact: index.html links it, and an installed
 * SlopTank shows its name and description on the user's home screen and in the browser's install
 * prompt. It must advertise SlopTank, not Jellyfin's project name or tagline.
 */
describe('PWA manifest', () => {
    it('advertises SlopTank as the installed app', () => {
        expect(manifest.name).toBe('SlopTank');
        expect(manifest.short_name).toBe('SlopTank');
    });

    it('does not ship the Jellyfin project tagline as its description', () => {
        expect(manifest.description).toBeTruthy();
        expect(manifest.description).not.toMatch(/jellyfin|free software media system/i);
    });

    it('references only SlopTank branding assets', () => {
        expect(manifest.icons.length).toBeGreaterThan(0);
        manifest.icons.forEach(icon => {
            expect(icon.src).not.toMatch(/jellyfin/i);
        });
    });
});
