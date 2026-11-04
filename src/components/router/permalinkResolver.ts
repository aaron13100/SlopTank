// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-07-31, 2026-08-03, 2026-09-08, 2026-09-09.
import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';

import {
    getPermalinkItems,
    isPermalinkRequestError,
    PermalinkRequestError
} from './permalinkApi';
import type { ParsedPermalinkId } from './permalinkId';
import { rememberPermalinkAlias } from './permalinkSession';

/** An item the caller may navigate to. */
export interface PermalinkTarget {
    itemId: string
    serverId: string
}

/** One ordinary library item offered by the disambiguation chooser. */
export interface PermalinkChoice extends PermalinkTarget {
    name: string
    type: BaseItemKind
    productionYear?: number
}

export type PermalinkResolution =
    | { status: 'resolved', item: PermalinkTarget }
    | { status: 'ambiguous', candidates: PermalinkChoice[] }
    | { status: 'not-found' }
    | { status: 'conflict', code: string, message: string }
    | { status: 'unavailable', code: string, message: string }
    | { status: 'error', code: string, message: string };

export interface PermalinkResolveRequest {
    /** The SDK Api for the single server being asked. */
    api: Api
    /** The signed-in server, used when an item DTO omits its server id. */
    serverId: string
    /** The already-parsed id. Parsing failures never reach this module. */
    parsed: ParsedPermalinkId
    /** Aborts the request when the route changes. */
    signal?: AbortSignal
}

/**
 * Resolves one permalink through the server's ordinary authorized item query.
 *
 * @param request The server, id and abort signal for this resolution.
 * @returns A resolved item, an explicit chooser, absence, or a typed failure.
 * @throws The underlying abort error when the caller's signal fires.
 */
export async function resolvePermalink(request: PermalinkResolveRequest): Promise<PermalinkResolution> {
    try {
        const result = await getPermalinkItems({
            api: request.api,
            permalinkId: request.parsed.id,
            signal: request.signal
        });
        const items = result.Items ?? [];
        const total = result.TotalRecordCount ?? items.length;

        if (total > items.length) {
            throw new PermalinkRequestError({
                kind: 'conflict',
                code: 'item-set-truncated',
                message: `The server counted ${total} permalink items but returned ${items.length}.`,
                hint: 'Resolution stops rather than deciding from an incomplete item set.'
            });
        }

        if (items.length === 0) {
            return { status: 'not-found' };
        }

        const candidates = items.map(item => toChoice(item, request.serverId));
        if (candidates.length > 1) {
            return { status: 'ambiguous', candidates };
        }

        const [ item ] = candidates;
        rememberPermalinkAlias(item.serverId, item.itemId, request.parsed.id);
        return { status: 'resolved', item };
    } catch (error) {
        return toFailure(error);
    }
}

function toChoice(item: BaseItemDto, fallbackServerId: string): PermalinkChoice {
    if (!item.Id) {
        throw new PermalinkRequestError({
            kind: 'conflict',
            code: 'item-incomplete',
            message: 'The server returned a permalink item without an id.',
            hint: 'The item cannot be opened or offered in the chooser without its library id.'
        });
    }

    return {
        itemId: item.Id,
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

    if (error.kind === 'not-found') {
        return { status: 'not-found' };
    }

    if (error.kind === 'unavailable') {
        return { status: 'unavailable', code: error.code, message: error.message };
    }

    if (error.kind === 'conflict') {
        return { status: 'conflict', code: error.code, message: error.message };
    }

    return { status: 'error', code: error.code, message: error.message };
}
