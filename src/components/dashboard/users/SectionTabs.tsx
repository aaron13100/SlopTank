import React, { FunctionComponent } from 'react';

import globalize from 'lib/globalize';
import { navigate } from '../../../utils/dashboard';
import LinkButton from '../../../elements/emby-button/LinkButton';

type IProps = {
    activeTab: string;
};

function useNavigate(url: string): () => void {
    return React.useCallback(() => {
        navigate(url, true).catch(err => {
            console.warn('Error navigating to dashboard url', err);
        });
    }, [url]);
}

const SectionTabs: FunctionComponent<IProps> = ({ activeTab }: IProps) => {
    const onClickProfile = useNavigate('/web/dashboard/users/profile');
    const onClickAccess = useNavigate('/web/dashboard/users/access');
    const onClickParentalControl = useNavigate('/web/dashboard/users/parentalcontrol');
    const clickPassword = useNavigate('/web/dashboard/users/password');
    return (
        <div
            data-role='controlgroup'
            data-type='horizontal'
            className='localnav'>
            <LinkButton
                href='#'
                data-role='button'
                className={activeTab === 'useredit' ? 'ui-btn-active' : ''}
                onClick={onClickProfile}>
                {globalize.translate('Profile')}
            </LinkButton>
            <LinkButton
                href='#'
                data-role='button'
                className={activeTab === 'userlibraryaccess' ? 'ui-btn-active' : ''}
                onClick={onClickAccess}>
                {globalize.translate('TabAccess')}
            </LinkButton>
            <LinkButton
                href='#'
                data-role='button'
                className={activeTab === 'userparentalcontrol' ? 'ui-btn-active' : ''}
                onClick={onClickParentalControl}>
                {globalize.translate('TabParentalControl')}
            </LinkButton>
            <LinkButton
                href='#'
                data-role='button'
                className={activeTab === 'userpassword' ? 'ui-btn-active' : ''}
                onClick={clickPassword}>
                {globalize.translate('HeaderPassword')}
            </LinkButton>
        </div>
    );
};

export default SectionTabs;
