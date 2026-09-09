// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-07-24, 2026-09-09.
/**
 * Plain text subtitles always use the controllable DOM renderer.
 *
 * Browser-native caption compositors can ignore ::cue font-size rules or let
 * OS caption preferences override them. Selecting that path would make the
 * in-player size slider a visible no-op in browsers such as Brave.
 */
export function useCustomSubtitles() {
    return true;
}
