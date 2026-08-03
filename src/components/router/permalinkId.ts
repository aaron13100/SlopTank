import { TICKS_PER_SECOND } from 'constants/time';
import { trimTrailingSlashes } from 'utils/url';

/**
 * Grammar and URL construction for the pretty permalink scheme
 * (docs/internal/permalink-url-design.md section 3). This module owns parsing
 * and link shapes only. It never decides which id an item should publish --
 * that is the server's, via `POST /Items/{id}/Permalink` (permalinkApi.ts) --
 * and it never resolves an id to an item, which lives in permalinkResolver.ts.
 */

export type PermalinkKind = 'info' | 'watch';

export type TmdbQualifier = 'mv' | 'tv' | 'ep' | 'se' | 'co';

export type ParsedPermalinkId =
    | { namespace: 'imdb', id: string }
    | { namespace: 'tmdb', qualifier: TmdbQualifier, numericId: string, id: string }
    | { namespace: 'sloptank', id: string };

/** Compatibility marker segments accepted from the previously shipped URL form. */
export const PERMALINK_MARKER_SEGMENTS = ['p', 'w'] as const;

const IMDB_ID_PATTERN = /^tt\d+$/;
const TMDB_ID_PATTERN = /^tm-(mv|tv|ep|se|co)-([1-9]\d*)$/;
/** 128 random bits as 26 lowercase Crockford-base32 characters, minted by the server's identity capsule (design 3.6). */
const SLOPTANK_ID_PATTERN = /^sk-[0-9a-hjkmnp-tv-z]{26}$/;
/** Prefixes reserved for future namespaces (TVDB, MusicBrainz, AudioDB). Never resolve; a route or asset must never claim them either. */
const RESERVED_PREFIX_PATTERN = /^(tv|mb|au)-/;

/**
 * Parses a single path segment as a permalink id. Returns null when the
 * segment does not match any defined or reserved grammar -- callers must
 * treat that as "not a permalink", not as an error.
 */
export function parsePermalinkId(raw: string): ParsedPermalinkId | null {
    if (!raw) return null;

    if (IMDB_ID_PATTERN.test(raw)) {
        return { namespace: 'imdb', id: raw };
    }

    const tmdbMatch = TMDB_ID_PATTERN.exec(raw);
    if (tmdbMatch) {
        return {
            namespace: 'tmdb',
            qualifier: tmdbMatch[1] as TmdbQualifier,
            numericId: tmdbMatch[2],
            id: raw
        };
    }

    if (SLOPTANK_ID_PATTERN.test(raw)) {
        return { namespace: 'sloptank', id: raw };
    }

    // Reserved prefixes never resolve, even though they already fail the
    // patterns above -- this documents the reservation so a future route or
    // static asset audit has something concrete to check against.
    if (RESERVED_PREFIX_PATTERN.test(raw)) {
        return null;
    }

    return null;
}

/** Builds the canonical BaseUrl-relative browser path. */
export function buildPermalinkPath(kind: PermalinkKind, id: string): string {
    return kind === 'info' ? `/${id}` : `/w/${id}`;
}

/**
 * Builds the absolute, pasteable browser-router permalink URL a share or copy
 * action publishes. The hosted server serves the web shell directly for this
 * path, so the address bar remains canonical through reload and navigation.
 *
 * @param origin The absolute origin the link is published under, without a trailing slash.
 * @param kind Whether the link opens the info page or the player.
 * @param id The alias the server persisted for the item.
 * @returns The absolute URL to publish.
 */
export function buildPermalinkShareUrl(origin: string, kind: PermalinkKind, id: string): string {
    return `${trimTrailingSlashes(origin)}${buildPermalinkPath(kind, id)}`;
}

/**
 * Parses the permalink 't' query parameter (an integer start offset in
 * seconds, section 3.1) into resume ticks. Returns null for anything that
 * is not a non-negative integer -- never guesses a start position from
 * malformed input.
 */
export function permalinkStartSecondsToTicks(rawSeconds: string | null | undefined): number | null {
    if (!rawSeconds || !/^\d+$/.test(rawSeconds)) return null;

    const ticks = Number(rawSeconds) * TICKS_PER_SECOND;
    return Number.isSafeInteger(ticks) ? ticks : null;
}
