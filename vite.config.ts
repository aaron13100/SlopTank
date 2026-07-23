/// <reference types="vitest" />
/// <reference types="vite/client" />
import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * The webpack build imports component templates as strings via html-loader;
 * mirror that here so components with `import template from './x.html'` are
 * loadable under vitest without test-only indirection.
 */
function htmlAsString(): Plugin {
    return {
        name: 'html-as-string',
        enforce: 'pre',
        async load(id) {
            if (!id.endsWith('.html')) {
                return null;
            }
            const content = await readFile(id, 'utf8');
            return `export default ${JSON.stringify(content)};`;
        }
    };
}

export default defineConfig({
    // Mirror webpack.common.js's DefinePlugin globals so any module in the
    // app graph is loadable under vitest.
    define: {
        __COMMIT_SHA__: '"test"',
        __JF_BUILD_VERSION__: '"Test"',
        __PACKAGE_JSON_NAME__: '"sloptank-web"',
        __PACKAGE_JSON_VERSION__: '"0.0.0-test"',
        __USE_SYSTEM_FONTS__: false,
        __WEBPACK_SERVE__: false
    },
    plugins: [ tsconfigPaths(), htmlAsString() ],
    test: {
        include: [ 'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}' ],
        coverage: {
            include: [ 'src' ]
        },
        environment: 'jsdom',
        restoreMocks: true
    }
});
