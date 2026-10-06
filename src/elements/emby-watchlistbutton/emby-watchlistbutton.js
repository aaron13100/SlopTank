// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * The My List toggle button for the legacy detail page (c188).
 *
 * The details controller (src/controllers/itemDetails/index.js) is over the
 * repo's source-file size cap and cannot take new wiring, so this element
 * wires itself: it finds the view's item from the details route parameters,
 * shows itself only for the item types the feature contract covers (Movie,
 * Series), and reads the membership state from the watchlist API. Clicks
 * flip the icon optimistically and roll back with an honest message when
 * the server refuses the change.
 */

import globalize from '../../lib/globalize';
import toast from '../../components/toast/toast';
import { deleteErrorSuffix } from '../../scripts/deleteHelper';
import dom from '../../utils/dom';
import { addToWatchlist, isInWatchlist, removeFromWatchlist } from '../../utils/watchlist';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import EmbyButtonPrototype from '../emby-button/emby-button';

/** Item types the My List contract covers. */
const WATCHLIST_ITEM_TYPES = ['Movie', 'Series'];

/**
 * Resolves the ApiClient for a server id, falling back to the current
 * connection when the route carries none (getApiClient throws on falsy ids).
 *
 * @param {string | undefined} serverId The route's server id, if any.
 * @returns {object} The ApiClient for that server.
 */
function apiClientFor(serverId) {
    return serverId ? ServerConnections.getApiClient(serverId) : ServerConnections.currentApiClient();
}

/**
 * Reads the current details route parameters.
 *
 * @returns {{ id: string, serverId: string | undefined }} The item id and optional server id.
 */
function currentRouteItem() {
    const params = new URLSearchParams(window.location.search);
    return {
        id: params.get('id') || '',
        serverId: params.get('serverId') || undefined
    };
}

/**
 * Applies the visual state for one membership value.
 *
 * @param {HTMLButtonElement} button The button element.
 * @param {boolean} inWatchlist Whether the item is on the user's list.
 */
function setState(button, inWatchlist) {
    const icon = button.querySelector('.material-icons');
    button.setAttribute('data-inwatchlist', String(inWatchlist));

    if (icon) {
        icon.classList.toggle('library_add', !inWatchlist);
        icon.classList.toggle('library_remove', inWatchlist);
    }

    button.title = globalize.translate(inWatchlist ? 'RemoveFromMyList' : 'AddToMyList');
}

/**
 * Refreshes visibility and membership state from the route's item and the
 * watchlist API. Stale activations (a second viewshow before the first
 * answered) are discarded through the button's activation token.
 *
 * @param {HTMLButtonElement} button The button element.
 */
function refreshState(button) {
    const route = currentRouteItem();
    if (!route.id) {
        button.classList.add('hide');
        return;
    }

    const activation = (Number(button.getAttribute('data-activation')) || 0) + 1;
    button.setAttribute('data-activation', String(activation));

    const apiClient = apiClientFor(route.serverId);
    const userId = apiClient.getCurrentUserId();

    apiClient.getItem(userId, route.id).then(item => {
        if (!WATCHLIST_ITEM_TYPES.includes(item.Type)) {
            button.classList.add('hide');
            return;
        }

        button.classList.remove('hide');
        button.setAttribute('data-id', item.Id);
        button.setAttribute('data-serverid', item.ServerId || '');

        return isInWatchlist(apiClient, userId, item.Id).then(inWatchlist => {
            if (Number(button.getAttribute('data-activation')) !== activation) {
                // A newer activation owns the state now.
                return;
            }

            setState(button, inWatchlist);
        });
    }).catch(error => {
        console.warn('[emby-watchlistbutton] membership check failed:', error);
        // Without a trustworthy membership answer there is no honest state to
        // show, so the button stays off instead of guessing.
        button.classList.add('hide');
    });
}

/**
 * Handles a click: flips the icon immediately, then persists. A refused
 * change rolls the icon back and reports the server's own reason.
 *
 * @param {Event} e The click event.
 */
function onClick(e) {
    const button = e.currentTarget;
    const itemId = button.getAttribute('data-id');
    const serverId = button.getAttribute('data-serverid') || undefined;
    if (!itemId) {
        return;
    }

    const wasInWatchlist = button.getAttribute('data-inwatchlist') === 'true';
    const apiClient = apiClientFor(serverId);
    const userId = apiClient.getCurrentUserId();

    setState(button, !wasInWatchlist);
    const request = wasInWatchlist
        ? removeFromWatchlist(apiClient, userId, itemId)
        : addToWatchlist(apiClient, userId, itemId);
    request.catch(error => {
        setState(button, wasInWatchlist);
        deleteErrorSuffix(error).then(suffix => {
            toast(globalize.translate(
                wasInWatchlist ? 'ErrorRemovingFromWatchlist' : 'ErrorAddingToWatchlist'
            ) + suffix);
        });
    });
}

function onViewShow() {
    // The view element re-dispatches viewshow on restore; the route
    // parameters may point at a different item than last time.
    refreshState(this);
}

function clearEvents(button) {
    button.removeEventListener('click', onClick);
    const view = dom.parentWithClass(button, 'page');
    if (view) {
        view.removeEventListener('viewshow', button.__viewShowHandler);
    }

    button.__viewShowHandler = null;
}

function bindEvents(button) {
    clearEvents(button);

    button.addEventListener('click', onClick);
    const view = dom.parentWithClass(button, 'page');
    if (view) {
        const handler = onViewShow.bind(button);
        button.__viewShowHandler = handler;
        view.addEventListener('viewshow', handler);
    }
}

const EmbyWatchlistButtonPrototype = Object.create(EmbyButtonPrototype);

EmbyWatchlistButtonPrototype.createdCallback = function () {
    // base method
    if (EmbyButtonPrototype.createdCallback) {
        EmbyButtonPrototype.createdCallback.call(this);
    }
};

EmbyWatchlistButtonPrototype.attachedCallback = function () {
    // base method
    if (EmbyButtonPrototype.attachedCallback) {
        EmbyButtonPrototype.attachedCallback.call(this);
    }

    bindEvents(this);

    // The view may already be showing when the element attaches (view html
    // renders before the controller's first viewshow completes).
    refreshState(this);
};

EmbyWatchlistButtonPrototype.detachedCallback = function () {
    // base method
    if (EmbyButtonPrototype.detachedCallback) {
        EmbyButtonPrototype.detachedCallback.call(this);
    }

    clearEvents(this);
};

document.registerElement('emby-watchlistbutton', {
    prototype: EmbyWatchlistButtonPrototype,
    extends: 'button'
});
