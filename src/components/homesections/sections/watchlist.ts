// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * The home "My List" section (c188): the signed-in user's watchlist,
 * newest-added first, with a localized empty state. The section stays
 * visible when the list is empty and says so, instead of vanishing and
 * leaving the user to wonder whether the feature exists.
 */

import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { ApiClient } from 'jellyfin-apiclient';

import cardBuilder from 'components/cardbuilder/cardBuilder';
import layoutManager from 'components/layoutManager';
import { appRouter } from 'components/router/appRouter';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getBackdropShape } from 'utils/card';
import { getWatchlist } from 'utils/watchlist';

import type { SectionContainerElement, SectionOptions } from './section';

/**
 * Builds the fetcher for the section's items container: pulls one page of
 * the user's list, newest-added first, and keeps the section's visibility
 * honest for both the populated and the empty case.
 *
 * @param serverId - The current server id.
 * @param elem - The section's root element.
 * @param emptyElem - The element carrying the localized empty message.
 * @param options - Section options (overflow decides the page size).
 * @returns The fetch function for the items container.
 */
function getWatchlistItemsFn(
    serverId: string,
    elem: HTMLElement,
    emptyElem: HTMLElement,
    { enableOverflow }: SectionOptions
) {
    return function () {
        const sectionApiClient = ServerConnections.getApiClient(serverId) as ApiClient;
        return getWatchlist(sectionApiClient, sectionApiClient.getCurrentUserId(), {
            limit: enableOverflow ? 12 : 5,
            sortOrder: 'Descending'
        }).then(result => {
            const items = result.Items;
            emptyElem.classList.toggle('hide', items.length > 0);
            elem.classList.remove('hide');
            return items;
        });
    };
}

/**
 * Builds the card renderer for the section's items container. Cards carry
 * the details menu, so the context menu's Add/Remove My List entries are
 * available right on the rail.
 *
 * @param serverId - The current server id.
 * @param options - Section options.
 * @returns The HTML renderer for the items container.
 */
function getWatchlistItemsHtmlFn(serverId: string, { enableOverflow }: SectionOptions) {
    return function (items: BaseItemDto[]) {
        return cardBuilder.getCardsHtml({
            items: items,
            preferThumb: true,
            shape: getBackdropShape(enableOverflow),
            overlayText: false,
            showTitle: true,
            showParentTitle: true,
            lazy: true,
            showDetailsMenu: true,
            overlayPlayButton: true,
            context: 'home',
            centerText: true,
            allowBottomPadding: false,
            cardLayout: false,
            showYear: true,
            lines: 2,
            serverId: serverId
        });
    };
}

/**
 * Renders the My List section into one home section slot.
 *
 * @param elem - The section slot element.
 * @param apiClient - The current API client.
 * @param options - Section options.
 */
export function loadWatchlist(
    elem: HTMLElement,
    apiClient: ApiClient,
    options: SectionOptions
) {
    let html = '';

    html += '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">';
    if (layoutManager.tv) {
        html += '<h2 class="sectionTitle sectionTitle-cards">' + globalize.translate('Watchlist') + '</h2>';
    } else {
        html += '<a is="emby-linkbutton" href="' + appRouter.getRouteUrl('watchlist', { serverId: apiClient.serverId() }) + '" class="more button-flat button-flat-mini sectionTitleTextButton">';
        html += '<h2 class="sectionTitle sectionTitle-cards">';
        html += globalize.translate('Watchlist');
        html += '</h2>';
        html += '<span class="material-icons chevron_right" aria-hidden="true"></span>';
        html += '</a>';
    }
    html += '</div>';

    if (options.enableOverflow) {
        html += '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">';
        html += '<div is="emby-itemscontainer" class="itemsContainer scrollSlider focuscontainer-x"></div>';
        html += '</div>';
    } else {
        html += '<div is="emby-itemscontainer" class="itemsContainer padded-left padded-right vertical-wrap focuscontainer-x"></div>';
    }
    html += '<div class="watchlist-empty hide padded-left padded-right">' + globalize.translate('MyListEmpty') + '</div>';

    elem.classList.add('hide');
    elem.innerHTML = html;

    const itemsContainer = elem.querySelector('.itemsContainer') as SectionContainerElement | null;
    const emptyElem = elem.querySelector('.watchlist-empty');
    if (!itemsContainer || !(emptyElem instanceof HTMLElement)) return;

    itemsContainer.fetchData = getWatchlistItemsFn(apiClient.serverId(), elem, emptyElem, options);
    itemsContainer.getItemsHtml = getWatchlistItemsHtmlFn(apiClient.serverId(), options);
}
