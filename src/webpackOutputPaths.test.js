// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-09-09.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const devConfig = require('../webpack.dev.js');
const productionConfig = require('../webpack.prod.js');

describe('webpack output paths', () => {
    it('keeps dev-server cleanup away from the deployed production build', () => {
        expect(devConfig.output.path).toBe(path.join(projectRoot, '.webpack-dev'));
        expect(productionConfig.output.path).toBe(path.join(projectRoot, 'dist'));
        expect(devConfig.output.path).not.toBe(productionConfig.output.path);
    });

    it('serves the web app and Jellyfin API from the production-shaped dev origin', () => {
        expect(devConfig.output.publicPath).toBe('/web/');
        expect(devConfig.devServer.devMiddleware.publicPath).toBe('/web/');

        const [ proxy ] = devConfig.devServer.proxy;
        expect(proxy.target).toBe('http://127.0.0.1:8096');
        expect(proxy.ws).toBe(true);
        expect(proxy.context('/web/')).toBe(false);
        expect(proxy.context('/ws')).toBe(false);
        expect(proxy.context('/System/Info/Public')).toBe(true);
        expect(proxy.context('/socket')).toBe(true);
    });
});
