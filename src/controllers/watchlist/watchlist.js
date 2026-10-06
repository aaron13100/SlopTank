// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * The dedicated My List view (c188): the signed-in user's watchlist,
 * newest-added first, honestly paged, with a localized empty state. Removals
 * through the cards' context menus come back through the items container's
 * refresh event, so the view updates in place instead of reloading.
 */

import cardBuilder from 'components/cardbuilder/cardBuilder';
import focusManager from 'components/focusManager';
import libraryBrowser from 'scripts/libraryBrowser';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getBackdropShape } from 'utils/card';
import { getWatchlist } from 'utils/watchlist';

import 'elements/emby-itemscontainer/emby-itemscontainer';

const PAGE_SIZE = 100;

class WatchlistView {
    constructor(view, params) {
        this.view = view;
        this.params = params;
        this.apiClient = ServerConnections.currentApiClient();
        this.query = {
            StartIndex: 0,
            Limit: PAGE_SIZE
        };

        const self = this;
        const query = this.query;

        function onNextPageClick() {
            query.StartIndex += query.Limit;
            self.itemsContainer.refreshItems().then(() => {
                window.scrollTo(0, 0);
                self.autoFocus();
            });
        }

        function onPreviousPageClick() {
            query.StartIndex = Math.max(0, query.StartIndex - query.Limit);
            self.itemsContainer.refreshItems().then(() => {
                window.scrollTo(0, 0);
                self.autoFocus();
            });
        }

        function updatePaging(startIndex, totalRecordCount, limit) {
            const pagingHtml = libraryBrowser.getQueryPagingHtml({
                startIndex,
                limit,
                totalRecordCount,
                showLimit: false,
                updatePageSizeSetting: false,
                addLayoutButton: false,
                sortButton: false,
                filterButton: false
            });

            for (const elem of view.querySelectorAll('.paging')) {
                elem.innerHTML = pagingHtml;
            }

            for (const elem of view.querySelectorAll('.btnNextPage')) {
                elem.addEventListener('click', onNextPageClick);
            }

            for (const elem of view.querySelectorAll('.btnPreviousPage')) {
                elem.addEventListener('click', onPreviousPageClick);
            }
        }

        function getItemsToWatchlistFn() {
            return function () {
                return getWatchlist(self.apiClient, self.apiClient.getCurrentUserId(), {
                    startIndex: query.StartIndex,
                    limit: query.Limit,
                    sortOrder: 'Descending'
                }).then(result => {
                    const isEmpty = result.TotalRecordCount === 0;
                    view.querySelector('.watchlist-empty').classList.toggle('hide', !isEmpty);
                    updatePaging(result.StartIndex, result.TotalRecordCount, query.Limit);
                    return result.Items;
                });
            };
        }

        function getItemsHtml(items) {
            return cardBuilder.getCardsHtml({
                items: items,
                preferThumb: true,
                shape: getBackdropShape(true),
                overlayText: false,
                showTitle: true,
                showParentTitle: true,
                lazy: true,
                showDetailsMenu: true,
                overlayPlayButton: true,
                context: 'watchlist',
                centerText: true,
                allowBottomPadding: false,
                cardLayout: false,
                showYear: true,
                lines: 2,
                serverId: self.apiClient.serverId()
            });
        }

        this.itemsContainer = view.querySelector('.itemsContainer');
        this.itemsContainer.fetchData = getItemsToWatchlistFn();
        this.itemsContainer.getItemsHtml = getItemsHtml;
    }

    autoFocus() {
        focusManager.autoFocus(this.view);
    }

    onResume(options) {
        // Always refetch on resume: membership changes from other surfaces
        // (detail page, search, home) must appear when the user comes back.
        this.itemsContainer.resume({ refresh: true }).then(() => {
            if (options?.autoFocus) {
                this.autoFocus();
            }
        });
    }

    onPause() {
        if (this.itemsContainer) {
            this.itemsContainer.pause();
        }
    }

    destroy() {
        if (this.itemsContainer) {
            this.itemsContainer.fetchData = null;
            this.itemsContainer.getItemsHtml = null;
            this.itemsContainer.parentContainer = null;
        }

        this.view = null;
        this.params = null;
        this.apiClient = null;
        this.itemsContainer = null;
    }
}

export default WatchlistView;
