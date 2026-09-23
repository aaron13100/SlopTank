// SlopTank modification notice: added or changed by SlopTank on 2026-09-23.
import datetime from '../../scripts/datetime';
import loading from '../loading/loading';
import toast from '../toast/toast';
import alert from '../alert';
import globalize from '../../lib/globalize';

/**
 * The metadata editor's submission workflow, extracted from
 * metadataEditor.js: read the submitted form into the item DTO the Items
 * update endpoint expects, persist it through the api client, and report
 * the outcome. Success keeps the historical toast-and-close behavior; a
 * refusal hides the loading layer and surfaces the server's ProblemDetails
 * code and detail through the alert seam, because a rejected save that
 * leaves the spinner up is the never-ending-spinner defect observed in
 * production on 2026-09-21 (a 409 content-mismatch fence was swallowed by
 * an unhandled promise rejection).
 */

/**
 * Reads the checked air-day entries from the editor form.
 *
 * @param {HTMLFormElement} form - The submitted metadata editor form.
 * @returns {string[]} The selected air-day identifiers.
 */
function getSelectedAirDays(form) {
    const checkedItems = form.querySelectorAll('.chkAirDay:checked') || [];
    return Array.prototype.map.call(checkedItems, function (c) {
        return c.getAttribute('data-day');
    });
}

/**
 * Reads the album artists entry, splitting the semicolon list.
 *
 * @param {HTMLFormElement} form - The submitted metadata editor form.
 * @returns {{Name: string}[]} The parsed album artists.
 */
function getAlbumArtists(form) {
    return form.querySelector('#txtAlbumArtist').value.trim().split(';').filter(function (s) {
        return s.length > 0;
    }).map(function (a) {
        return {
            Name: a
        };
    });
}

/**
 * Reads the artists entry, splitting the semicolon list.
 *
 * @param {HTMLFormElement} form - The submitted metadata editor form.
 * @returns {{Name: string}[]} The parsed artists.
 */
function getArtists(form) {
    return form.querySelector('#txtArtist').value.trim().split(';').filter(function (s) {
        return s.length > 0;
    }).map(function (a) {
        return {
            Name: a
        };
    });
}

/**
 * Reads one date input, preserving the stored time when the date part is
 * unchanged so an edit does not zero the time component.
 *
 * @param {HTMLFormElement} form - The submitted metadata editor form.
 * @param {string} element - The input selector to read.
 * @param {string} property - The current item property holding the stored date.
 * @param {object} currentItem - The item the editor is editing.
 * @returns {string|null} The date value for the update DTO.
 */
function getDateValue(form, element, property, currentItem) {
    let val = form.querySelector(element).value;

    if (!val) {
        return null;
    }

    if (currentItem[property]) {
        const date = datetime.parseISO8601Date(currentItem[property], true);

        const parts = date.toISOString().split('T');

        // If the date is the same, preserve the time
        if (parts[0].startsWith(val)) {
            const iso = parts[1];

            val += 'T' + iso;
        }
    }

    return val;
}

/**
 * Reads the text values out of one editable list view.
 *
 * @param {HTMLElement} list - The list view element.
 * @returns {string[]} The list's current values.
 */
export function getListValues(list) {
    return Array.prototype.map.call(list.querySelectorAll('.textValue'), function (el) {
        return el.textContent;
    });
}

/**
 * Builds the item update DTO from the submitted editor form.
 *
 * @param {HTMLFormElement} form - The submitted metadata editor form.
 * @param {object} currentItem - The item being edited, for the fields the
 * form does not carry (people, provider ids, item type).
 * @returns {object} The DTO for the Items update endpoint.
 */
export function readItemFromForm(form, currentItem) {
    const item = {
        Id: currentItem.Id,
        Name: form.querySelector('#txtName').value,
        OriginalTitle: form.querySelector('#txtOriginalName').value,
        ForcedSortName: form.querySelector('#txtSortName').value,
        CommunityRating: form.querySelector('#txtCommunityRating').value,
        CriticRating: form.querySelector('#txtCriticRating').value,
        IndexNumber: form.querySelector('#txtIndexNumber').value || null,
        AirsBeforeSeasonNumber: form.querySelector('#txtAirsBeforeSeason').value,
        AirsAfterSeasonNumber: form.querySelector('#txtAirsAfterSeason').value,
        AirsBeforeEpisodeNumber: form.querySelector('#txtAirsBeforeEpisode').value,
        ParentIndexNumber: form.querySelector('#txtParentIndexNumber').value || null,
        DisplayOrder: form.querySelector('#selectDisplayOrder').value,
        Album: form.querySelector('#txtAlbum').value,
        AlbumArtists: getAlbumArtists(form),
        ArtistItems: getArtists(form),
        Overview: form.querySelector('#txtOverview').value,
        Status: form.querySelector('#selectStatus').value,
        AirDays: getSelectedAirDays(form),
        AirTime: form.querySelector('#txtAirTime').value,
        Genres: getListValues(form.querySelector('#listGenres')),
        Tags: getListValues(form.querySelector('#listTags')),
        Studios: getListValues(form.querySelector('#listStudios')).map(function (element) {
            return { Name: element };
        }),

        PremiereDate: getDateValue(form, '#txtPremiereDate', 'PremiereDate', currentItem),
        DateCreated: getDateValue(form, '#txtDateAdded', 'DateCreated', currentItem),
        EndDate: getDateValue(form, '#txtEndDate', 'EndDate', currentItem),
        ProductionYear: form.querySelector('#txtProductionYear').value,
        Height: form.querySelector('#selectHeight').value,
        AspectRatio: form.querySelector('#txtOriginalAspectRatio').value,
        Video3DFormat: form.querySelector('#select3dFormat').value,

        OfficialRating: form.querySelector('#selectOfficialRating').value,
        CustomRating: form.querySelector('#selectCustomRating').value,
        People: currentItem.People,
        LockData: form.querySelector('#chkLockData').checked,
        LockedFields: Array.prototype.filter.call(form.querySelectorAll('.selectLockedField'), function (c) {
            return !c.checked;
        }).map(function (c) {
            return c.getAttribute('data-value');
        })
    };

    item.ProviderIds = { ...currentItem.ProviderIds };

    const idElements = form.querySelectorAll('.txtExternalId');
    Array.prototype.map.call(idElements, function (idElem) {
        const providerKey = idElem.getAttribute('data-providerkey');
        item.ProviderIds[providerKey] = idElem.value;
    });

    item.PreferredMetadataLanguage = form.querySelector('#selectLanguage').value;
    item.PreferredMetadataCountryCode = form.querySelector('#selectCountry').value;

    if (currentItem.Type === 'Person') {
        const placeOfBirth = form.querySelector('#txtPlaceOfBirth').value;

        item.ProductionLocations = placeOfBirth ? [placeOfBirth] : [];
    }

    if (currentItem.Type === 'Series') {
        // 600000000
        const seriesRuntime = form.querySelector('#txtSeriesRuntime').value;
        item.RunTimeTicks = seriesRuntime ? (seriesRuntime * 600000000) : null;
    }

    const tagline = form.querySelector('#txtTagline').value;
    item.Taglines = tagline ? [tagline] : [];

    return item;
}

/**
 * Persists the edited item and reports the outcome.
 *
 * @param {object} apiClient - The api client for the item's server.
 * @param {HTMLFormElement} form - The submitted form, read for the content
 * type follow-up call.
 * @param {object} item - The update DTO from readItemFromForm.
 * @param {object} options - Submission context: metadataEditorInfo carries
 * the editor's current content type, and onSaved closes the editor after a
 * successful save.
 * @returns {void} The outcome arrives through toast, loading, alert, and
 * onSaved; this function deliberately does not chain a promise so callers
 * keep the historical fire-and-forget submit semantics.
 */
export function submitUpdatedItem(apiClient, form, item, options) {
    function afterContentTypeUpdated() {
        toast(globalize.translate('MessageItemSaved'));

        loading.hide();
        options.onSaved();
    }

    apiClient.updateItem(item).then(function () {
        const newContentType = form.querySelector('#selectContentType').value || '';

        if ((options.metadataEditorInfo.ContentType || '') !== newContentType) {
            apiClient.ajax({

                url: apiClient.getUrl('Items/' + item.Id + '/ContentType', {
                    ContentType: newContentType
                }),

                type: 'POST'

            }).then(function () {
                afterContentTypeUpdated();
            }).catch(reportSaveFailure);
        } else {
            afterContentTypeUpdated();
        }
    }).catch(reportSaveFailure);
}

/**
 * Ends the loading layer and shows the server's refusal. The rejection is
 * the raw fetch Response for HTTP errors, so its body carries the
 * ProblemDetails title (the server's error code, such as content-mismatch)
 * and detail (the human-readable cause).
 *
 * @param {object} error - The rejected update result.
 * @returns {void}
 */
function reportSaveFailure(error) {
    loading.hide();
    resolveFailureText(error).then(function (text) {
        alert(text, globalize.translate('HeaderError'));
    });
}

/**
 * Composes the user-facing refusal text: the translated generic framing
 * with the underlying code (and detail) in parentheses, per the
 * error-visibility rule. Anything unreadable degrades to the framing plus
 * the HTTP status, never to a canned string that hides the cause.
 *
 * @param {object} error - The rejected update result.
 * @returns {Promise<string>} The resolved message text.
 */
function resolveFailureText(error) {
    const framing = globalize.translate('ErrorDefault');
    const status = error?.status;
    if (error && typeof error.json === 'function') {
        return error.json().then(function (problem) {
            const code = problem?.title ? String(problem.title) : 'HTTP ' + status;
            const detail = problem?.detail ? String(problem.detail) : '';
            return detail ? framing + ' (' + code + ': ' + detail + ')' : framing + ' (' + code + ')';
        }).catch(function () {
            return withStatus(framing, status);
        });
    }

    return Promise.resolve(withStatus(framing, status));
}

/**
 * Appends the HTTP status to the framing when one is known.
 *
 * @param {string} framing - The translated generic message.
 * @param {number|undefined} status - The HTTP status, when present.
 * @returns {string} The composed message.
 */
function withStatus(framing, status) {
    return status ? framing + ' (HTTP ' + status + ')' : framing;
}
