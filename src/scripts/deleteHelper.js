// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.

import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';

import alert from 'components/alert';
import confirm from 'components/confirm/confirm';
import { appRouter } from 'components/router/appRouter';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';

function alertText(options) {
    return alert(options);
}

function getDeletionConfirmContent(item) {
    if (item.Type === BaseItemKind.Series) {
        const totalEpisodes = item.RecursiveItemCount;
        return {
            title: globalize.translate('HeaderDeleteSeries'),
            text: globalize.translate('ConfirmDeleteSeries', totalEpisodes),
            confirmText: globalize.translate('DeleteEntireSeries', totalEpisodes),
            primary: 'delete'
        };
    }

    if (item.Type === BaseItemKind.BoxSet) {
        return {
            title: globalize.translate('HeaderDeleteCollection'),
            text: globalize.translate('ConfirmDeleteCollection'),
            confirmText: globalize.translate('Delete'),
            primary: 'delete'
        };
    }

    if (item.Type === BaseItemKind.Playlist) {
        return {
            title: globalize.translate('HeaderDeletePlaylist'),
            text: globalize.translate('ConfirmDeletePlaylist'),
            confirmText: globalize.translate('Delete'),
            primary: 'delete'
        };
    }

    return {
        title: globalize.translate('HeaderDeleteItem'),
        text: globalize.translate('ConfirmDeleteItem'),
        confirmText: globalize.translate('Delete'),
        primary: 'delete'
    };
}

/**
 * Extracts the server's real refusal reason from a delete rejection.
 *
 * The server answers a refused delete with a typed ProblemDetails body whose
 * title is the refusal code (for example "content-mismatch" when the
 * permalink capsule no longer matches the file). Asserting a permissions
 * cause the server never stated sent the owner checking folder write access
 * for a fence that has nothing to do with it. Pure: takes the rejection,
 * returns a suffix; the caller composes it after the translated framing.
 *
 * @param {Error|Response|null} err - The rejection from the api client.
 * @returns {Promise<string>} The parenthesized reason, or '' when nothing
 * usable is present.
 */
export function deleteErrorSuffix(err) {
    return Promise.resolve()
        .then(function () {
            if (err && typeof err.text === 'function') {
                return err.text().then(function (bodyText) {
                    try {
                        const parsed = JSON.parse(bodyText);
                        const code = parsed && parsed.title;
                        const detail = parsed && parsed.detail;
                        if (code || detail) {
                            return ` (${[code, detail].filter(Boolean).join(': ')})`;
                        }
                    } catch {
                        if (bodyText) {
                            return ` (${String(bodyText).slice(0, 300)})`;
                        }
                    }

                    return err.status ? ` (HTTP ${err.status})` : '';
                });
            }

            if (err && err.status) {
                return ` (HTTP ${err.status})`;
            }

            return err && err.message ? ` (${err.message})` : '';
        })
        .catch(function () {
            return '';
        });
}

/**
 * Translation keys for the delete-failure framing, by what was being deleted.
 *
 * The legacy ErrorDeletingItem / ErrorDeletingLyrics keys still carry a
 * "check write access to the media folder" guess in the translated locales,
 * so the framing resolves through keys only en-us defines; every other
 * locale falls back to the en-us text until it is translated afresh.
 */
export const DELETE_FAILURE_MESSAGE_KEYS = Object.freeze({
    item: 'DeleteItemFailedServerReason',
    lyrics: 'DeleteLyricsFailedServerReason'
});

/**
 * Composes the full user-facing delete failure text.
 *
 * @param {Error|Response|null} err - The rejection from the api client.
 * @param {string} [kind='item'] - A key of DELETE_FAILURE_MESSAGE_KEYS.
 * @returns {Promise<string>} The composed alert text.
 * @throws {TypeError} When kind is not a key of DELETE_FAILURE_MESSAGE_KEYS.
 */
export function describeDeleteError(err, kind = 'item') {
    if (!Object.prototype.hasOwnProperty.call(DELETE_FAILURE_MESSAGE_KEYS, kind)) {
        throw new TypeError(`Unknown delete failure kind '${kind}'`);
    }

    const key = DELETE_FAILURE_MESSAGE_KEYS[kind];
    return deleteErrorSuffix(err).then(function (suffix) {
        return globalize.translate(key) + suffix;
    });
}

export function deleteItem(options) {
    const item = options.item;
    const parentId = item.SeasonId || item.SeriesId || item.ParentId;

    const apiClient = ServerConnections.getApiClient(item.ServerId);

    return confirm(getDeletionConfirmContent(item)).then(function () {
        return apiClient.deleteItem(item.Id).then(function () {
            if (options.navigate) {
                if (parentId) {
                    appRouter.showItem(parentId, item.ServerId);
                } else {
                    appRouter.goHome();
                }
            }
        }, function (err) {
            const result = function () {
                return Promise.reject(err);
            };

            return describeDeleteError(err).then(function (text) {
                return alertText(text).then(result, result);
            });
        });
    });
}

export function deleteLyrics (item) {
    return confirm({
        title: globalize.translate('HeaderDeleteLyrics'),
        text: globalize.translate('ConfirmDeleteLyrics'),
        confirmText: globalize.translate('Delete'),
        primary: 'delete'
    }).then(() => {
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        return apiClient.ajax({
            url: apiClient.getUrl('Audio/' + item.Id + '/Lyrics'),
            type: 'DELETE'
        }).catch((err) => {
            const result = function () {
                return Promise.reject(err);
            };

            return describeDeleteError(err, 'lyrics').then(function (text) {
                return alertText(text).then(result, result);
            });
        });
    });
}

export default {
    deleteItem,
    deleteLyrics
};
