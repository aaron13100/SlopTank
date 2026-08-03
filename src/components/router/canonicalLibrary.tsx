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
