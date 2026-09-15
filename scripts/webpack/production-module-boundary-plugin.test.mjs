// SlopTank modification notice: added by SlopTank on 2026-09-15.
/**
 * Exercises ProductionModuleBoundaryPlugin through the real surface a
 * production build relies on: a webpack compilation. Each case builds a
 * small fixture project in a temporary directory with its own
 * package-lock.json and node_modules, then asserts the compile either
 * refuses with the named violation or completes clean.
 *
 * The clean cases are not padding: every one of them is a false positive
 * this plugin produced on 2026-09-15, the first production build it ever
 * gated (css-loader runtime glue, expose-loader runtime glue, core-js's
 * es.regexp.test.js polyfill, the hoisted entities@2 copy serving
 * markdown-it). The refusal cases pin the protections that must survive:
 * first-party test sources, authored dev-only imports, unclassified
 * packages, and dev-only copied assets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';

import ProductionModuleBoundaryPlugin from './production-module-boundary-plugin.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function writeFixturePackage(nodeModulesDir, name, files) {
    const packageDir = path.join(nodeModulesDir, name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name,
        version: '1.0.0',
        main: 'index.js'
    }, null, 2));
    for (const [fileName, content] of Object.entries(files)) {
        const target = path.join(packageDir, fileName);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return packageDir;
}

function writeFixtureLock(root, { dev = [], prod = [] } = {}) {
    const packages = {
        '': { name: 'fixture', version: '0.0.0', dependencies: {}, devDependencies: {} }
    };
    for (const name of prod) {
        packages[`node_modules/${name}`] = { version: '1.0.0', resolved: 'https://registry.example/x', dev: undefined };
    }
    for (const name of dev) {
        packages[`node_modules/${name}`] = { version: '1.0.0', resolved: 'https://registry.example/x', dev: true };
    }
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }, null, 2));
}

function fixtureProject({ entrySource, packages = {}, lock = {}, additionalResources = [] }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-boundary-'));
    const nodeModulesDir = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    for (const [name, files] of Object.entries(packages)) {
        writeFixturePackage(nodeModulesDir, name, files);
    }
    writeFixtureLock(root, lock);
    fs.writeFileSync(path.join(srcDir, 'index.js'), entrySource);

    const compiler = webpack({
        context: srcDir,
        mode: 'development',
        target: 'node',
        entry: './index.js',
        output: { path: path.join(root, 'dist'), filename: 'bundle.js' },
        plugins: [
            new ProductionModuleBoundaryPlugin({
                projectRoot: root,
                packageLockFile: path.join(root, 'package-lock.json'),
                additionalResources: additionalResources.map(name =>
                    path.join(nodeModulesDir, name, 'index.js'))
            })
        ]
    });
    return { root, compiler };
}

function runCompile(compiler) {
    return new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            if (error) {
                reject(error);
                return;
            }
            if (stats.hasErrors()) {
                reject(new Error(stats.toJson().errors.map(e => e.message).join('\n')));
                return;
            }
            resolve(stats);
        });
    });
}

test('refuses a first-party test source in the module graph', async () => {
    const { compiler } = fixtureProject({
        entrySource: "import './helper.test.js'; import { one } from 'fixture-prod-dep'; console.log(one);\n",
        packages: {
            'fixture-prod-dep': { 'index.js': 'module.exports = { one: 1 };\n' }
        },
        lock: { prod: ['fixture-prod-dep'] }
    });
    fs.writeFileSync(path.join(compiler.options.context, 'helper.test.js'), 'export const x = 1;\n');
    await assert.rejects(runCompile(compiler), /test source: src\/helper\.test\.js/);
});

test('refuses an authored bare import of a dev-only package', async () => {
    const { compiler } = fixtureProject({
        entrySource: "import { probe } from 'fixture-test-framework'; console.log(probe);\n",
        packages: {
            'fixture-test-framework': { 'index.js': 'module.exports = { probe: 1 };\n' }
        },
        lock: { dev: ['fixture-test-framework'] }
    });
    await assert.rejects(runCompile(compiler), /dev-only package: node_modules\/fixture-test-framework/);
});

test('refuses an unclassified package not present in the lock', async () => {
    const { compiler } = fixtureProject({
        entrySource: "import { one } from 'fixture-unknown-dep'; console.log(one);\n",
        packages: {
            'fixture-unknown-dep': { 'index.js': 'module.exports = { one: 1 };\n' }
        },
        lock: {}
    });
    await assert.rejects(runCompile(compiler), /unclassified package: node_modules\/fixture-unknown-dep/);
});

test('refuses a dev-only package listed as a copied asset', async () => {
    const { compiler } = fixtureProject({
        entrySource: "import { one } from 'fixture-prod-dep'; console.log(one);\n",
        packages: {
            'fixture-prod-dep': { 'index.js': 'module.exports = { one: 1 };\n' },
            'fixture-copied-dev': { 'index.js': 'module.exports = { two: 2 };\n' }
        },
        lock: { prod: ['fixture-prod-dep'], dev: ['fixture-copied-dev'] },
        additionalResources: ['fixture-copied-dev']
    });
    await assert.rejects(runCompile(compiler), /dev-only package: node_modules\/fixture-copied-dev/);
});

test('allows loader-style runtime glue: relative require from first-party issuer into a dev-flagged package', async () => {
    // css-loader's exact shape on 2026-09-15: compiled theme.scss (a
    // first-party module) requiring css-loader/dist/runtime/api.js by a
    // relative path that the loader generated, not an author wrote.
    const { compiler } = fixtureProject({
        entrySource: [
            "import { one } from 'fixture-prod-dep';",
            "const glue = require('../node_modules/fixture-loader-glue/index.js');",
            'console.log(one, glue);'
        ].join('\n'),
        packages: {
            'fixture-prod-dep': { 'index.js': 'module.exports = { one: 1 };\n' },
            'fixture-loader-glue': { 'index.js': 'module.exports = 2;\n' }
        },
        lock: { prod: ['fixture-prod-dep'], dev: ['fixture-loader-glue'] }
    });
    await runCompile(compiler);
});

test('allows a third-party package resolving a dev-flagged hoisted copy by bare name', async () => {
    // entities' exact shape on 2026-09-15: markdown-it (prod) requires
    // "entities" (bare), which resolves to the dev-flagged root copy the
    // hoisted layout left behind. No first-party author chose it.
    const { compiler } = fixtureProject({
        entrySource: "import { lib } from 'fixture-prod-consumer'; console.log(lib);\n",
        packages: {
            'fixture-prod-consumer': { 'index.js': "const entities = require('fixture-hoisted-dev'); module.exports = { lib: entities };\n" },
            'fixture-hoisted-dev': { 'index.js': 'module.exports = { decode: () => {} };\n' }
        },
        lock: { prod: ['fixture-prod-consumer'], dev: ['fixture-hoisted-dev'] }
    });
    await runCompile(compiler);
});

test('refuses importing a test directory inside a production package', async () => {
    // A package's test/ directory is test code whatever the lock says about
    // the package; only the filename suffix heuristic is first-party-only.
    const { compiler } = fixtureProject({
        entrySource: "import { helper } from 'fixture-prod-lib/test/helper.js'; console.log(helper);\n",
        packages: {
            'fixture-prod-lib': {
                'index.js': 'module.exports = 1;\n',
                'test/helper.js': 'module.exports = 2;\n'
            }
        },
        lock: { prod: ['fixture-prod-lib'] }
    });
    await assert.rejects(runCompile(compiler), /test source: node_modules\/fixture-prod-lib\/test\/helper\.js/);
});

test('refuses a dev-only package used directly as an absolute webpack entry', async () => {
    // Entry modules have no issuer; their request is webpack configuration
    // and counts as authored whatever path shape it uses.
    const { root } = fixtureProject({
        entrySource: "import { one } from 'fixture-prod-dep'; console.log(one);\n",
        packages: {
            'fixture-prod-dep': { 'index.js': 'module.exports = { one: 1 };\n' },
            'fixture-dev-entry': { 'index.js': 'module.exports = { probe: 1 };\n' }
        },
        lock: { prod: ['fixture-prod-dep'], dev: ['fixture-dev-entry'] }
    });
    const entryCompiler = webpack({
        context: path.join(root, 'src'),
        mode: 'development',
        target: 'node',
        entry: path.join(root, 'node_modules', 'fixture-dev-entry', 'index.js'),
        output: { path: path.join(root, 'dist'), filename: 'bundle.js' },
        plugins: [
            new ProductionModuleBoundaryPlugin({
                projectRoot: root,
                packageLockFile: path.join(root, 'package-lock.json')
            })
        ]
    });
    await assert.rejects(runCompile(entryCompiler), /dev-only package: node_modules\/fixture-dev-entry/);
});

test('allows a production package shipping an internal module named like a test file', async () => {
    // core-js's exact shape on 2026-09-15: core-js/stable requires
    // modules/es.regexp.test.js, the RegExp.prototype.test polyfill.
    const { compiler } = fixtureProject({
        entrySource: "import { stable } from 'fixture-polyfill-lib'; console.log(stable);\n",
        packages: {
            'fixture-polyfill-lib': {
                'index.js': "const polyfill = require('./modules/es.regexp.test.js'); module.exports = { stable: polyfill };\n",
                'modules/es.regexp.test.js': 'module.exports = RegExp.prototype.test;\n'
            }
        },
        lock: { prod: ['fixture-polyfill-lib'] }
    });
    await runCompile(compiler);
});

test('isFirstPartyRelativePath treats node_modules and outside paths as third-party', () => {
    assert.equal(ProductionModuleBoundaryPlugin.isFirstPartyRelativePath('src/index.js'), true);
    assert.equal(ProductionModuleBoundaryPlugin.isFirstPartyRelativePath('src/__tests__/x.js'), true);
    assert.equal(ProductionModuleBoundaryPlugin.isFirstPartyRelativePath('node_modules/entities/lib/index.js'), false);
    assert.equal(ProductionModuleBoundaryPlugin.isFirstPartyRelativePath('node_modules/a/node_modules/b/index.js'), false);
    assert.equal(ProductionModuleBoundaryPlugin.isFirstPartyRelativePath('../outside/index.js'), false);
});

test('isBareRequest separates authored imports from loader-emitted relative requires', () => {
    assert.equal(ProductionModuleBoundaryPlugin.isBareRequest('entities'), true);
    assert.equal(ProductionModuleBoundaryPlugin.isBareRequest('@scope/pkg'), true);
    assert.equal(ProductionModuleBoundaryPlugin.isBareRequest('../../css-loader/dist/runtime/api.js'), false);
    assert.equal(ProductionModuleBoundaryPlugin.isBareRequest('/abs/path.js'), false);
    assert.equal(ProductionModuleBoundaryPlugin.isBareRequest(null), false);
    assert.equal(ProductionModuleBoundaryPlugin.isBareRequest(undefined), false);
});
