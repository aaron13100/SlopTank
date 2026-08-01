'use strict';

// GPLv2 Sections 1 and 3 require the license text and per-component notices
// to accompany a distributed binary; see
// deliverables/gpl-license-boundary-audit-t_260730_175528_423.md Part 2.3.
// This plugin derives THIRD-PARTY-NOTICES.txt from the packages that are
// actually resolved into the compiled bundle (via the webpack module
// graph), not from package.json's declared dependency list. The two
// disagree: package.json's "dependencies" both under- and over-states what
// ships (transitive packages like jszip ship without being listed there;
// devDependency-only tooling like sass's platform binaries are never
// bundled even though npm's own dependency tree does not mark them dev).
// Reading the module graph is the only source that matches what is
// actually distributed.

const fs = require('node:fs');
const path = require('node:path');
const { Compilation, sources } = require('webpack');

const PLUGIN_NAME = 'ThirdPartyNoticesPlugin';

const LICENSE_FILE_NAMES = [
    'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.markdown',
    'License', 'license', 'LICENSE-MIT', 'COPYING', 'COPYING.txt',
    'LICENCE', 'LICENCE.md'
];

// Matches the innermost node_modules/<pkg> or node_modules/@scope/<pkg>
// segment of a resolved module path, including nested (transitive)
// installs like node_modules/a/node_modules/b.
const PACKAGE_DIR_PATTERN = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/][^\\/]+|[^\\/]+))(?:[\\/]|$)/;

const LICENSE_ID_ALIASES = {
    // Legacy alias some older packages still use in package.json; SPDX has
    // no "MIT/X11" identifier because the two are the same license text.
    'MIT/X11': 'MIT'
};

const LICENSE_EXPRESSION_OPERATORS = new Set([ 'AND', 'OR', 'WITH' ]);

/**
 * Raised when a bundled package's license text cannot be fully accounted
 * for, carrying the operator-facing next step rather than just a stack
 * trace: add the missing SPDX id's text to scripts/license-texts/, or, if
 * the package's license file genuinely covers it under a different name,
 * teach findBundledLicenseText/extractLicenseIds to recognize it.
 */
class ThirdPartyNoticesError extends Error {
    constructor(code, message, hint) {
        super(message);
        this.name = 'ThirdPartyNoticesError';
        this.code = code;
        this.hint = hint;
    }
}

function findPackageDir(resourcePath) {
    const match = resourcePath.match(PACKAGE_DIR_PATTERN);
    return match ? match[1] : null;
}

function readPackageJson(packageDir) {
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch {
        return null;
    }
}

function findBundledLicenseText(packageDir) {
    for (const fileName of LICENSE_FILE_NAMES) {
        const candidate = path.join(packageDir, fileName);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return { fileName, text: fs.readFileSync(candidate, 'utf8').trim() };
        }
    }
    return null;
}

function canonicalLicenseId(id) {
    return LICENSE_ID_ALIASES[id] || id;
}

// Extracts the distinct license identifiers referenced by an SPDX-ish
// expression. Every dependency license in this tree is a simple `ID`,
// `(ID)`, `ID AND ID`, or `ID AND (ID OR ID)` shape with no `WITH`
// exceptions, so splitting on the boolean keywords is sufficient; a full
// SPDX grammar parser is not used here because the one already vendored
// (spdx-expression-parse) throws on newer ids such as MIT-Modern-Variant.
function extractLicenseIds(expression) {
    if (!expression) {
        return [];
    }
    const ids = expression
        .replace(/[()]/g, ' ')
        .trim()
        .split(/\s+/)
        .map(token => token.trim())
        .filter(token => token && !LICENSE_EXPRESSION_OPERATORS.has(token.toUpperCase()))
        .map(canonicalLicenseId);
    return Array.from(new Set(ids));
}

class ThirdPartyNoticesPlugin {
    constructor(options) {
        this.licenseFile = options.licenseFile;
        this.licenseTextsDir = options.licenseTextsDir;
        this.outputLicenseName = options.outputLicenseName || 'LICENSE';
        this.outputNoticesName = options.outputNoticesName || 'THIRD-PARTY-NOTICES.txt';
    }

    apply(compiler) {
        compiler.hooks.compilation.tap(PLUGIN_NAME, compilation => {
            // HtmlWebpackPlugin creates child compilations that inherit this
            // plugin. Distribution-level notices belong only to the root
            // compilation; child module graphs are incomplete and would
            // otherwise re-emit the same filename with different content.
            if (compilation.compiler !== compiler) {
                return;
            }

            const packageDirs = new Set();

            compilation.hooks.finishModules.tapAsync(PLUGIN_NAME, (modules, callback) => {
                for (const module of modules) {
                    const resource = module.resource;
                    if (!resource) {
                        continue;
                    }
                    const packageDir = findPackageDir(resource);
                    if (packageDir) {
                        packageDirs.add(packageDir);
                    }
                }
                callback();
            });

            // PROCESS_ASSETS_STAGE_ADDITIONAL (not the legacy
            // compiler.hooks.emit) is webpack 5's supported hook for adding
            // brand-new assets; emitAsset on compiler.hooks.emit still works
            // today but is deprecated ("Compilation.assets will be frozen").
            compilation.hooks.processAssets.tap(
                { name: PLUGIN_NAME, stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
                () => {
                    const licenseText = fs.readFileSync(this.licenseFile, 'utf8');
                    compilation.emitAsset(this.outputLicenseName, new sources.RawSource(licenseText));

                    const notices = this.buildNotices(packageDirs);
                    compilation.emitAsset(this.outputNoticesName, new sources.RawSource(notices));
                }
            );
        });
    }

    buildNotices(packageDirs) {
        const entries = [];
        const problems = [];
        for (const dir of packageDirs) {
            const packageJson = readPackageJson(dir);
            if (!packageJson || !packageJson.name) {
                continue;
            }
            const entry = this.buildEntry(dir, packageJson);
            entries.push(entry);
            if (entry.missingLicenseIds.length > 0) {
                problems.push(`${entry.name} ${packageJson.version || 'unknown'}: no license text (bundled or canonical) found for ${entry.missingLicenseIds.join(', ')}`);
            }
        }

        // A GPL compliance artifact that silently omits a component's
        // license text is worse than a build that refuses to ship: nobody
        // reads a THIRD-PARTY-NOTICES.txt closely enough to notice a gap.
        // Fail the build instead so a genuinely new/unresolvable license
        // gets a corpus entry (or an explicit carve-out) before it ships.
        if (problems.length > 0) {
            throw new ThirdPartyNoticesError(
                'missing-license-text',
                `${PLUGIN_NAME}: cannot produce a complete THIRD-PARTY-NOTICES.txt, missing license text for:\n`
                + problems.map(problem => `  - ${problem}`).join('\n'),
                `Add the missing SPDX id's canonical text under ${this.licenseTextsDir}, or add/fix the package's own bundled license file.`
            );
        }

        entries.sort((a, b) => a.name.localeCompare(b.name));

        const header = [
            'SlopTank web client - Third-Party Notices',
            '',
            'This distribution bundles the packages listed below, each under its',
            'own license. Every entry lists the package name, version, its',
            'declared license, and the applicable license text: the text',
            'bundled with the package itself, and, for a compound (AND/OR)',
            'expression, the full text of every referenced license id from the',
            'canonical SPDX license list. Entries are ordered alphabetically by',
            'package name.',
            '',
            `Derived from the actual production webpack module graph: ${entries.length} third-party packages were resolved into this bundle.`,
            '',
            '========================================================================'
        ].join('\n');

        const body = entries
            .map(entry => entry.text)
            .join('\n\n========================================================================\n\n');

        return `${header}\n\n${body}\n`;
    }

    buildEntry(dir, packageJson) {
        const name = packageJson.name;
        const version = packageJson.version || 'unknown';
        const legacyDeclaredLicense = Array.isArray(packageJson.licenses) ?
            packageJson.licenses.map(entry => entry.type).filter(Boolean).join(' OR ') :
            null;
        const declared = packageJson.license
            || legacyDeclaredLicense
            || 'UNKNOWN';
        const bundled = findBundledLicenseText(dir);
        const isCompound = /\bAND\b|\bOR\b/.test(declared);
        const licenseIds = extractLicenseIds(declared);

        const parts = [`${name} ${version}`, `Declared license: ${declared}`];

        if (bundled) {
            parts.push(
                '',
                `--- License text as bundled by the package (${bundled.fileName}) ---`,
                '',
                bundled.text
            );
        }

        // A compound expression is not fully represented by whatever single
        // file the package happened to bundle (see @jellyfin/libass-wasm,
        // whose bundled LICENSE contains only the MIT text even though its
        // declared expression makes LGPL-2.1-or-later apply unconditionally
        // via AND). Include every referenced id's full canonical text so no
        // AND-mandatory license is missing; over-including an OR-alternative
        // is a disclosure choice, not a licensing election this build step
        // is positioned to make on the recipient's behalf.
        const missingLicenseIds = [];
        if (isCompound || !bundled) {
            for (const id of licenseIds) {
                const corpusText = this.readCorpusText(id);
                if (!corpusText) {
                    missingLicenseIds.push(id);
                    continue;
                }
                parts.push(
                    '',
                    `--- Full text of referenced license "${id}" (SPDX canonical text) ---`,
                    '',
                    corpusText
                );
            }
            // A bundled file already fully accounts for a single, simple
            // (non-compound) declared license even when the corpus has no
            // matching entry (e.g. a package-specific custom license
            // text): only a compound expression's unmet id, or a total
            // absence of any text anywhere, is a real gap.
            if (!isCompound && bundled) {
                missingLicenseIds.length = 0;
            }
        } else if (licenseIds.length === 0) {
            missingLicenseIds.push(declared);
        }

        return { name, text: parts.join('\n'), missingLicenseIds };
    }

    readCorpusText(id) {
        if (!id) {
            return null;
        }
        const candidate = path.join(this.licenseTextsDir, `${id}.txt`);
        if (!fs.existsSync(candidate)) {
            return null;
        }
        return fs.readFileSync(candidate, 'utf8').trim();
    }
}

module.exports = ThirdPartyNoticesPlugin;
module.exports.extractLicenseIds = extractLicenseIds;
module.exports.findPackageDir = findPackageDir;
module.exports.canonicalLicenseId = canonicalLicenseId;
