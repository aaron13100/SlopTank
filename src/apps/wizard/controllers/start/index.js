// SlopTank modification notice: added or changed by SlopTank on 2026-11-03.
import loading from 'components/loading/loading';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Dashboard from 'utils/dashboard';
import dom from 'utils/dom';
import globalize from 'lib/globalize';
import {
    formatStartupWizardError,
    loadStartupWizardData,
    saveStartupWizardData,
    StartupWizardApiError
} from 'apps/wizard/startupApi';

import 'elements/emby-button/emby-button';
import 'elements/emby-input/emby-input';
import 'elements/emby-select/emby-select';

let currentConfiguration;
let isSubmitting = false;

function setError(page, message) {
    const error = page.querySelector('#wizardStartError');
    error.textContent = message;
    error.classList.remove('hide');
}

function clearError(page) {
    const error = page.querySelector('#wizardStartError');
    error.textContent = '';
    error.classList.add('hide');
}

function setSubmitting(form, submitting) {
    isSubmitting = submitting;
    form.querySelector('.button-submit').disabled = submitting;
    form.setAttribute('aria-busy', String(submitting));
    if (submitting) {
        loading.show();
    } else {
        loading.hide();
    }
}

function loadPage(page, systemInfo, configuration, languages, startupUser) {
    currentConfiguration = configuration;
    isSubmitting = false;
    page.querySelector('#txtServerName').value = configuration.ServerName || systemInfo.ServerName || '';
    page.querySelector('#txtUsername').value = startupUser.Name || '';

    const languageElem = page.querySelector('#selectLocalizationLanguage');
    languageElem.innerHTML = languages.map(function (language) {
        return '<option value="' + language.Value + '">' + language.Name + '</option>';
    }).join('');
    languageElem.value = configuration.UICulture || '';

    page.querySelector('.button-submit').disabled = false;
    page.querySelector('.wizardRetryLoad').classList.add('hide');
    loading.hide();
}

async function loadSetupPage(page) {
    clearError(page);
    const form = page.querySelector('.wizardStartForm');
    const retryButton = page.querySelector('.wizardRetryLoad');
    form.querySelector('.button-submit').disabled = true;
    retryButton.disabled = true;
    loading.show();

    try {
        const data = await loadStartupWizardData(ServerConnections.currentApiClient());
        loadPage(page, data.systemInfo, data.configuration, data.languages, data.startupUser);
    } catch (error) {
        loading.hide();
        form.querySelector('.button-submit').disabled = true;
        retryButton.disabled = false;
        retryButton.classList.remove('hide');
        setError(page, await formatStartupWizardError(error, globalize.translate('WizardSetupLoadFailed')));
    }
}

async function onSubmit(e) {
    e.preventDefault();
    const form = dom.parentWithClass(this, 'page').querySelector('.wizardStartForm');
    const page = dom.parentWithClass(form, 'page');
    if (isSubmitting) {
        return;
    }

    clearError(page);
    const password = form.querySelector('#txtManualPassword').value;
    const passwordConfirmation = form.querySelector('#txtPasswordConfirm').value;
    if (password !== passwordConfirmation) {
        const error = new StartupWizardApiError(
            'password-confirmation-mismatch',
            globalize.translate('WizardPasswordMismatch'),
            'Enter the same password in both password fields.'
        );
        setError(page, await formatStartupWizardError(error, globalize.translate('WizardSetupSaveFailed')));
        form.querySelector('#txtPasswordConfirm').focus();
        return;
    }

    setSubmitting(form, true);
    try {
        const configuration = { ...currentConfiguration };
        const serverName = form.querySelector('#txtServerName').value.trim();
        if (serverName) {
            configuration.ServerName = serverName;
        }
        configuration.UICulture = form.querySelector('#selectLocalizationLanguage').value;

        await saveStartupWizardData(ServerConnections.currentApiClient(), {
            configuration,
            user: {
                Name: form.querySelector('#txtUsername').value.trim(),
                Password: password
            }
        });

        form.querySelector('#txtManualPassword').value = '';
        form.querySelector('#txtPasswordConfirm').value = '';
        try {
            await Dashboard.navigate('wizard/library');
        } catch (cause) {
            throw new StartupWizardApiError(
                'wizard-library-navigation-failed',
                'The account was saved, but the library setup page could not be opened.',
                'Reload the page and continue with library setup.',
                cause
            );
        }
    } catch (error) {
        setError(page, await formatStartupWizardError(error, globalize.translate('WizardSetupSaveFailed')));
        setSubmitting(form, false);
    }
}

export default function (view) {
    view.querySelector('.wizardStartForm').addEventListener('submit', onSubmit);
    view.querySelector('.wizardRetryLoad').addEventListener('click', function () {
        loadSetupPage(view);
    });

    view.addEventListener('viewshow', function () {
        document.querySelector('.skinHeader').classList.add('noHomeButtonHeader');
        loadSetupPage(this);
    });

    view.addEventListener('viewhide', function () {
        document.querySelector('.skinHeader').classList.remove('noHomeButtonHeader');
    });
}
