import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserSettings } from 'scripts/settings/userSettings';

import { SubtitleStylingOption } from '../constants/subtitleStylingOption';
import { useCustomSubtitles } from './subtitleStyles';

describe('useCustomSubtitles()', () => {
    let userSettings: UserSettings;

    beforeEach(() => {
        localStorage.clear();
        userSettings = new UserSettings();
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('defaults to the custom element when no styling preference is saved', () => {
        expect(useCustomSubtitles(userSettings)).toBe(true);
    });

    it('returns false when the user explicitly chose the native element', () => {
        userSettings.setSubtitleAppearanceSettings({ subtitleStyling: SubtitleStylingOption.Native }, undefined);

        expect(useCustomSubtitles(userSettings)).toBe(false);
    });

    it('returns true when the user explicitly chose the custom element', () => {
        userSettings.setSubtitleAppearanceSettings({ subtitleStyling: SubtitleStylingOption.Custom }, undefined);

        expect(useCustomSubtitles(userSettings)).toBe(true);
    });

    it('defaults to the custom element for "Auto" (no browser gets true native styling support)', () => {
        userSettings.setSubtitleAppearanceSettings({ subtitleStyling: SubtitleStylingOption.Auto }, undefined);

        expect(useCustomSubtitles(userSettings)).toBe(true);
    });
});
