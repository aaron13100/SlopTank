import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { withDeploymentBase } from './browserBase';
import { ensurePermalinkIds } from './permalinkApi';
import {
    buildPermalinkPath,
    permalinkStartSecondsToTicks,
    type PermalinkKind
} from './permalinkId';
import { rememberPermalinkAlias } from './permalinkSession';

/**
 * Replaces a loaded GUID route with the server-issued canonical permalink.
 * The History API deliberately avoids a router transition: an info page stays
 * mounted and an active player is never restarted merely to tidy its URL.
 */
export async function canonicalizeLegacyGuidRoute({ api, item, kind }: {
    api: Api
    item: BaseItemDto
    kind: PermalinkKind
}): Promise<boolean> {
    const itemId = item.Id;
    if (!itemId) return false;

    const legacyRoute = kind === 'info' ? 'details' : 'video';
    if (window.location.pathname !== withDeploymentBase(`/web/${legacyRoute}`)) {
        return false;
    }

    try {
        const aliases = await ensurePermalinkIds({ api, itemId });
        rememberPermalinkAlias(item.ServerId, itemId, aliases.canonicalId);

        // A background ensure may finish after the user has already left the
        // GUID entry. Never let that stale completion rewrite a newer route.
        if (window.location.pathname !== withDeploymentBase(`/web/${legacyRoute}`)) {
            return false;
        }

        let search = '';
        if (kind === 'watch') {
            const startSeconds = new URLSearchParams(window.location.search).get('t');
            if (permalinkStartSecondsToTicks(startSeconds) !== null) {
                search = `?t=${startSeconds}`;
            }
        }

        const path = withDeploymentBase(buildPermalinkPath(kind, aliases.canonicalId));
        window.history.replaceState(window.history.state, '', `${path}${search}`);
        return true;
    } catch (error) {
        // The GUID route is still a valid fallback. Canonicalisation is a
        // background enhancement and must never break a page or playback.
        console.warn('[permalink] unable to canonicalize legacy item route:', error);
        return false;
    }
}
