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
