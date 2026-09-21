// SlopTank modification notice: added or changed by SlopTank on 2026-09-22.
import React from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';

import SectionTabs from '../../../../components/dashboard/users/SectionTabs';
import UserPasswordForm from '../../../../components/dashboard/users/UserPasswordForm';
import SectionTitleContainer from '../../../../elements/SectionTitleContainer';
import Page from '../../../../components/Page';
import { useUser } from 'apps/dashboard/features/users/api/useUser';
import Loading from 'components/loading/LoadingComponent';

const UserPassword = () => {
    const [ searchParams ] = useSearchParams();
    // Bare /web/dashboard/users/password URLs (typed, bookmarked, pasted) carry
    // no userId, and a disabled useUser query stays pending forever, which used
    // to render an endless spinner here. Fall back to the logged-in user: the
    // admin opening "the password page" means their own, and the form titles
    // itself with the resolved user so the subject is never ambiguous.
    const userId = searchParams.get('userId') || window.ApiClient.getCurrentUserId();
    const { data: user, isPending, isError } = useUser(userId ? { userId: userId } : undefined);

    // Every branch below is bounded: an unresolvable user redirects to the user
    // picker instead of spinning, and the Loading state only covers a query that
    // is actually running and will settle.
    if (!userId || isError || (!isPending && !user)) {
        return <Navigate to='/web/dashboard/users' replace />;
    }

    if (isPending) {
        return <Loading />;
    }

    return (
        <Page
            id='userPasswordPage'
            className='mainAnimatedPage type-interior userPasswordPage'
        >
            <div className='content-primary'>
                <div className='verticalSection'>
                    <SectionTitleContainer
                        title={user?.Name || undefined}
                    />
                </div>
                <SectionTabs activeTab='userpassword'/>
                <div className='readOnlyContent'>
                    <UserPasswordForm
                        user={user}
                    />
                </div>
            </div>
        </Page>

    );
};

export default UserPassword;
