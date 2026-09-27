#!/usr/bin/env node
// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-09-09, 2026-09-24, 2026-09-27.
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
//   node scripts/validate-features.mjs --staged
//
// --staged checks the git INDEX (what `git commit` would actually commit),
// not the on-disk working tree: features.json and every scanned test file
// are read via `git show :<path>`, and the scanned file set comes from
// `git ls-files` rather than a filesystem walk. This makes the gate immune
// to unrelated, unstaged, in-progress edits elsewhere in a shared worktree
// (e.g. another concurrent task's dirty test file with a stray @covers
// reference): such a file simply is not part of what is being committed, so
// --staged does not see it. An untracked file, or a tracked file's unstaged
// edit, is invisible to --staged by construction. Default (no --staged)
// behavior is unchanged: it still reads whatever sits on disk right now.
//
// Pre-commit (.git/hooks/pre-commit):
//   node scripts/validate-features.mjs --staged

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseFeaturesFileArg(argv) {
    const flagIndex = argv.indexOf('--features');
    if (flagIndex !== -1 && argv[flagIndex + 1]) {
        return argv[flagIndex + 1];
    }
    return 'features.json';
}

function hasStagedFlag(argv) {
    return argv.includes('--staged');
}

const argv = process.argv.slice(2);
const featuresFile = parseFeaturesFileArg(argv);
const staged = hasStagedFlag(argv);

// Fixed allowlist of standard install directories for the git binary.
// --staged always invokes git as an absolute path from this list rather
// than a bare 'git' resolved through the inherited PATH: a PATH search
// trusts every directory ahead of the real binary, so if PATH has been
// tampered with upstream of this process (a compromised shell profile, a
// malicious local bin directory prepended earlier in the chain) a bare
// 'git' could silently run something else. Extend this list, do not widen
// it to a PATH search, if a legitimate install location is missing.
const GIT_BINARY_CANDIDATES = [ '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git' ];

/**
 * Resolve an absolute path to the git binary from GIT_BINARY_CANDIDATES.
 * Only called in --staged mode.
 *
 * @returns {string} absolute path to a git executable.
 */
function resolveGitBinary() {
    const found = GIT_BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        console.error(`--staged requires git; none found at: ${GIT_BINARY_CANDIDATES.join(', ')}`);
        process.exit(2);
    }
    return found;
}

const gitBinary = staged ? resolveGitBinary() : null;

/**
 * Resolve the git repository root (top-level working-tree directory) so
 * every --staged git invocation below operates on repo-root-relative paths
 * regardless of the process's own cwd. Only called in --staged mode.
 *
 * @returns {string} absolute path to the git top-level directory.
 */
function getRepoRoot() {
    try {
        return execFileSync(gitBinary, ['rev-parse', '--show-toplevel'], {
            encoding: 'utf8'
        }).trim();
    } catch (e) {
        console.error('--staged requires running inside a git repository');
        console.error(e.message);
        process.exit(2);
    }
}

/**
 * Resolve symlinks in a path without requiring the path itself to exist on
 * disk (e.g. a file that is staged but has since been deleted from the
 * working tree). Falls back to resolving the nearest existing ancestor.
 *
 * @param {string} candidatePath - absolute path to resolve.
 * @returns {string} the symlink-resolved absolute path.
 */
function realpathTolerant(candidatePath) {
    try {
        return fs.realpathSync(candidatePath);
    } catch {
        // allow-silent-catch: candidatePath itself may not exist on disk
        // (staged then locally deleted); resolve its parent instead.
        return path.join(fs.realpathSync(path.dirname(candidatePath)), path.basename(candidatePath));
    }
}

/**
 * Convert an absolute (or cwd-relative) filesystem path into a repo-relative,
 * forward-slash path suitable for `git show :<path>` / comparison against
 * `git ls-files` output. Both sides are realpath-resolved before comparing:
 * `git rev-parse --show-toplevel` resolves symlinks (e.g. macOS's
 * /var -> /private/var), but a path built from `os.tmpdir()` or a bare CLI
 * argument typically has not, so comparing them raw can misreport a path
 * inside the repo as outside it.
 *
 * @param {string} targetPath - path to convert.
 * @param {string} root - absolute git top-level directory.
 * @returns {string} repo-root-relative path with forward slashes.
 */
function toRepoRelative(targetPath, root) {
    const resolvedTarget = realpathTolerant(path.resolve(process.cwd(), targetPath));
    const resolvedRoot = fs.realpathSync(root);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (relative.startsWith('..')) {
        console.error(`${targetPath} is outside the git repository at ${root}`);
        process.exit(2);
    }
    return relative.split(path.sep).join('/');
}

/**
 * Read a file's content exactly as it sits in the git index (staged state),
 * ignoring any unstaged working-tree edit on top of it.
 *
 * @param {string} root - absolute git top-level directory.
 * @param {string} repoRelativePath - path relative to `root`.
 * @returns {string} utf8-decoded staged (index) content.
 * @throws {Error} if the path has no stage-0 entry in the index (untracked,
 *   never staged, or staged for deletion).
 */
function readIndexFile(root, repoRelativePath) {
    return execFileSync(gitBinary, ['show', `:${repoRelativePath}`], {
        cwd: root,
        encoding: 'utf8'
    });
}

/**
 * List every path git currently has staged in its index (i.e. tracked
 * content, reflecting `git add` but never an unstaged edit or an untracked
 * new file). Paths are repo-root-relative with forward slashes.
 *
 * Uses `-z` (NUL-separated, unquoted) output rather than plain newline
 * splitting: a path containing a literal newline would otherwise be
 * mis-split into two entries. Mirrors the same precaution
 * tools/lib/gpl_staged_file_notices.py takes for the identical reason.
 *
 * @param {string} root - absolute git top-level directory.
 * @returns {string[]} repo-relative paths of all indexed files.
 */
function listIndexFiles(root) {
    return execFileSync(gitBinary, ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
}

const repoRoot = staged ? getRepoRoot() : null;
const featuresPath = path.resolve(process.cwd(), featuresFile);

let featuresSource;
if (staged) {
    const relativeFeaturesPath = toRepoRelative(featuresPath, repoRoot);
    try {
        featuresSource = readIndexFile(repoRoot, relativeFeaturesPath);
    } catch (e) {
        console.error(`${featuresFile} has no staged content in the git index (${relativeFeaturesPath})`);
        console.error('--staged mode reads staged content: `git add` it first, or omit --staged to check the working tree.');
        console.error(e.message);
        process.exit(2);
    }
} else {
    if (!fs.existsSync(featuresPath)) {
        console.error(`features.json not found at ${featuresPath}`);
        console.error('Create features.json at the project root. See ~/.claude/docs/features-json-guide.md');
        process.exit(2);
    }
    featuresSource = fs.readFileSync(featuresPath, 'utf8');
}

let manifest;
try {
    manifest = JSON.parse(featuresSource);
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

/**
 * List every git-indexed test file under the given directories, using the
 * staged file set so an untracked or unstaged-only file never appears.
 *
 * @param {string} root - absolute git top-level directory.
 * @param {string[]} dirs - repo-root-relative test directories to scan.
 * @param {string[]} extensions - test-file suffixes to match.
 * @returns {string[]} repo-relative paths of matching indexed test files.
 */
function listStagedTestFiles(root, dirs, extensions) {
    return listIndexFiles(root).filter((repoRelativePath) => {
        const inTestDir = dirs.some((dir) => (
            repoRelativePath === dir || repoRelativePath.startsWith(`${dir}/`)
        ));
        return inTestDir && extensions.some((ext) => repoRelativePath.endsWith(ext));
    });
}

let testFiles;
if (staged) {
    // Entries are repo-relative paths; readIndexFile below reads their
    // staged content directly, mirroring the disk-mode branch's absolute
    // paths + fs.readFileSync.
    testFiles = listStagedTestFiles(repoRoot, testDirs, testExtensions);
} else {
    testFiles = [];
    for (const dir of testDirs) {
        testFiles.push(...walkFiles(path.resolve(process.cwd(), dir), testExtensions));
    }
}

const COVERS_PATTERNS = [/itCovers\s*[.(]\s*['"`]([^'"`]+)['"`]/g, /\/\/\s*@covers\s+([\w.]+)/g];

const coveredPathIds = new Set();
for (const file of testFiles) {
    const content = staged ? readIndexFile(repoRoot, file) : fs.readFileSync(file, 'utf8');
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
