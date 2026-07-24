import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';

import { PERMALINK_ELIGIBLE_TYPES, tmdbQualifierForType, type ParsedPermalinkId } from './permalinkId';

/**
 * Resolves a parsed permalink id to a real item (docs/internal/permalink-url-design.md
 * section 4). The design's own resolution algorithm calls for a dedicated,
 * purpose-bound `GET /Permalinks/{id}/Items` server endpoint (4.1) backed by
 * an exact-value provider-id query and, for ids with no external provider,
 * a server-minted `sk-` identity capsule (3.6). Neither exists yet: this
 * fork has no working .NET build/deploy pipeline in this environment (no
 * dotnet SDK, no container runtime, and the live server process is the
 * stock Jellyfin.app binary with a patched --webdir, not a build of this
 * repo's SlopTank-server fork), so a new server endpoint could not be
 * compiled, tested, or deployed this session. See the follow-up task filed
 * against this gap.
 *
 * v1 therefore resolves imdb/tmdb ids entirely client-side against the
 * already-deployed, stock `GET /Items?hasImdbId=&hasTmdbId=` presence
 * filter, narrowing to an exact match locally. This is strictly a slower
 * substitute for the same contract (still discards extras/trailers before
 * matching, still pages until the count is exhausted, still surfaces
 * ambiguity/not-found/error rather than guessing) -- callers only use it for
 * a one-time permalink open, never for routine in-app navigation, so the
 * extra cost is bounded to the moment a shared link is actually opened.
 * `sk-` ids are parsed but never resolvable until the server-side identity
 * capsule ships.
 */

const PAGE_SIZE = 200;

export interface PermalinkCandidate {
    id: string
    serverId: string
    name: string
    type: BaseItemKind
    productionYear?: number
}

export type PermalinkResolution =
    | { status: 'resolved', item: PermalinkCandidate }
    | { status: 'ambiguous', candidates: PermalinkCandidate[] }
    | { status: 'not-found' }
    | { status: 'unsupported', reason: string }
    | { status: 'error', message: string };

function toCandidate(item: BaseItemDto): PermalinkCandidate {
    return {
        id: item.Id ?? '',
        serverId: item.ServerId ?? '',
        name: item.Name ?? '',
        type: item.Type ?? BaseItemKind.Video,
        productionYear: item.ProductionYear ?? undefined
    };
}

function isDiscarded(item: BaseItemDto): boolean {
    // Extras and trailers commonly carry the parent work's provider id and
    // must be discarded before matching, never ranked below a real match
    // (design section 4.2 rule 4): a trailer that is the sole surviving row
    // would otherwise be treated as the resolved item.
    return !!item.ExtraType || item.Type === BaseItemKind.Trailer;
}

function matchesParsedId(item: BaseItemDto, parsed: ParsedPermalinkId): boolean {
    if (parsed.namespace === 'imdb') {
        const value = item.ProviderIds?.Imdb;
        return !!value && value.toLowerCase() === parsed.id.toLowerCase();
    }

    if (parsed.namespace !== 'tmdb') return false;

    // tmdb: the stored value must match AND the item's own type must
    // qualify to the same namespace the id was minted under (section 3.2 --
    // TMDB movie 4613 and TMDB series 4613 are unrelated works).
    const value = item.ProviderIds?.Tmdb;
    if (!value || value !== parsed.numericId || !item.Type) return false;
    return tmdbQualifierForType(item.Type) === parsed.qualifier;
}

interface ProviderPresenceFilter {
    hasImdbId?: boolean
    hasTmdbId?: boolean
}

/**
 * Pages through /Items until the reported total is exhausted (design
 * section 4.2 rule 3: never decide from a truncated result set), collecting
 * every surviving (non-discarded, exact-matching) candidate.
 */
async function collectMatches(api: Api, parsed: ParsedPermalinkId, providerFilter: ProviderPresenceFilter): Promise<BaseItemDto[]> {
    const matches: BaseItemDto[] = [];
    let startIndex = 0;
    let totalRecordCount = Infinity;

    while (startIndex < totalRecordCount) {
        const response = await getItemsApi(api).getItems({
            recursive: true,
            includeItemTypes: PERMALINK_ELIGIBLE_TYPES,
            fields: [ ItemFields.ProviderIds ],
            enableImages: false,
            enableUserData: false,
            enableTotalRecordCount: true,
            startIndex,
            limit: PAGE_SIZE,
            ...providerFilter
        });

        const page = response.data.Items ?? [];
        totalRecordCount = response.data.TotalRecordCount ?? page.length;

        for (const item of page) {
            if (!isDiscarded(item) && matchesParsedId(item, parsed)) {
                matches.push(item);
            }
        }

        if (page.length === 0) break;
        startIndex += page.length;
    }

    return matches;
}

/**
 * Resolves a parsed permalink id against the given server. Never guesses:
 * zero or several surviving matches are returned as distinct states for the
 * caller to render (not-found message, or an ambiguity chooser).
 */
export async function resolvePermalink(api: Api, parsed: ParsedPermalinkId): Promise<PermalinkResolution> {
    if (parsed.namespace === 'sloptank') {
        return {
            status: 'unsupported',
            reason: 'This server does not yet support sk- fallback permalinks (no server-side identity capsule).'
        };
    }

    const providerFilter: ProviderPresenceFilter = parsed.namespace === 'imdb' ?
        { hasImdbId: true } :
        { hasTmdbId: true };

    let matches: BaseItemDto[];
    try {
        matches = await collectMatches(api, parsed, providerFilter);
    } catch (err) {
        return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }

    if (matches.length === 0) return { status: 'not-found' };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches.map(toCandidate) };
    return { status: 'resolved', item: toCandidate(matches[0]) };
}
