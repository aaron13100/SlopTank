// SlopTank modification notice: added or changed by SlopTank on 2026-10-14.
const { merge } = require('webpack-merge');

const common = require('./webpack.common');

module.exports = merge(common, {
    mode: 'production',
    entry: {
        ...common.entry,
        'serviceworker': './serviceworker.js'
    }
});
