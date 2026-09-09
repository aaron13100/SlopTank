// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
import { useLocation, useSearchParams } from 'react-router-dom';

import { getDefaultViewIndex } from 'apps/experimental/features/libraries/utils/path';
import { useCanonicalLibraryId } from 'components/router/canonicalLibrary';

const useCurrentTab = () => {
    const location = useLocation();
    const canonicalLibraryId = useCanonicalLibraryId();
    const [searchParams, setSearchParams] = useSearchParams();
    const searchParamsTab = searchParams.get('tab');
    const libraryId =
        location.pathname === '/web/livetv' ?
            'livetv' :
            searchParams.get('topParentId') || canonicalLibraryId;
    const activeTab: number =
        searchParamsTab !== null ?
            parseInt(searchParamsTab, 10) :
            getDefaultViewIndex(location.pathname, libraryId);

    return {
        searchParams,
        setSearchParams,
        libraryId,
        activeTab
    };
};

export default useCurrentTab;
