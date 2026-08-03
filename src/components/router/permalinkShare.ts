import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { trimTrailingSlashes } from 'utils/url';

import { ensurePermalinkIds, isPermalinkRequestError } from './permalinkApi';
import { buildPermalinkShareUrl, type PermalinkKind } from './permalinkId';
import { rememberPermalinkAlias } from './permalinkSession';

/**
 * Decides which URL a share or copy action publishes for one item
 * (docs/internal/permalink-url-design.md section 5).
 *
 * The rule this module exists to enforce: **ensure first, construct second**.
 * Every share and copy action asks the server to persist the item's identity
 * evidence and hand back its ordered aliases, and only then builds a URL from
 * the alias it was given. The client never infers a permalink from provider
 * ids sitting on an item DTO -- an id the server has not bound to evidence
 * does not resolve, so publishing one would ship a dead link.
 *
 * When ensure fails the action still produces a working link: the legacy
 * absolute GUID URL, explicitly marked temporary and carrying the server's own
 * reason, so the person sharing knows what they got and why.
 */

/**
 * What a share action may publish.
 *
 * Modelled as a discriminated union rather than a url plus a `permanent` flag
 * so "there is no link to publish" cannot be represented as a string a caller
 * might copy anyway. A `url` exists only on the two states that actually have
 * one, and every state that lacks a permanent link carries the reason.
 */
export type PermalinkShareUrl =
    | { status: 'permanent', url: string }
    | { status: 'temporary', url: string, reason: string }
    | { status: 'unavailable', reason: string };

/**
 * The legacy hash route each kind falls back to. Both remain supported forever
 * (design 3.8 rule 3).
 *
 * Takes the item id as a required string: interpolating an absent id would
 * publish a link reading `id=undefined`, which looks real, is copied happily,
 * and then fails for the recipient. The server id is appended only when the
 * item actually reports one, for the same reason.
 */
function legacyShareUrl(origin: string, itemId: string, serverId: string | null | undefined, kind: PermalinkKind): string {
    const route = kind === 'info' ? 'details' : 'video';
    const server = serverId ? `&serverId=${encodeURIComponent(serverId)}` : '';
    return `${trimTrailingSlashes(origin)}/web/${route}?id=${encodeURIComponent(itemId)}${server}`;
}

function describeFailure(error: unknown): string {
    if (isPermalinkRequestError(error)) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * Ensures the item's durable aliases, then builds the URL to publish.
 *
 * @param options.api The SDK Api for the server that owns the item.
 * @param options.origin The absolute origin the link is published under.
 * @param options.item The item being shared; only its id and server id are read.
 * @param options.kind Whether the link opens the info page or the player.
 * @returns The URL to publish, flagged permanent or temporary, with the server's reason when temporary.
 */
export async function buildShareUrl({ api, origin, item, kind }: {
    api: Api
    origin: string
    item: BaseItemDto
    kind: PermalinkKind
}): Promise<PermalinkShareUrl> {
    const itemId = item.Id;
    if (!itemId) {
        // No id means neither a permanent nor a legacy link can name this item.
        // Reporting that is the only honest answer; publishing a placeholder
        // URL would hand the user a link that cannot resolve for anyone.
        return {
            status: 'unavailable',
            reason: 'item-id-missing: this item has no id to build a link from.'
        };
    }

    try {
        const aliases = await ensurePermalinkIds({ api, itemId });
        rememberPermalinkAlias(item.ServerId, itemId, aliases.canonicalId);
        return {
            status: 'permanent',
            url: buildPermalinkShareUrl(origin, kind, aliases.canonicalId)
        };
    } catch (error) {
        // Not swallowed: the exact server code and message travel back to the
        // caller, which shows them to the person sharing (design section 5 --
        // a temporary link must visibly say it is temporary, and why).
        console.warn('[permalink] ensure failed; publishing a temporary link instead:', error);
        return {
            status: 'temporary',
            url: legacyShareUrl(origin, itemId, item.ServerId, kind),
            reason: describeFailure(error)
        };
    }
}
