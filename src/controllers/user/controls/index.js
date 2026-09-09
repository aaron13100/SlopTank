// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
import layoutManager from 'components/layoutManager';
import toast from '../../../components/toast/toast';
import globalize from '../../../lib/globalize';
import appSettings from '../../../scripts/settings/appSettings';
import Events from '../../../utils/events.ts';
import keyboardNavigation from 'scripts/keyboardNavigation';
import { loadDynamicModule } from 'utils/dynamicImport';

export default function (view) {
    function submit(e) {
        appSettings.enableGamepad(view.querySelector('.chkEnableGamepad').checked);
        appSettings.enableSmoothScroll(view.querySelector('.chkSmoothScroll').checked);

        toast(globalize.translate('SettingsSaved'));

        Events.trigger(view, 'saved');

        e?.preventDefault();

        return false;
    }

    view.addEventListener('viewshow', function () {
        view.querySelector('.enableGamepadContainer').classList.toggle('hide', !keyboardNavigation.canEnableGamepad());
        view.querySelector('.smoothScrollContainer').classList.toggle('hide', !layoutManager.tv);

        view.querySelector('.chkEnableGamepad').checked = appSettings.enableGamepad();
        view.querySelector('.chkSmoothScroll').checked = appSettings.enableSmoothScroll();

        view.querySelector('form').addEventListener('submit', submit);
        view.querySelector('.btnSave').classList.remove('hide');

        loadDynamicModule(() => import('../../../components/autoFocuser'),
            '../../../components/autoFocuser').then(({ default: autoFocuser }) => {
            autoFocuser.autoFocus(view);
        });
    });
}
