// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-09-09.
/**
 * Exercises the npm test entry point with the unsupported toolchain currently used by the
 * repository queue runner. The command must fail at npm's engine gate before Vitest starts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('npm test rejects an unsupported Node runtime before Vitest starts', () => {
    const result = spawnSync('npm', [ 'test', '--', '--help' ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 30_000
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const diagnostic = output.slice(0, 4_000);

    assert.equal(result.error, undefined, diagnostic);
    assert.equal(result.status, 1, `Unsupported toolchain reached Vitest:\n${diagnostic}`);
    assert.match(output, /EBADDEVENGINES/);
    assert.match(output, /Invalid engine "runtime"/);
});
