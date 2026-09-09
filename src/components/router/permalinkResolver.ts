// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-07-31, 2026-08-03, 2026-09-08, 2026-09-09.
import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';

import { randomId } from 'utils/random';

import {
    PermalinkRequestError,
    isPermalinkRequestError,
    discoverPermalinkCandidates,
    redeemPermalinkDetails,
    redeemPermalinkPlaybackReadyV1,
    type PermalinkCandidateEnvelope
} from './permalinkApi';
import type { ParsedPermalinkId, PermalinkKind } from './permalinkId';
import { rememberPermalinkAlias } from './permalinkSession';

/**
 * Resolves a parsed permalink id to a real item
 * (docs/internal/permalink-url-design.md section 4.2).
 *
 * Every namespace -- `tt`, `tm-*` and `sk-` alike -- resolves through the one
 * protected endpoint `GET /Permalinks/{id}/Items` and its purpose-bound lease
 * redemption. The client never queries the library itself: it does not scan,
 * does not filter, does not rank, and does not learn what an id means from
 * anything except a lease the server issued and then re-verified at
 * redemption. Extras, trailers, type qualification, provider casing and
 * assignment mismatches are all decided server-side against durable evidence,
 * which is the only place they can be decided correctly.
 *
 * The client's remaining responsibilities are the ones it can honour: parse
 * before any network call, never decide from a truncated candidate set, never
 * auto-pick between several candidates, and surface a typed failure with the
 * server's own code rather than collapsing it into "not found".
 */

/** An item the caller may navigate to. */
export interface PermalinkTarget {
    itemId: string
    serverId: string
}

/** One entry in the disambiguation chooser, described from a redeemed lease. */
export interface PermalinkChoice extends PermalinkTarget {
    name: string
    type: BaseItemKind
    productionYear?: number
}

export type PermalinkResolution =
    | { status: 'resolved', item: PermalinkTarget }
    | { status: 'ambiguous', candidates: PermalinkChoice[] }
    | { status: 'not-found' }
    | { status: 'evidence-required', code: string, message: string }
    | { status: 'conflict', code: string, message: string }
    | { status: 'unavailable', code: string, message: string }
    | { status: 'error', code: string, message: string };

/** The server's code for an external alias that has never been minted from an authenticated item page. */
const EVIDENCE_REQUIRED_CODE = 'EvidenceRequired';

export interface PermalinkResolveRequest {
    /** The SDK Api for the single server being asked. There is no multi-server fanout (design 4.2). */
    api: Api
    /** The server the route belongs to, used to build the legacy route once an item id is known. */
    serverId: string
    /** The already-parsed id. Parsing failures never reach this module. */
    parsed: ParsedPermalinkId
    /** Which route is resolving: the info page, or the player. */
    kind: PermalinkKind
    /** Aborts in-flight requests when the route changes, so a late response cannot install a stale result. */
    signal?: AbortSignal
}

/**
 * Resolves one permalink for one route.
 *
 * @param request The server, id, route kind and abort signal for this resolution.
 * @returns A typed resolution state. Ambiguity, absence and every server
 *   refusal are distinct states; none of them is ever reported as another.
 * @throws The underlying abort error when the caller's signal fires, so the
 *   query layer can discard the attempt rather than render a failure.
 */
export async function resolvePermalink(request: PermalinkResolveRequest): Promise<PermalinkResolution> {
    try {
        const candidates = await discoverPermalinkCandidates({
            api: request.api,
            permalinkId: request.parsed.id,
            // Discovery always asks for `details`: a details lease is the one
            // form that can either describe a candidate or be exchanged for a
            // playback lease, so a single discovery serves both routes and the
            // ambiguity chooser without redeeming anything speculatively.
            purpose: 'details',
            signal: request.signal
        });

        if (candidates.length === 0) {
            return { status: 'not-found' };
        }

        if (candidates.length > 1) {
            return { status: 'ambiguous', candidates: await describeCandidates(request, candidates) };
        }

        return request.kind === 'info' ?
            await resolveForInfo(request, candidates[0]) :
            await resolveForWatch(request, candidates[0]);
    } catch (error) {
        return toFailure(error);
    }
}

async function resolveForInfo(
    request: PermalinkResolveRequest,
    candidate: PermalinkCandidateEnvelope
): Promise<PermalinkResolution> {
    const item = await redeemPermalinkDetails({
        api: request.api,
        candidate,
        signal: request.signal
    });

    const itemId = item.Id;
    if (!itemId) {
        return {
            status: 'conflict',
            code: 'redeemed-item-incomplete',
            message: 'The server redeemed this link but returned an item without an id.'
        };
    }

    const serverId = item.ServerId ?? request.serverId;
    rememberPermalinkAlias(serverId, itemId, request.parsed.id);
    return { status: 'resolved', item: { itemId, serverId } };
}

async function resolveForWatch(
    request: PermalinkResolveRequest,
    candidate: PermalinkCandidateEnvelope
): Promise<PermalinkResolution> {
    // The versioned endpoint performs the established purpose exchange and
    // playback redemption in one server request. Both purpose-bound leases,
    // durable publication, revalidation steps and single-use checks remain.
    const snapshot = await redeemPermalinkPlaybackReadyV1({
        api: request.api,
        candidate,
        playbackSessionId: randomId(),
        signal: request.signal
    });

    rememberPermalinkAlias(request.serverId, snapshot.itemId, request.parsed.id);
    return { status: 'resolved', item: { itemId: snapshot.itemId, serverId: request.serverId } };
}

/**
 * Describes several candidates for the chooser by redeeming each one's details
 * lease. Fails closed: if any candidate cannot be redeemed the whole
 * resolution surfaces that failure, because a chooser that silently omits a
 * candidate is a chooser that can auto-pick the wrong work.
 */
async function describeCandidates(
    request: PermalinkResolveRequest,
    candidates: PermalinkCandidateEnvelope[]
): Promise<PermalinkChoice[]> {
    const described: PermalinkChoice[] = [];

    for (const candidate of candidates) {
        const item = await redeemPermalinkDetails({
            api: request.api,
            candidate,
            signal: request.signal
        });

        // Same contract the single-match path enforces: an entry without an id
        // would render as a link to nothing, which is worse than saying the
        // chooser could not be built.
        if (!item.Id) {
            throw new PermalinkRequestError({
                kind: 'conflict',
                code: 'redeemed-item-incomplete',
                message: 'The server redeemed a candidate for this link but returned an item without an id.',
                hint: 'The chooser is not shown rather than offering an entry that cannot be opened.'
            });
        }

        described.push(toChoice(item, item.Id, request.serverId));
    }

    return described;
}

function toChoice(item: BaseItemDto, itemId: string, fallbackServerId: string): PermalinkChoice {
    return {
        itemId,
        serverId: item.ServerId ?? fallbackServerId,
        name: item.Name ?? '',
        type: item.Type ?? BaseItemKind.Video,
        productionYear: item.ProductionYear ?? undefined
    };
}

/** Maps a typed request failure onto the resolution state the route renders. */
function toFailure(error: unknown): PermalinkResolution {
    if (!isPermalinkRequestError(error)) {
        return {
            status: 'error',
            code: 'resolver-failure',
            message: error instanceof Error ? error.message : String(error)
        };
    }

    if (error.kind === 'aborted') {
        throw error;
    }

    if (error.code === EVIDENCE_REQUIRED_CODE) {
        return { status: 'evidence-required', code: error.code, message: error.message };
    }

    if (error.kind === 'unavailable') {
        return { status: 'unavailable', code: error.code, message: error.message };
    }

    if (error.kind === 'conflict') {
        return { status: 'conflict', code: error.code, message: error.message };
    }

    return { status: 'error', code: error.code, message: error.message };
}
