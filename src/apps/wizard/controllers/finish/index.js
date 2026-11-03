// SlopTank modification notice: added or changed by SlopTank on 2026-11-03.
import loading from 'components/loading/loading';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import globalize from 'lib/globalize';
import { completeStartupWizard, formatStartupWizardError } from 'apps/wizard/startupApi';

let isFinishing = false;

async function onFinish() {
    if (isFinishing) {
        return;
    }

    isFinishing = true;
    const page = document.getElementById('wizardFinishPage');
    const button = page.querySelector('.btnWizardNext');
    const error = page.querySelector('#wizardFinishError');
    button.disabled = true;
    error.textContent = '';
    error.classList.add('hide');
    loading.show();

    try {
        await completeStartupWizard(ServerConnections.currentApiClient());
        window.location.href = '';
    } catch (cause) {
        error.textContent = await formatStartupWizardError(cause, globalize.translate('WizardSetupCompleteFailed'));
        error.classList.remove('hide');
        isFinishing = false;
        button.disabled = false;
        loading.hide();
    }
}

export default function (view) {
    view.querySelector('.btnWizardNext').addEventListener('click', onFinish);
}
