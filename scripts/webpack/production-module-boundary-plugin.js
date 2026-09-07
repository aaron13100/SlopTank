'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_NAME = 'ProductionModuleBoundaryPlugin';

// Keep this in step with AsyncRoute's webpackExclude magic comments. The
// context exclusion prevents accidental compilation; this expression is the
// independent, fail-closed production assertion over the final module graph.
const TEST_DIRECTORY_NAMES = new Set([
    '__tests__', '__mocks__', '__fixtures__',
    'test', 'tests', 'mock', 'mocks', 'fixture', 'fixtures'
]);
const TEST_FILE_PATTERN = /\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?$/i;
const SNAPSHOT_FILE_PATTERN = /\.snap$/i;
const PACKAGE_DIR_PATTERN = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/][^\\/]+|[^\\/]+))(?:[\\/]|$)/;

function findPackageDir(resourcePath) {
    const match = resourcePath.match(PACKAGE_DIR_PATTERN);
    return match ? match[1] : null;
}

function canonicalPath(targetPath) {
    try {
        return fs.realpathSync.native(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

function normalizeRelativePath(projectRoot, targetPath) {
    return path.relative(projectRoot, canonicalPath(targetPath)).split(path.sep).join('/');
}

function isTestResource(resourcePath) {
    return resourcePath
        .split(/[\\/]/)
        .some(segment => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()))
        || TEST_FILE_PATTERN.test(resourcePath)
        || SNAPSHOT_FILE_PATTERN.test(resourcePath);
}

class ProductionModuleBoundaryPlugin {
    constructor({ projectRoot, packageLockFile }) {
        this.projectRoot = canonicalPath(projectRoot);
        this.packageLockFile = path.resolve(packageLockFile);
    }

    apply(compiler) {
        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, compilation => {
            if (compilation.compiler !== compiler) {
                return;
            }

            compilation.hooks.finishModules.tap(PLUGIN_NAME, modules => {
                const packageLock = JSON.parse(fs.readFileSync(this.packageLockFile, 'utf8'));
                const lockPackages = packageLock.packages;
                if (!lockPackages || typeof lockPackages !== 'object') {
                    throw new Error(`${PLUGIN_NAME}: package-lock.json has no packages inventory`);
                }

                const violations = [];
                for (const module of modules) {
                    const resource = module.resource?.split('?')[0];
                    if (!resource) {
                        continue;
                    }

                    const relativeResource = normalizeRelativePath(this.projectRoot, resource);
                    if (!relativeResource.startsWith('../') && isTestResource(relativeResource)) {
                        violations.push(`test source: ${relativeResource}`);
                    }

                    const packageDir = findPackageDir(resource);
                    if (!packageDir) {
                        continue;
                    }

                    const lockKey = normalizeRelativePath(this.projectRoot, packageDir);
                    const lockEntry = lockPackages[lockKey];
                    if (!lockEntry) {
                        violations.push(`unclassified package: ${lockKey}`);
                    } else if (lockEntry.dev === true) {
                        violations.push(`dev-only package: ${lockKey}`);
                    }
                }

                if (violations.length > 0) {
                    const details = Array.from(new Set(violations)).sort();
                    throw new Error(
                        `${PLUGIN_NAME}: refusing to compile production-only boundary violations:\n`
                        + details.map(detail => `  - ${detail}`).join('\n')
                    );
                }
            });
        });
    }
}

ProductionModuleBoundaryPlugin.isTestResource = isTestResource;
ProductionModuleBoundaryPlugin.findPackageDir = findPackageDir;

module.exports = ProductionModuleBoundaryPlugin;
