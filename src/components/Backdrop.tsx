// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
import React, { useEffect } from 'react';
import { loadDynamicModule } from 'utils/dynamicImport';

const Backdrop = () => {
    useEffect(() => {
        // Initialize the UI components after first render
        void loadDynamicModule(() => import('../scripts/autoBackdrops'), '../scripts/autoBackdrops');
    }, []);

    return (
        <>
            <div className='backdropContainer' />
            <div className='backgroundContainer' />
        </>
    );
};

export default Backdrop;
