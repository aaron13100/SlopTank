import { SubtitleStylingOption } from 'apps/stable/features/playback/constants/subtitleStylingOption';
import browser from 'scripts/browser';
import type { UserSettings } from 'scripts/settings/userSettings';

// TODO: This type override should be removed when userSettings are properly typed
interface SubtitleAppearanceSettings {
    subtitleStyling: SubtitleStylingOption
}

export function useCustomSubtitles(userSettings: UserSettings) {
    const subtitleAppearance = userSettings.getSubtitleAppearanceSettings() as SubtitleAppearanceSettings;
    switch (subtitleAppearance.subtitleStyling) {
        case SubtitleStylingOption.Native:
            return false;
        case SubtitleStylingOption.Custom:
            return true;
        default:
            // Default to the custom subtitle element everywhere: it is the
            // one rendering pipeline whose styling (live size changes, the
            // in-player size preview line) is fully controllable, and it is
            // already the forced path for PS4, Tizen 5+, webOS, Edge,
            // Firefox (native font-size styling broken), and iOS/macOS
            // (global caption settings break size/margins). Native remains
            // available as an explicit choice above.
            return true;
    }
}
