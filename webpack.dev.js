const { merge } = require('webpack-merge');
const path = require('path');

const common = require('./webpack.common');

module.exports = merge(common, {
    // CleanWebpackPlugin runs when the dev server starts. Keep its output path
    // separate so `npm run serve` can never erase the deployed production build.
    output: {
        path: path.resolve(__dirname, '.webpack-dev'),
        publicPath: '/web/'
    },
    // In order for live reload to work we must use "web" as the target not "browserslist"
    target: process.env.WEBPACK_SERVE ? 'web' : 'browserslist',
    mode: 'development',
    entry: {
        ...common.entry,
        'serviceworker': './serviceworker.js'
    },
    devtool: 'eval-cheap-module-source-map',
    module: {
        rules: [
            {
                test: /\.(js|jsx|ts|tsx)$/,
                exclude: /node_modules/,
                enforce: 'pre',
                use: ['source-map-loader']
            }
        ]
    },
    devServer: {
        compress: true,
        client: {
            overlay: {
                errors: true,
                warnings: false
            }
        },
        devMiddleware: {
            publicPath: '/web/'
        },
        headers: {
            'Service-Worker-Allowed': '/'
        },
        historyApiFallback: {
            index: '/web/index.html',
            disableDotRule: false
        },
        proxy: [
            {
                context: pathname => {
                    const apiRoots = /^\/(?:[A-Z][^/]*|videos|emby|health|socket|users)(?:\/|$)/;
                    return pathname === '/ws' || apiRoots.test(pathname);
                },
                target: 'http://127.0.0.1:8096',
                changeOrigin: true,
                ws: true
            }
        ]
    }
});
