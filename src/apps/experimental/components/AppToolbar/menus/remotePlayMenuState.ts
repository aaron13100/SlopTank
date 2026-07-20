import type { PlayTarget } from 'types/playTarget';

/**
 * The mutually exclusive states the "Play On" / cast menu can be in.
 *
 * Modelled as a discriminated union rather than a set of booleans so that
 * "plugin loaded but zero targets" cannot silently fall through to rendering
 * nothing, which previously produced an empty popover with no explanation.
 */
export type RemotePlayMenuState =
    /** The cast plugin never loaded (unsupported browser/platform). */
    | { kind: 'unsupported' }
    /** Discovery has not reported back yet. */
    | { kind: 'discovering' }
    /** Discovery completed and found no receivers. */
    | { kind: 'empty' }
    /** At least one play target is available. */
    | { kind: 'targets', targets: PlayTarget[] };

/**
 * Decides what the remote play menu should display.
 *
 * @param isPluginLoaded whether the chromecast plugin was loaded at startup
 * @param targets play targets returned by the playback manager, or null while
 *                the lookup is still in flight
 * @returns the state the menu should render
 */
export function getRemotePlayMenuState(
    isPluginLoaded: boolean,
    targets: PlayTarget[] | null
): RemotePlayMenuState {
    if (!isPluginLoaded) return { kind: 'unsupported' };
    if (targets === null) return { kind: 'discovering' };
    if (targets.length === 0) return { kind: 'empty' };
    return { kind: 'targets', targets };
}
