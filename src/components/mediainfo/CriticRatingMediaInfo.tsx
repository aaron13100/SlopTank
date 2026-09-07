import React, { type FC } from 'react';
import classNames from 'classnames';
import Box from '@mui/material/Box';
import globalize from 'lib/globalize';

interface CriticRatingMediaInfoProps {
    className?: string;
    criticRating: number;
}

const CriticRatingMediaInfo: FC<CriticRatingMediaInfoProps> = ({
    className,
    criticRating
}) => {
    const cssClass = classNames(
        'mediaInfoCriticRating',
        'mediaInfoItem',
        criticRating >= 60 ?
            'mediaInfoCriticRatingPositive' :
            'mediaInfoCriticRatingNegative',
        className
    );
    const ratingLabel = `${globalize.translate('LabelCriticRating')}: ${criticRating}`;

    return (
        <Box className={cssClass} aria-label={ratingLabel}>
            <span className='mediaInfoCriticRatingSymbol' aria-hidden='true'>
                {criticRating >= 60 ? '+' : '−'}
            </span>
            {criticRating}
        </Box>
    );
};

export default CriticRatingMediaInfo;
