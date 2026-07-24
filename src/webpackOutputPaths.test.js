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
});
