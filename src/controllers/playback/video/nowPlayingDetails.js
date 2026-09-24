// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns the now-playing header text and item-bound buttons: title and
 * document title, secondary media info, the rating button, and the
 * live-TV record button.
 *
 * Constructed by video/index.js, which injects its dependencies (the view).
 *
 * @module controllers/playback/video/nowPlayingDetails
 */

import { ServerConnections } from 'lib/jellyfin-apiclient';
import { loadDynamicModule } from 'utils/dynamicImport';
import mediaInfo from '../../../components/mediainfo/mediainfo';
import itemHelper from '../../../components/itemHelper';
import datetime from '../../../scripts/datetime';
import LibraryMenu from '../../../scripts/libraryMenu';
import Events from '../../../utils/events.ts';
import { EventType } from 'constants/eventType';

/**
 * Creates the now-playing details controller.
 *
 * @param {object} options - Dependencies injected by video/index.js.
 * @param {HTMLElement} options.view - The video OSD view element.
 * @returns {object} { getDisplayItem, update, clear, destroy }
 */
export function createNowPlayingDetails(options) {
    const { view } = options;

    let recordingButtonManager;

    function updateRecordingButton(item) {
        if (!item || item.Type !== 'Program') {
            if (recordingButtonManager) {
                recordingButtonManager.destroy();
                recordingButtonManager = null;
            }

            view.querySelector('.btnRecord').classList.add('hide');
            return;
        }

        ServerConnections.getApiClient(item.ServerId).getCurrentUser().then(function (user) {
            if (user.Policy.EnableLiveTvManagement) {
                loadDynamicModule(() => import('../../../components/recordingcreator/recordingbutton'),
                    '../../../components/recordingcreator/recordingbutton').then(({ default: RecordingButton }) => {
                    if (recordingButtonManager) {
                        recordingButtonManager.refreshItem(item);
                        return;
                    }

                    recordingButtonManager = new RecordingButton({
                        item: item,
                        button: view.querySelector('.btnRecord')
                    });
                    view.querySelector('.btnRecord').classList.remove('hide');
                });
            }
        });
    }

    function setTitle(item, parentName) {
        let itemName = itemHelper.getDisplayName(item, {
            includeParentInfo: item.Type !== 'Program',
            includeIndexNumber: item.Type !== 'Program'
        });

        if (itemName && parentName) {
            itemName = `${parentName} - ${itemName}`;
        }

        if (!itemName) {
            itemName = parentName || '';
        }

        // Display the item with its premiere date if it has one
        let title = itemName;
        if (item.Type == 'Movie' && item.ProductionYear) {
            title += ` (${datetime.toLocaleString(item.ProductionYear, { useGrouping: false })})`;
        } else if (item.PremiereDate) {
            try {
                const year = datetime.toLocaleString(datetime.parseISO8601Date(item.PremiereDate).getFullYear(), { useGrouping: false });
                title += ` (${year})`;
            } catch (e) {
                console.error(e);
            }
        }

        LibraryMenu.setTitle(title);
        Events.trigger(document, EventType.VIDEO_TITLE_CHANGE, [ title ]);

        const documentTitle = parentName || (item ? item.Name : null);

        if (documentTitle) {
            document.title = documentTitle;
        }
    }

    function getDisplayItem(item) {
        if (item.Type === 'TvChannel') {
            const apiClient = ServerConnections.getApiClient(item.ServerId);
            return apiClient.getItem(apiClient.getCurrentUserId(), item.Id).then(function (refreshedItem) {
                return {
                    originalItem: refreshedItem,
                    displayItem: refreshedItem.CurrentProgram
                };
            });
        }

        return Promise.resolve({
            originalItem: item
        });
    }

    function update(displayItem, item) {
        updateRecordingButton(displayItem);
        let parentName = displayItem.SeriesName || displayItem.Album;

        if (displayItem.EpisodeTitle || displayItem.IsSeries) {
            parentName = displayItem.Name;
        }

        setTitle(displayItem, parentName);

        const secondaryMediaInfo = view.querySelector('.osdSecondaryMediaInfo');
        const secondaryMediaInfoHtml = mediaInfo.getSecondaryMediaInfoHtml(displayItem, {
            startDate: false,
            programTime: false
        });
        secondaryMediaInfo.innerHTML = secondaryMediaInfoHtml;

        if (secondaryMediaInfoHtml) {
            secondaryMediaInfo.classList.remove('hide');
        } else {
            secondaryMediaInfo.classList.add('hide');
        }

        // Set currently playing item for favorite button
        const btnUserRating = view.querySelector('.btnUserRating');

        if (itemHelper.canRate(item)) {
            btnUserRating.classList.remove('hide');
            btnUserRating.setItem(item);
        } else {
            btnUserRating.classList.add('hide');
            btnUserRating.setItem(null);
        }
    }

    function clear() {
        updateRecordingButton(null);
        LibraryMenu.setTitle('');
        Events.trigger(document, EventType.VIDEO_TITLE_CHANGE, [ '' ]);
        view.querySelector('.osdTitle').innerHTML = '';
        view.querySelector('.osdMediaInfo').innerHTML = '';
    }

    function destroy() {
        if (recordingButtonManager) {
            recordingButtonManager.destroy();
            recordingButtonManager = null;
        }
    }

    return { getDisplayItem, update, clear, destroy };
}
