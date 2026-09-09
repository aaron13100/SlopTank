// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-09-09.
import React, { createContext, type FC, type PropsWithChildren, useContext } from 'react';

const CanonicalLibraryIdContext = createContext<string | null>(null);

export const CanonicalLibraryProvider: FC<PropsWithChildren<{ libraryId: string }>> = ({
    children,
    libraryId
}) => (
    <CanonicalLibraryIdContext.Provider value={libraryId}>
        {children}
    </CanonicalLibraryIdContext.Provider>
);

export const useCanonicalLibraryId = () => useContext(CanonicalLibraryIdContext);
