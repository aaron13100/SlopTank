// SlopTank modification notice: added or changed by SlopTank on 2026-09-24, 2026-09-27.
/**
 * CLI contract tests for validate-features.mjs's --staged mode.
 *
 * The bug this guards against (queue task c180 / t_260912_185923_724): the
 * default mode scans the on-disk working tree via fs.readdirSync, so ANY
 * dirty/in-progress file anywhere in a shared worktree -- even one owned by
 * a completely different, concurrent task -- can leave a stray orphan
 * `// @covers` reference that blocks every commit, not just the author of
 * that file. --staged fixes this by reading the git INDEX instead: content
 * via `git show :<path>`, and the scanned file set via `git ls-files`.
 *
 * Each fixture is a real temporary git repository (fs.mkdtempSync under
 * os.tmpdir(), matching the convention already used by
 * patch-jellyfin-apiclient.test.mjs's createFixture()), and the script under
 * test runs as a real child process against it, per this project's
 * verification philosophy: observe the working CLI, not the source.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('./validate-features.mjs', import.meta.url));
const fixtureDirectories = new Set();

// Mirrors validate-features.mjs's own GIT_BINARY_CANDIDATES: resolve an
// absolute git path instead of a bare 'git' resolved through the inherited
// PATH (sonarjs/no-os-command-from-path).
const GIT_BINARY_CANDIDATES = [ '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git' ];
const gitBinary = GIT_BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate));
assert.ok(gitBinary, `git not found in any of: ${GIT_BINARY_CANDIDATES.join(', ')}`);

test.afterEach(() => {
    for (const directory of fixtureDirectories) {
        fs.rmSync(directory, { force: true, recursive: true });
    }
    fixtureDirectories.clear();
});

/**
 * Run a git subcommand in the fixture repo and fail loudly (with stderr) if
 * it does not exit 0, instead of letting a silent git failure masquerade as
 * a validator failure later in the test.
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
 * Build a minimal, valid fixture repo: one feature with one happy path
 * (kind: non-interactive, so it needs no unhappy paths), covered by a
 * committed test/demo.test.js. Both features.json and the test file are
 * committed, so the fixture starts in a clean, passing state under both the
 * default and --staged modes.
 *
 * @returns {string} absolute path to the fixture repo.
 */
function createFixtureRepo() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'features-gate-'));
    fixtureDirectories.add(directory);

    git(directory, ['init', '--quiet']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'Features Gate Test']);

    const manifest = {
        features: [
            {
                id: 'demo.happy',
                kind: 'non-interactive',
                paths: [ { id: 'demo.happy.path', type: 'happy' } ]
            }
        ]
    };
    fs.writeFileSync(path.join(directory, 'features.json'), JSON.stringify(manifest, null, 4));
    fs.mkdirSync(path.join(directory, 'test'));
    fs.writeFileSync(
        path.join(directory, 'test', 'demo.test.js'),
        '// @covers demo.happy.path\n'
    );

    git(directory, ['add', 'features.json', 'test/demo.test.js']);
    git(directory, ['commit', '--quiet', '-m', 'initial fixture']);
    return directory;
}

/**
 * Run validate-features.mjs against a fixture repo.
 *
 * @param {string} directory - fixture repo directory.
 * @param {string[]} extraArgs - additional CLI flags (e.g. '--staged').
 * @returns {import('node:child_process').SpawnSyncReturns<string>} result.
 */
function runValidator(directory, extraArgs = []) {
    return spawnSync(process.execPath, [
        SCRIPT_PATH,
        '--features', path.join(directory, 'features.json'),
        ...extraArgs
    ], { cwd: directory, encoding: 'utf8' });
}

test('a clean fixture passes in both default and --staged modes', () => {
    const directory = createFixtureRepo();

    const defaultRun = runValidator(directory);
    assert.equal(defaultRun.status, 0, `default mode should pass on a clean fixture:\n${defaultRun.stdout}${defaultRun.stderr}`);

    const stagedRun = runValidator(directory, [ '--staged' ]);
    assert.equal(stagedRun.status, 0, `--staged should pass on a clean fixture:\n${stagedRun.stdout}${stagedRun.stderr}`);
});

test('an unstaged orphan @covers reference does not fail --staged, but the same dirty tree still fails the default mode', () => {
    const directory = createFixtureRepo();
    const testFilePath = path.join(directory, 'test', 'demo.test.js');

    // Dirty the working tree only; deliberately never `git add` this edit.
    fs.writeFileSync(testFilePath, '// @covers demo.happy.path\n// @covers demo.orphan.unstaged\n');

    const stagedRun = runValidator(directory, [ '--staged' ]);
    assert.equal(stagedRun.status, 0, `expected --staged to ignore the unstaged orphan reference:\n${stagedRun.stdout}${stagedRun.stderr}`);

    // Positive control (verification-controls: absence needs a positive
    // control): the identical dirty tree, without --staged, must still be
    // caught -- proving the fixture really contains a catchable orphan
    // reference rather than the assertion above passing vacuously.
    const defaultRun = runValidator(directory);
    assert.notEqual(defaultRun.status, 0, 'expected the default (disk-scanning) mode to catch the orphan reference');
    assert.match(defaultRun.stderr, /demo\.orphan\.unstaged/);
});

test('a staged orphan @covers reference still fails --staged', () => {
    const directory = createFixtureRepo();
    const testFilePath = path.join(directory, 'test', 'demo.test.js');

    fs.writeFileSync(testFilePath, '// @covers demo.happy.path\n// @covers demo.orphan.staged\n');
    git(directory, [ 'add', 'test/demo.test.js' ]);

    const stagedRun = runValidator(directory, [ '--staged' ]);
    assert.notEqual(stagedRun.status, 0, 'expected --staged to catch a staged orphan reference');
    assert.match(stagedRun.stderr, /demo\.orphan\.staged/);
});

test('an orphan @covers reference in a brand-new untracked test file does not fail --staged', () => {
    const directory = createFixtureRepo();

    // Never `git add`ed: not in the index at all.
    fs.writeFileSync(
        path.join(directory, 'test', 'new-untracked.test.js'),
        '// @covers demo.orphan.untracked\n'
    );

    const stagedRun = runValidator(directory, [ '--staged' ]);
    assert.equal(stagedRun.status, 0, `expected --staged to ignore an untracked file:\n${stagedRun.stdout}${stagedRun.stderr}`);
});
