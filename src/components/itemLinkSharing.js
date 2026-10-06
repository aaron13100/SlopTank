// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * Publishes and copies an item's shareable permalink link (extracted from
 * itemContextMenu, c188 split): ensures the server has bound the link to
 * evidence, shows progress while it does, then copies the URL with an honest
 * account of what the user got.
 */

import globalize from '../lib/globalize';
import { copy } from '../scripts/clipboard';
import { getShareOrigin } from '../scripts/settings/webSettings';
import loading from './loading/loading';
import { buildShareUrl } from './router/permalinkShare';
import toast from './toast/toast';

/**
 * Guards the shared loading spinner while a permalink ensure/publish call is
 * in flight. Ensure's cost scales with the media file's size (tens of
 * seconds for a multi-GB movie; docs/internal PermalinkEvidence hashing) and
 * previously gave no feedback at all while it ran, so a user seeing nothing
 * happen would reasonably invoke Copy Link, Copy Play Link or Share again
 * before the first call finished. Counting overlapping calls keeps the
 * spinner visible for the whole span instead of one call hiding it out from
 * under a sibling call still in flight.
 */
let pendingLinkPublishCalls = 0;

function beginLinkPublishProgress() {
    pendingLinkPublishCalls++;
    if (pendingLinkPublishCalls === 1) {
        loading.show();
    }
}

function endLinkPublishProgress() {
    pendingLinkPublishCalls = Math.max(0, pendingLinkPublishCalls - 1);
    if (pendingLinkPublishCalls === 0) {
        loading.hide();
    }
}

/**
 * Asks the server to persist this item's permalink evidence and returns the
 * URL to publish (docs/internal/permalink-url-design.md section 5). Ensure
 * always runs before any URL is constructed, for every item, so a published
 * link is always one the server has bound to evidence -- or an explicitly
 * temporary legacy link carrying the server's own reason.
 *
 * Keeps the shared loading spinner visible for the call's full duration
 * (`beginLinkPublishProgress`/`endLinkPublishProgress`) so Copy Link, Copy
 * Play Link and Share all show progress immediately instead of appearing to
 * do nothing while ensure hashes the file server-side.
 *
 * @param {object} apiClient The legacy api client for the item's server.
 * @param {import('@jellyfin/sdk/lib/api').Api} api The SDK api for the same server.
 * @param {import('@jellyfin/sdk/lib/generated-client/models/base-item-dto').BaseItemDto} item The item being shared.
 * @param {'info'|'watch'} kind Whether the link opens the info page or the player.
 * @returns {Promise<import('./router/permalinkShare').PermalinkShareUrl>} The permanent link, an explicitly temporary one, or the reason no link exists.
 */
async function publishItemLink(apiClient, api, item, kind) {
    beginLinkPublishProgress();
    try {
        const origin = await getShareOrigin(apiClient.serverAddress());
        return await buildShareUrl({ api, origin, item, kind });
    } finally {
        endLinkPublishProgress();
    }
}

/**
 * Copies the item's permanent link, telling the user plainly which of the two
 * they got. A temporary link names the server's own refusal code rather than
 * a generic failure, so the reason is actionable.
 *
 * @param {object} apiClient The legacy api client for the item's server.
 * @param {import('@jellyfin/sdk/lib/api').Api} api The SDK api for the same server.
 * @param {import('@jellyfin/sdk/lib/generated-client/models/base-item-dto').BaseItemDto} item The item being shared.
 * @param {'info'|'watch'} kind Whether the link opens the info page or the player.
 * @param {'CopyLink'|'CopyPlayLink'} stringPrefix The string key family for this command's messages.
 * @returns {Promise<void>} Resolves once the clipboard write and its notification are done.
 */
export async function copyItemLink(apiClient, api, item, kind, stringPrefix) {
    let link;
    try {
        link = await publishItemLink(apiClient, api, item, kind);
    } catch (error) {
        console.error('[itemLinkSharing] could not build a share link:', error);
        toast(globalize.translate('PermalinkResolveError', String(error)));
        return;
    }

    if (link.status === 'unavailable') {
        // Nothing to copy: say why instead of putting a link that cannot
        // resolve on the clipboard.
        toast(globalize.translate('PermalinkResolveError', link.reason));
        return;
    }

    try {
        await copy(link.url);
        toast(link.status === 'permanent' ?
            globalize.translate(`${stringPrefix}Success`) :
            globalize.translate(`${stringPrefix}TemporarySuccess`, link.reason));
    } catch (error) {
        // Clipboard write refused (permissions, insecure context): fall back to
        // a selectable field rather than losing the link the user asked for.
        console.warn('[itemLinkSharing] clipboard write failed, showing the link instead:', error);
        prompt(globalize.translate(stringPrefix), link.url);
    }
}
