// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-07-31, 2026-08-03, 2026-09-02, 2026-09-09.
import { TICKS_PER_SECOND } from 'constants/time';
import { trimTrailingSlashes } from 'utils/url';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

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
    | { namespace: 'tvdb', qualifier: TmdbQualifier, numericId: string, id: string }
    | { namespace: 'sloptank', id: string };

/** Compatibility marker segments accepted from the previously shipped URL form. */
export const PERMALINK_MARKER_SEGMENTS = ['p', 'w'] as const;

const IMDB_ID_PATTERN = /^tt\d+$/;
const TMDB_ID_PATTERN = /^tm-(mv|tv|ep|se|co)-([1-9]\d*)$/;
const TVDB_ID_PATTERN = /^tv-(mv|tv|ep|se|co)-([1-9]\d*)$/;
/** 128 random bits as 26 lowercase Crockford-base32 characters, minted by the server's identity capsule (design 3.6). */
const SLOPTANK_ID_PATTERN = /^sk-[0-9a-hjkmnp-tv-z]{26}$/;
/** Prefixes reserved for future namespaces (MusicBrainz, AudioDB). Never resolve; a route or asset must never claim them either. */
const RESERVED_PREFIX_PATTERN = /^(mb|au)-/;

/**
 * Reports whether a pathname is a permalink route still resolving to its real
 * destination.
 *
 * A permalink route is a doorway, not a page: it asks the server which item the
 * link means and then replaces itself with the details or video route. Anything
 * the app fetches for its own chrome while that is in flight is work the user
 * did not ask for, on a box that is busy answering the question they did ask.
 *
 * Measured on production 2026-09-02 opening a 10.53 GB film's watch link: the
 * three permalink round trips cost 8.34s in the browser against 3.5s with the
 * server idle, while UserViews (842ms), SyncPlay (616ms), System/Info (418ms)
 * and Branding (140ms) were in flight beside them on a two-core host.
 *
 * Deliberately tolerant of the deployment base and of a `/web` prefix, because
 * this is asked of `window.location.pathname`, which carries both.
 *
 * @param pathname A location pathname, with or without a deployment base.
 * @returns True while the path is a permalink route awaiting resolution.
 */
export function isPermalinkResolutionPath(pathname: string): boolean {
    const segments = pathname.split('/').filter(Boolean);
    const markerIndex = segments.findIndex(
        segment => (PERMALINK_MARKER_SEGMENTS as readonly string[]).includes(segment)
    );
    if (markerIndex < 0) return false;
    const id = segments[markerIndex + 1];
    return !!id && parsePermalinkId(id) !== null;
}

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

    const tvdbMatch = TVDB_ID_PATTERN.exec(raw);
    if (tvdbMatch) {
        return {
            namespace: 'tvdb',
            qualifier: tvdbMatch[1] as TmdbQualifier,
            numericId: tvdbMatch[2],
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

function qualifierForItemType(type: string | null | undefined): TmdbQualifier | null {
    switch (type) {
        case 'Movie': return 'mv';
        case 'Series': return 'tv';
        case 'Episode': return 'ep';
        case 'Season': return 'se';
        case 'BoxSet': return 'co';
        default: return null;
    }
}

function validNumericProviderId(value: string | null | undefined): value is string {
    return !!value && /^[1-9]\d*$/.test(value);
}

/**
 * Returns the provider permalink that the server deterministically elects
 * for an item. This is safe to use for immediate address-bar presentation;
 * durable issuance and fallback `sk-` allocation remain server-owned.
 */
export function getExternalPermalinkId(item: Pick<BaseItemDto, 'Type' | 'ProviderIds'>): string | null {
    const imdb = item.ProviderIds?.Imdb;
    if (imdb && IMDB_ID_PATTERN.test(imdb)) return imdb;

    const qualifier = qualifierForItemType(item.Type);
    if (!qualifier) return null;

    const tmdb = item.ProviderIds?.Tmdb;
    if (validNumericProviderId(tmdb)) return `tm-${qualifier}-${tmdb}`;

    const tvdb = item.ProviderIds?.Tvdb;
    if (validNumericProviderId(tvdb)) return `tv-${qualifier}-${tvdb}`;

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
