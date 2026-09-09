// SlopTank modification notice: added or changed by SlopTank on 2026-07-22, 2026-09-09.
import type { ColorSystemOptions } from '@mui/material/styles';
import merge from 'lodash-es/merge';

import { DEFAULT_COLOR_SCHEME } from '../_base/theme';

/** The default "Dark" color scheme. */
const theme = merge<ColorSystemOptions, ColorSystemOptions, ColorSystemOptions>(
    {},
    DEFAULT_COLOR_SCHEME,
    {
        palette: {
            primary: {
                main: '#39e6c3',
                contrastText: '#03110f'
            },
            secondary: {
                main: '#ff8b6a'
            },
            background: {
                default: '#071018',
                paper: '#0e1d2a'
            },
            text: {
                primary: '#eefcff',
                secondary: 'rgba(222, 243, 247, 0.74)'
            },
            action: {
                focus: 'rgba(57, 230, 195, 0.2)',
                hover: 'rgba(57, 230, 195, 0.1)',
                selectedOpacity: 0.18
            },
            AppBar: {
                defaultBg: '#0b1722'
            },
            Button: {
                inheritContainedBg: '#162938',
                inheritContainedHoverBg: '#1d3547'
            },
            FilledInput: {
                bg: 'rgba(238, 252, 255, 0.08)'
            },
            SnackbarContent: {
                bg: '#142938',
                color: '#eefcff'
            }
        }
    }
);

export default theme;
