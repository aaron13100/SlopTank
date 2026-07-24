import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';

import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { TICKS_PER_SECOND } from 'constants/time';

/**
 * Grammar and mint helpers for the pretty permalink URL scheme
 * (docs/internal/permalink-url-design.md section 3). This module owns
 * parsing and mint-choice only; resolving a parsed id to a real item lives
 * in permalinkResolver.ts.
 */

export type PermalinkKind = 'info' | 'watch';

export type TmdbQualifier = 'mv' | 'tv' | 'ep' | 'se' | 'co';

export type ParsedPermalinkId =
    | { namespace: 'imdb', id: string }
    | { namespace: 'tmdb', qualifier: TmdbQualifier, numericId: string, id: string }
    | { namespace: 'sloptank', id: string };

/** The one-character marker segments a pretty permalink path lives under: #/p/<id>, #/w/<id>. */
export const PERMALINK_MARKER_SEGMENTS = ['p', 'w'] as const;

const IMDB_ID_PATTERN = /^tt\d+$/;
const TMDB_ID_PATTERN = /^tm-(mv|tv|ep|se|co)-([1-9]\d*)$/;
/** 128 random bits as 26 lowercase Crockford-base32 characters. Not yet mintable (no server authority); parsing is still defined so a future sk- link round-trips. */
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

/** Item kinds eligible for a permalink (docs/internal/permalink-url-design.md 3.6.1). Extras and trailers are never eligible. */
export const PERMALINK_ELIGIBLE_TYPES: BaseItemKind[] = [
    BaseItemKind.Movie,
    BaseItemKind.Episode,
    BaseItemKind.Video,
    BaseItemKind.MusicVideo,
    BaseItemKind.Series,
    BaseItemKind.Season,
    BaseItemKind.BoxSet
];

/** TMDB numbers are scoped per entity type (section 3.2); only these kinds have a defined TMDB qualifier. */
const TMDB_TYPE_QUALIFIERS: Partial<Record<BaseItemKind, TmdbQualifier>> = {
    [BaseItemKind.Movie]: 'mv',
    [BaseItemKind.Series]: 'tv',
    [BaseItemKind.Episode]: 'ep',
    [BaseItemKind.Season]: 'se',
    [BaseItemKind.BoxSet]: 'co'
};

const TMDB_NUMERIC_ID_PATTERN = /^[1-9]\d*$/;

/** The TMDB qualifier for a given item type, or null when TMDB has no typed namespace for it (e.g. Video, MusicVideo). */
export function tmdbQualifierForType(type: BaseItemKind): TmdbQualifier | null {
    return TMDB_TYPE_QUALIFIERS[type] ?? null;
}

/**
 * Pure, synchronous, best-effort mint from data already present on the item
 * (no network call, no sk- fallback -- that requires the server-side
 * identity capsule this fork has not built yet). Minting order is IMDb,
 * then TMDB. Returns null when the item is ineligible or carries neither.
 */
export function mintExternalPermalinkId(item: BaseItemDto | null | undefined): string | null {
    if (!item || !item.Type || item.ExtraType) return null;
    if (!PERMALINK_ELIGIBLE_TYPES.includes(item.Type)) return null;

    const providerIds = item.ProviderIds;
    if (!providerIds) return null;

    const imdbId = providerIds.Imdb;
    if (imdbId && IMDB_ID_PATTERN.test(imdbId)) {
        return imdbId;
    }

    const tmdbId = providerIds.Tmdb;
    const qualifier = TMDB_TYPE_QUALIFIERS[item.Type];
    if (tmdbId && qualifier && TMDB_NUMERIC_ID_PATTERN.test(tmdbId)) {
        return `tm-${qualifier}-${tmdbId}`;
    }

    return null;
}

/** Builds the in-app hash path for a permalink id, e.g. '#/p/tt3522806' or '#/w/tm-mv-4613'. */
export function buildPermalinkHashPath(kind: PermalinkKind, id: string): string {
    const marker = kind === 'info' ? 'p' : 'w';
    return `#/${marker}/${id}`;
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
