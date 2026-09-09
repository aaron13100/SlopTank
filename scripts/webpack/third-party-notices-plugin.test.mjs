// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-07, 2026-09-09.
/**
 * Exercises ThirdPartyNoticesPlugin through the real entry point a user
 * relies on: a webpack compilation. The integration test below runs an
 * actual (small) webpack build against fixture node_modules packages and
 * reads the emitted dist/LICENSE and dist/THIRD-PARTY-NOTICES.txt files,
 * the same artifacts `npm run build:production` is required to produce.
 * Calling the plugin's internal helpers directly is covered separately
 * below, but only as a supplement to, not a replacement for, the
 * compilation-level test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';

import ThirdPartyNoticesPlugin from './third-party-notices-plugin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryLicenseTextsDir = path.resolve(here, '..', 'license-texts');

function writeFixturePackage(nodeModulesDir, name, { packageJson, files }) {
    const packageDir = path.join(nodeModulesDir, name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    for (const [fileName, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(packageDir, fileName), content);
    }
    return packageDir;
}

function buildFixtureProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-notices-'));
    const nodeModulesDir = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    writeFixturePackage(nodeModulesDir, 'fixture-simple-mit', {
        packageJson: { name: 'fixture-simple-mit', version: '1.0.0', license: 'MIT', main: 'index.js' },
        files: {
            'index.js': 'module.exports = 1;\n',
            LICENSE: 'MIT License\n\nCopyright (c) 2026 Fixture Author\n\nPermission is hereby granted...\n'
        }
    });

    // Mirrors the real @jellyfin/libass-wasm shape found by the audit: a
    // compound AND/OR license expression whose bundled LICENSE file
    // contains only one of the AND-mandatory components (MIT), not the
    // LGPL-2.1-or-later text that also unconditionally applies.
    writeFixturePackage(nodeModulesDir, 'fixture-compound-license', {
        packageJson: {
            name: 'fixture-compound-license',
            version: '2.0.0',
            license: 'LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT',
            main: 'index.js'
        },
        files: {
            'index.js': 'module.exports = 2;\n',
            LICENSE: 'MIT License\n\nCopyright (c) 2026 Fixture Author\n\nPermission is hereby granted...\n'
        }
    });

    // Never imported by the entry point below. Proves the notices file is
    // built from the webpack module graph (what actually ships) and not
    // from every package that happens to sit in node_modules.
    writeFixturePackage(nodeModulesDir, 'fixture-unused-package', {
        packageJson: { name: 'fixture-unused-package', version: '9.0.0', license: 'MIT', main: 'index.js' },
        files: {
            'index.js': 'module.exports = 9;\n',
            LICENSE: 'MIT License\n\nCopyright (c) 2026 Nobody Imports Me\n'
        }
    });

    fs.writeFileSync(
        path.join(root, 'entry.js'),
        "require('fixture-simple-mit');\nrequire('fixture-compound-license');\n"
    );
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Fixture</title>\n');
    fs.writeFileSync(
        path.join(root, 'PROJECT-LICENSE'),
        'GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n\n(fixture project license text)\n'
    );
    fs.writeFileSync(
        path.join(root, 'ATTRIBUTIONS.md'),
        '# Fixture asset attributions\n\nFixture-generated-avatar.png: GPL-2.0-only\n'
    );

    return root;
}

function buildUnresolvableLicenseFixtureProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-notices-unresolvable-'));
    const nodeModulesDir = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    // No bundled license file and a made-up SPDX id absent from the local
    // corpus: the plugin has no license text to offer for this package at
    // all, which must fail the build rather than ship a silent gap.
    writeFixturePackage(nodeModulesDir, 'fixture-no-license-anywhere', {
        packageJson: { name: 'fixture-no-license-anywhere', version: '1.0.0', license: 'Fixture-Nonexistent-License-1.0', main: 'index.js' },
        files: { 'index.js': 'module.exports = 1;\n' }
    });

    fs.writeFileSync(path.join(root, 'entry.js'), "require('fixture-no-license-anywhere');\n");
    fs.writeFileSync(
        path.join(root, 'PROJECT-LICENSE'),
        'GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n\n(fixture project license text)\n'
    );

    return root;
}

function runWebpackBuild(root) {
    const compiler = webpack({
        mode: 'none',
        target: 'node',
        context: root,
        entry: './entry.js',
        output: {
            path: path.join(root, 'dist'),
            filename: 'bundle.js'
        },
        plugins: [
            // Match the production config's child compilation. Notice assets
            // belong to the root distribution and must not be re-emitted by
            // HtmlWebpackPlugin's child compiler.
            new HtmlWebpackPlugin({ template: path.join(root, 'index.html') }),
            new ThirdPartyNoticesPlugin({
                licenseFile: path.join(root, 'PROJECT-LICENSE'),
                attributionsFile: path.join(root, 'ATTRIBUTIONS.md'),
                licenseTextsDir: repositoryLicenseTextsDir
            })
        ]
    });

    return new Promise((resolve, reject) => {
        compiler.run((err, stats) => {
            compiler.close(closeErr => {
                if (err) {
                    reject(err);
                    return;
                }
                if (closeErr) {
                    reject(closeErr);
                    return;
                }
                if (stats.hasErrors()) {
                    reject(new Error(stats.toString({ errors: true })));
                    return;
                }
                resolve(stats);
            });
        });
    });
}

test('a real webpack build emits dist/LICENSE and dist/THIRD-PARTY-NOTICES.txt covering exactly the bundled packages', async () => {
    const root = buildFixtureProject();
    try {
        await runWebpackBuild(root);

        const licensePath = path.join(root, 'dist', 'LICENSE');
        const noticesPath = path.join(root, 'dist', 'THIRD-PARTY-NOTICES.txt');
        assert.equal(fs.existsSync(licensePath), true, 'dist/LICENSE was not emitted');
        assert.equal(fs.existsSync(noticesPath), true, 'dist/THIRD-PARTY-NOTICES.txt was not emitted');

        const licenseText = fs.readFileSync(licensePath, 'utf8');
        assert.match(licenseText, /GNU GENERAL PUBLIC LICENSE/);

        const notices = fs.readFileSync(noticesPath, 'utf8');

        // The imported packages are covered.
        assert.match(notices, /fixture-simple-mit 1\.0\.0/);
        assert.match(notices, /fixture-compound-license 2\.0\.0/);

        // The unimported package must NOT appear: the notices file tracks
        // what is actually in the compiled bundle, not everything under
        // node_modules.
        assert.doesNotMatch(notices, /fixture-unused-package/);

        // The compound-license package's AND-mandatory LGPL-2.1-or-later
        // text is present in full, even though the package's own bundled
        // LICENSE file contains only the MIT text.
        assert.match(notices, /Full text of referenced license "LGPL-2\.1-or-later"/);
        assert.match(notices, /GNU LESSER GENERAL PUBLIC LICENSE/);
        assert.match(notices, /Version 2\.1, February 1999/);

        // Non-package assets and translations are covered by the audited
        // source-tree attribution file in the same shipped notice.
        assert.match(notices, /Bundled Asset and Translation Attributions/);
        assert.match(notices, /Fixture-generated-avatar\.png: GPL-2\.0-only/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a webpack build fails loudly rather than shipping a notices file with a missing license', async () => {
    const root = buildUnresolvableLicenseFixtureProject();
    try {
        await assert.rejects(
            () => runWebpackBuild(root),
            error => {
                assert.match(error.message, /fixture-no-license-anywhere/);
                assert.match(error.message, /Fixture-Nonexistent-License-1\.0/);
                return true;
            }
        );
        assert.equal(fs.existsSync(path.join(root, 'dist', 'THIRD-PARTY-NOTICES.txt')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('extractLicenseIds splits a compound AND/OR expression into every referenced id', () => {
    const ids = ThirdPartyNoticesPlugin.extractLicenseIds(
        'LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0 AND Apache-2.0 WITH LLVM-exception'
    );
    assert.deepEqual(
        [...ids].sort(),
        [
            'Apache-2.0', 'BSL-1.0', 'FTL', 'GPL-2.0-or-later', 'ISC',
            'LGPL-2.1-or-later', 'LLVM-exception', 'MIT',
            'MIT-Modern-Variant', 'NTP', 'Zlib'
        ].sort()
    );
});

test('extractLicenseIds returns the single id unchanged for a simple expression', () => {
    assert.deepEqual(ThirdPartyNoticesPlugin.extractLicenseIds('OFL-1.1'), [ 'OFL-1.1' ]);
    assert.deepEqual(ThirdPartyNoticesPlugin.extractLicenseIds(''), []);
});

test('canonicalLicenseId normalizes the legacy MIT/X11 alias', () => {
    assert.equal(ThirdPartyNoticesPlugin.canonicalLicenseId('MIT/X11'), 'MIT');
    assert.equal(ThirdPartyNoticesPlugin.canonicalLicenseId('Apache-2.0'), 'Apache-2.0');
});

test('findPackageDir resolves the innermost node_modules package for nested (transitive) installs', () => {
    assert.equal(
        ThirdPartyNoticesPlugin.findPackageDir('/repo/node_modules/epubjs/node_modules/jszip/lib/index.js'),
        '/repo/node_modules/epubjs/node_modules/jszip'
    );
    assert.equal(
        ThirdPartyNoticesPlugin.findPackageDir('/repo/node_modules/@jellyfin/sdk/dist/index.js'),
        '/repo/node_modules/@jellyfin/sdk'
    );
    assert.equal(
        ThirdPartyNoticesPlugin.findPackageDir('/repo/src/components/App.tsx'),
        null
    );
});
