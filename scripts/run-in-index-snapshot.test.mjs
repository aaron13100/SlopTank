/**
 * CLI contract tests for scripts/run-in-index-snapshot.sh.
 *
 * The bug this guards against (queue task c285 / t_260924_153132_894):
 * .git/hooks/pre-commit's depcruise-gate ran dependency-cruiser directly
 * against the on-disk working tree under src/, so ANY unrelated agent's
 * unstaged, in-progress dirty file anywhere in this shared worktree --
 * even one introducing a brand-new circular import -- could fail an
 * unrelated commit, exactly like the features-gate bug fixed in c282
 * (scripts/validate-features.mjs --staged, commit 36447f3c18).
 * dependency-cruiser has no built-in "staged content only" mode, so the
 * fix instead exports the git INDEX into a scratch snapshot directory
 * (run-in-index-snapshot.sh) and runs depcruise there instead of against
 * the real working tree.
 *
 * The circular-import fixture is a real throwaway clone of THIS
 * repository (`git clone --local --no-checkout` against this repo's own
 * toplevel, then checked out), never the shared worktree itself:
 * dependency-cruiser needs a real .dependency-cruiser.js, tsconfig,
 * package.json, known-violations json and a real src/ tree to resolve
 * imports and apply its ruleset, which a minimal synthetic fixture (as
 * validate-features.test.mjs uses for validate-features.mjs) cannot
 * provide. node_modules is symlinked in from the real repo -- never
 * copied, since it is both gitignored (not part of any clone) and where
 * the actual depcruise binary and its resolver need to live.
 *
 * The propagation/cleanup test does not need any of that -- it never runs
 * depcruise -- so it uses a minimal from-scratch fixture instead, to avoid
 * paying for a full-project clone and checkout it does not need.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'run-in-index-snapshot.sh');

// Mirrors validate-features.test.mjs's own GIT_BINARY_CANDIDATES: resolve an
// absolute git path instead of a bare 'git' resolved through the inherited
// PATH (sonarjs/no-os-command-from-path).
const GIT_BINARY_CANDIDATES = [ '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git' ];
const gitBinary = GIT_BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate));
assert.ok(gitBinary, `git not found in any of: ${GIT_BINARY_CANDIDATES.join(', ')}`);

const SH_BINARY = '/bin/sh';
assert.ok(fs.existsSync(SH_BINARY), `sh not found at ${SH_BINARY}`);

const fixtureDirectories = new Set();

test.after(() => {
    for (const directory of fixtureDirectories) {
        fs.rmSync(directory, { force: true, recursive: true });
    }
    fixtureDirectories.clear();
});

/**
 * Run a git subcommand in a fixture repo and fail loudly (with stderr) if
 * it does not exit 0, instead of letting a silent git failure masquerade as
 * a test failure later.
 *
 * @param {string} cwd - fixture repo directory.
 * @param {string[]} args - git subcommand and arguments.
 * @returns {string} stdout.
 */
function git(cwd, args) {
    const result = spawnSync(gitBinary, args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
}

/**
 * Clone this repository (local, no network) into a throwaway directory and
 * symlink node_modules in from the real repo, so dependency-cruiser
 * resolves imports exactly as it would in the real worktree. This is a
 * fully independent git repository and working tree; nothing done to it
 * touches the real, shared worktree.
 *
 * --no-hardlinks: the real repo lives on an external volume
 * (/Volumes/2025_Black) while the throwaway clone lives under the OS temp
 * dir (typically the internal disk), so --local's default hardlinked
 * objects fail with "Cross-device link"; copying the (packed, so modest)
 * object store instead is the correct fix, not a workaround.
 *
 * @returns {string} absolute path to the throwaway clone's working tree.
 */
function createThrowawayClone() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'index-snapshot-fixture-'));
    fixtureDirectories.add(parent);
    const repoDir = path.join(parent, 'repo');
    git(parent, [ 'clone', '--local', '--no-hardlinks', '--no-checkout', REPO_ROOT, repoDir ]);
    git(repoDir, [ 'checkout', '--quiet', 'HEAD' ]);
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repoDir, 'node_modules'));
    git(repoDir, [ 'config', 'user.email', 'test@example.invalid' ]);
    git(repoDir, [ 'config', 'user.name', 'Index Snapshot Test' ]);
    return repoDir;
}

const CLEAN_A = "export const a = () => 'a';\n";
const CLEAN_B = "export const b = () => 'b';\n";
const CIRCULAR_A = "import { b } from './depcruise-fixture-b.js';\nexport const a = () => b();\n";
const CIRCULAR_B = "import { a } from './depcruise-fixture-a.js';\nexport const b = () => a();\n";

/**
 * Commit a clean (non-circular) version of two new src/ files, so they
 * exist in the fixture's HEAD/index before any dirty modification is made.
 *
 * @param {string} repoDir - fixture repo working tree.
 * @returns {{pathA: string, pathB: string}} absolute paths to the two files.
 */
function commitCleanFixtureFiles(repoDir) {
    const pathA = path.join(repoDir, 'src', 'depcruise-fixture-a.js');
    const pathB = path.join(repoDir, 'src', 'depcruise-fixture-b.js');
    fs.writeFileSync(pathA, CLEAN_A);
    fs.writeFileSync(pathB, CLEAN_B);
    git(repoDir, [ 'add', 'src/depcruise-fixture-a.js', 'src/depcruise-fixture-b.js' ]);
    git(repoDir, [ 'commit', '--quiet', '-m', 'clean fixture files' ]);
    return { pathA, pathB };
}

/**
 * Run dependency-cruiser directly against whatever is on disk right now:
 * the pre-fix behavior, with no snapshot and no staging awareness.
 *
 * @param {string} repoDir - fixture repo working tree.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} result.
 */
function runDepcruiseOnDisk(repoDir) {
    return spawnSync('npx', [
        '--no-install', 'depcruise',
        '--config', '.dependency-cruiser.js',
        '--ignore-known', '.dependency-cruiser-known-violations.json',
        'src'
    ], { cwd: repoDir, encoding: 'utf8' });
}

/**
 * Run dependency-cruiser through run-in-index-snapshot.sh (the fix):
 * against an export of the git INDEX, not the on-disk working tree.
 *
 * @param {string} repoDir - fixture repo working tree.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} result.
 */
function runDepcruiseViaSnapshot(repoDir) {
    return spawnSync(SH_BINARY, [
        SCRIPT_PATH,
        'npx', '--no-install', 'depcruise',
        '--config', '.dependency-cruiser.js',
        '--ignore-known', '.dependency-cruiser-known-violations.json',
        'src'
    ], { cwd: repoDir, encoding: 'utf8' });
}

test('an unstaged circular import under src/ fails the old on-disk scan, passes the index snapshot, and fails the snapshot again once staged', () => {
    const repoDir = createThrowawayClone();
    const { pathA, pathB } = commitCleanFixtureFiles(repoDir);

    // Dirty the working tree only with a brand-new circular import between
    // two files; deliberately never `git add` this edit yet.
    fs.writeFileSync(pathA, CIRCULAR_A);
    fs.writeFileSync(pathB, CIRCULAR_B);

    // Positive control (verification-controls: concluding ABSENCE requires a
    // POSITIVE control): prove the fixture really contains a catchable
    // violation by showing the pre-fix, disk-scanning behavior catches it.
    // This IS the bug being fixed: an unstaged, uncommitted file failing a
    // scan that a real `git commit` (which only ever commits the index)
    // would never actually include.
    const oldForm = runDepcruiseOnDisk(repoDir);
    const oldFormOutput = `${oldForm.stdout}${oldForm.stderr}`;
    console.log(`FAILING TEST CONFIRMED: old on-disk depcruise scan catches the unstaged circular import (exit=${oldForm.status}):\n${oldFormOutput}`);
    assert.notEqual(oldForm.status, 0, 'expected the old on-disk scan to fail on the unstaged circular import');
    assert.match(oldFormOutput, /circular/i);

    // The fix: the identical dirty working tree, scanned through the index
    // snapshot instead, must NOT fail -- the index (HEAD) still has the
    // clean, non-circular versions of both files.
    const snapshotOnDirty = runDepcruiseViaSnapshot(repoDir);
    assert.equal(snapshotOnDirty.status, 0, `expected the index snapshot to ignore the unstaged circular import:\n${snapshotOnDirty.stdout}${snapshotOnDirty.stderr}`);

    // Negative control (verification-controls: concluding PRESENCE requires
    // a NEGATIVE control run through the identical command): stage the
    // circular versions, so the index itself now has the cycle, and prove
    // the snapshot still catches a violation that is genuinely part of the
    // commit.
    git(repoDir, [ 'add', 'src/depcruise-fixture-a.js', 'src/depcruise-fixture-b.js' ]);
    const snapshotOnStaged = runDepcruiseViaSnapshot(repoDir);
    const snapshotOnStagedOutput = `${snapshotOnStaged.stdout}${snapshotOnStaged.stderr}`;
    assert.notEqual(snapshotOnStaged.status, 0, 'expected the index snapshot to catch a staged circular import');
    assert.match(snapshotOnStagedOutput, /circular/i);
});

test('run-in-index-snapshot.sh propagates a non-zero exit from its command and cleans up its snapshot directory', () => {
    // A minimal fixture is enough here: this test never runs depcruise, only
    // the wrapper's own exit-code propagation and cleanup, so it skips the
    // (expensive) full-project clone entirely.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'index-snapshot-minimal-'));
    fixtureDirectories.add(parent);
    const repoDir = path.join(parent, 'repo');
    fs.mkdirSync(repoDir);
    // Precondition: run-in-index-snapshot.sh fails closed unless
    // $REPO/node_modules exists; an empty directory satisfies the check
    // without needing any real dependency.
    fs.mkdirSync(path.join(repoDir, 'node_modules'));
    git(repoDir, [ 'init', '--quiet' ]);
    git(repoDir, [ 'config', 'user.email', 'test@example.invalid' ]);
    git(repoDir, [ 'config', 'user.name', 'Index Snapshot Test' ]);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'placeholder\n');
    git(repoDir, [ 'add', 'README.md' ]);
    git(repoDir, [ 'commit', '--quiet', '-m', 'init' ]);

    // The command prints its own cwd (the snapshot directory) so the test
    // can confirm afterward that the directory was removed, then exits
    // with a specific non-zero code to prove exact propagation (not just
    // "some" non-zero code).
    const result = spawnSync(SH_BINARY, [
        SCRIPT_PATH, 'sh', '-c', 'pwd; exit 37'
    ], { cwd: repoDir, encoding: 'utf8' });

    assert.equal(result.status, 37, `expected the wrapper to propagate the command's exact exit code:\n${result.stdout}${result.stderr}`);
    const snapshotDir = result.stdout.trim();
    assert.ok(snapshotDir.length > 0, 'expected the command to have printed its own cwd');
    assert.equal(fs.existsSync(snapshotDir), false, `expected the snapshot directory to have been cleaned up: ${snapshotDir}`);
});
