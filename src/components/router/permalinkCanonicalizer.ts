import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { appRouter } from './appRouter';
import { stripDeploymentBase, withDeploymentBase } from './browserBase';
import { ensurePermalinkIds } from './permalinkApi';
import {
    buildPermalinkPath,
    getExternalPermalinkId,
    permalinkStartSecondsToTicks,
    type PermalinkKind
} from './permalinkId';
import { rememberPermalinkAlias } from './permalinkSession';

/**
 * Replaces a loaded GUID route with the server-issued canonical permalink.
 *
 * The rewrite is a real router transition carrying a handoff, not a raw
 * history write. An info page stays mounted and an active player is never
 * restarted merely to tidy its URL, but that is now achieved by telling the
 * router the truth and letting ViewManagerPage recognise the destination as
 * the view already on screen -- see PermalinkCanonicalizationState. The
 * previous window.history.replaceState version achieved it by hiding the URL
 * change from the router, which desynced the two and unmounted the player at
 * the next re-render.
 *
 * @param request The API for the ensure call, the item being canonicalized,
 *   which route kind is being rewritten, and the user the handoff is bound to.
 * @returns Whether the canonical alias was reached and written.
 */
export async function canonicalizeLegacyGuidRoute({ api, item, kind, userId }: {
    api: Api
    item: BaseItemDto
    kind: PermalinkKind
    userId: string
}): Promise<boolean> {
    const itemId = item.Id;
    if (!itemId) return false;

    const legacyRoute = kind === 'info' ? 'details' : 'video';
    const legacyPath = withDeploymentBase(`/web/${legacyRoute}`);
    if (window.location.pathname !== legacyPath) {
        return false;
    }

    const target = { itemId, serverId: item.ServerId ?? '', userId };

    const externalId = getExternalPermalinkId(item);
    if (externalId) {
        rememberPermalinkAlias(item.ServerId, itemId, externalId);
        replaceAddressBar(kind, externalId, target);
    }

    try {
        const aliases = await ensurePermalinkIds({ api, itemId });
        rememberPermalinkAlias(item.ServerId, itemId, aliases.canonicalId);

        // A background ensure may finish after the user has already left the
        // GUID entry. Never let that stale completion rewrite a newer route.
        const expectedPath = externalId ?
            withDeploymentBase(buildPermalinkPath(kind, externalId)) :
            legacyPath;
        if (window.location.pathname !== expectedPath) {
            return false;
        }

        // Same pathname is not the same content: the user may have moved to
        // another item on the very same legacy route while the ensure was in
        // flight. Rewriting then would label item B with item A's alias.
        // eslint-disable-next-line compat/compat -- URLSearchParams is already required throughout the supported web client.
        const routedItemId = new URLSearchParams(window.location.search).get('id');
        if (routedItemId && routedItemId !== itemId) {
            return false;
        }
        replaceAddressBar(kind, aliases.canonicalId, target);
        return true;
    } catch (error) {
        // The GUID route is still a valid fallback. Canonicalisation is a
        // background enhancement and must never break a page or playback.
        console.warn('[permalink] unable to canonicalize legacy item route:', error);
        return false;
    }
}

/**
 * The handoff a canonicalization carries to the permalink route it lands on.
 *
 * `canonicalizedFrom` is the router PATHNAME that was on screen at the moment
 * the rewrite was judged cosmetic; ViewManagerPage re-checks it against the
 * view actually on screen so a stale rewrite cannot suppress a genuine view
 * load. Pathname rather than full URL because a permalink route feeds the
 * legacy controller rewritten `?id=&serverId=` parameters, so the view's
 * recorded URL never carries the address bar's own query string.
 *
 * `permalinkTarget` is the item the alias was just minted FOR, so the
 * destination route does not have to redeem a single-use lease to rediscover
 * what this process already knows. It is a handoff, never a resolution: an
 * alias arriving from anywhere else (a pasted link, a reload in a session that
 * did not mint it) carries no handoff and always goes through the server.
 */
export interface PermalinkCanonicalizationState {
    canonicalizedFrom: string
    permalinkTarget: {
        permalinkId: string
        itemId: string
        serverId: string
        userId: string
    }
}

/**
 * Reads a canonicalization handoff back off a router location, if the one
 * present was minted by this process for this exact route and viewer.
 *
 * This is a handoff, never a resolution. It only ever returns the item whose
 * page the user was already on when this process asked the server to mint the
 * alias now in the address bar, so it grants no reach the previous route did
 * not already have: the same item is addressable as `/web/video?id=<guid>`.
 * Everything else -- a pasted link, a permalink opened in a fresh tab, an
 * alias this session never minted -- carries no handoff and resolves through
 * the server's purpose-bound lease as before.
 *
 * History state survives a reload, so the viewer is re-checked rather than
 * assumed: a different user signing in and returning to this entry does not
 * inherit the previous user's resolution.
 *
 * @param state The router location state to inspect.
 * @param permalinkId The alias this route is rendering.
 * @param serverId The server the current session is signed in to.
 * @param userId The user the current session is signed in as.
 * @returns The handed-off target, or undefined when it must be resolved.
 */
export function permalinkCanonicalizationHandoff(
    state: unknown,
    permalinkId: string | undefined,
    serverId: string,
    userId: string | undefined
): { itemId: string, serverId: string } | undefined {
    const target = (state as Partial<PermalinkCanonicalizationState> | null)?.permalinkTarget;

    if (!target || !permalinkId || !userId) return undefined;
    if (target.permalinkId !== permalinkId) return undefined;
    if (target.serverId !== serverId || target.userId !== userId) return undefined;
    if (!target.itemId) return undefined;

    return { itemId: target.itemId, serverId: target.serverId };
}

function replaceAddressBar(
    kind: PermalinkKind,
    permalinkId: string,
    target: { itemId: string, serverId: string, userId: string }
) {
    let search = '';
    if (kind === 'watch') {
        const startSeconds = new URLSearchParams(window.location.search).get('t');
        if (permalinkStartSecondsToTicks(startSeconds) !== null) {
            search = `?t=${startSeconds}`;
        }
    }

    // Router paths are basename-relative; window.location's is not.
    const state: PermalinkCanonicalizationState = {
        canonicalizedFrom: stripDeploymentBase(window.location.pathname),
        permalinkTarget: { permalinkId, ...target }
    };

    appRouter.canonicalizeAddressBar(`${buildPermalinkPath(kind, permalinkId)}${search}`, state);
}
