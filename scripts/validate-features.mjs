#!/usr/bin/env node
// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-09-09.
// scripts/validate-features.mjs - Pre-commit + CI gate for feature path coverage
//
// Ported from ~/.claude/templates/quality-gates/shared/scripts/validate-features.js
// to ESM. package.json has no "type": "module" here (webpack/babel own the
// app bundle), so this file uses the .mjs extension to opt into ESM per-file,
// the same convention scripts/developerToolchain.test.mjs already uses in
// this repo, rather than flipping the whole package to "type": "module".
//
// Deviation from the template's testDirs list (['tests', 'test', '__tests__',
// 'src']): this repo keeps its Playwright specs in e2e/, which none of those
// four cover, so every e2e-only path would read as uncovered. 'e2e' is added
// below as a fifth scanned directory.
//
// Reads features.json, scans test files for `// @covers` comment markers
// (this repo has no itCovers() wrapper installed, so only the comment-marker
// convention applies), and fails if any manifest path lacks a test, any
// itCovers()/@covers reference points at an unknown path, or any feature
// lacks unhappy paths (unless kind: read-only / non-interactive). Zero false
// positives by construction: it enforces structural rules (declared path has
// a test), not measurements.
//
// Usage:
//   node scripts/validate-features.mjs
//   node scripts/validate-features.mjs --features path/to/features.json
//
// Pre-commit (.git/hooks/pre-commit):
//   node scripts/validate-features.mjs

import fs from 'node:fs';
import path from 'node:path';

function parseFeaturesFileArg(argv) {
    const flagIndex = argv.indexOf('--features');
    if (flagIndex !== -1 && argv[flagIndex + 1]) {
        return argv[flagIndex + 1];
    }
    return 'features.json';
}

const featuresFile = parseFeaturesFileArg(process.argv.slice(2));

const featuresPath = path.resolve(process.cwd(), featuresFile);
if (!fs.existsSync(featuresPath)) {
    console.error(`features.json not found at ${featuresPath}`);
    console.error('Create features.json at the project root. See ~/.claude/docs/features-json-guide.md');
    process.exit(2);
}

let manifest;
try {
    manifest = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
} catch (e) {
    console.error(`Failed to parse ${featuresFile}: ${e.message}`);
    process.exit(2);
}

if (!manifest.features || !Array.isArray(manifest.features)) {
    console.error(`${featuresFile} must have a "features" array at the top level`);
    process.exit(2);
}

if (manifest.exempt) {
    console.log(`OK: project is exempt from feature path coverage (${manifest.exempt})`);
    process.exit(0);
}

const errors = [];

const allManifestPaths = [];
for (const feature of manifest.features) {
    if (!feature.id) {
        errors.push('A feature is missing an "id" field');
        continue;
    }
    if (!feature.paths || !Array.isArray(feature.paths) || feature.paths.length === 0) {
        errors.push(`Feature "${feature.id}" has no paths declared`);
        continue;
    }

    const happyPaths = feature.paths.filter((p) => p.type === 'happy');
    const unhappyPaths = feature.paths.filter((p) => p.type === 'unhappy');

    if (happyPaths.length === 0) {
        errors.push(`Feature "${feature.id}" has no happy path`);
    }

    const isExempt = feature.kind === 'read-only' || feature.kind === 'non-interactive';
    if (!isExempt && unhappyPaths.length < 2) {
        errors.push(
            `Feature "${feature.id}" needs at least 2 unhappy paths (has ${unhappyPaths.length}). `
            + 'Set kind: "read-only" or "non-interactive" to exempt.'
        );
    }

    for (const p of feature.paths) {
        if (!p.id) {
            errors.push(`A path in feature "${feature.id}" is missing an "id" field`);
        } else {
            allManifestPaths.push(p.id);
        }
    }
}

const testDirs = ['tests', 'test', '__tests__', 'src', 'e2e'].filter((d) =>
    fs.existsSync(path.resolve(process.cwd(), d))
);

if (testDirs.length === 0) {
    console.error('No test directories found (looked for tests/, test/, __tests__/, src/, e2e/)');
    process.exit(2);
}

function walkFiles(dir, extensions) {
    const results = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        // allow-silent-catch: permission denied on unreadable dirs is expected
        return results;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (entry.isDirectory()) {
            results.push(...walkFiles(fullPath, extensions));
        } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

const testExtensions = ['.test.js', '.test.ts', '.test.jsx', '.test.tsx', '.spec.js', '.spec.ts', '.spec.jsx', '.spec.tsx', '.test.mjs', '.spec.mjs'];
const testFiles = [];
for (const dir of testDirs) {
    testFiles.push(...walkFiles(path.resolve(process.cwd(), dir), testExtensions));
}

const COVERS_PATTERNS = [/itCovers\s*[.(]\s*['"`]([^'"`]+)['"`]/g, /\/\/\s*@covers\s+([\w.]+)/g];

const coveredPathIds = new Set();
for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const re of COVERS_PATTERNS) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(content)) !== null) {
            coveredPathIds.add(match[1]);
        }
    }
}

const uncovered = allManifestPaths.filter((p) => !coveredPathIds.has(p));
const orphans = [...coveredPathIds].filter((p) => !allManifestPaths.includes(p));

if (uncovered.length > 0) {
    errors.push(
        `${uncovered.length} manifest path(s) have no covering test (itCovers() or // @covers):\n`
        + uncovered.map((p) => `    - ${p}`).join('\n')
    );
}

if (orphans.length > 0) {
    errors.push(
        `${orphans.length} itCovers()/@covers reference(s) point to unknown path IDs (not in ${featuresFile}):\n`
        + orphans.map((p) => `    - ${p}`).join('\n')
    );
}

if (errors.length > 0) {
    console.error('FEATURE PATH COVERAGE FAILED:\n');
    errors.forEach((e, i) => {
        console.error(`  ${i + 1}. ${e}\n`);
    });
    console.error('Every feature must have:');
    console.error('  - At least 1 happy path');
    console.error('  - At least 2 unhappy paths (unless read-only/non-interactive)');
    console.error('  - An itCovers() test or // @covers comment for every declared path');
    console.error('  - No orphan references to unknown path IDs\n');
    process.exit(1);
}

console.log(`OK: ${allManifestPaths.length} paths across ${manifest.features.length} features, all covered`);
