// SlopTank modification notice: added or changed by SlopTank on 2026-07-21, 2026-09-09.
/**
 * Options specifying if the player's native subtitle (cue) element should be used, a custom element (div), or allow
 * the player to choose automatically based on known browser support. Some browsers do not properly apply CSS styling
 * to the native subtitle element.
 */
export const SubtitleStylingOption = {
    Auto: 'Auto',
    Custom: 'Custom',
    Native: 'Native'
} as const;

// eslint-disable-next-line @typescript-eslint/no-redeclare
export type SubtitleStylingOption = typeof SubtitleStylingOption[keyof typeof SubtitleStylingOption];
