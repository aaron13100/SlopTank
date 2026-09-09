// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-09.
/**
 * CLI contract tests for the jellyfin-apiclient compatibility patch.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT_PATH = fileURLToPath(new URL('./patch-jellyfin-apiclient.mjs', import.meta.url));
const LEGACY_SOURCE = 'url += `?api_key=${accessToken}`;';
const PATCHED_SOURCE = 'url += `?ApiKey=${accessToken}`;';
const fixtureDirectories = new Set();

test.afterEach(async () => {
    await Promise.all(Array.from(fixtureDirectories, directory => (
        rm(directory, { force: true, recursive: true })
    )));
    fixtureDirectories.clear();
});

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'sloptank-jellyfin-apiclient-'));
    fixtureDirectories.add(directory);
    const bundlePath = join(directory, 'jellyfin-apiclient.js');
    const sourceMapPath = join(directory, 'jellyfin-apiclient.js.map');
    await writeFile(bundlePath, LEGACY_SOURCE);
    await writeFile(sourceMapPath, JSON.stringify({ sourcesContent: [ LEGACY_SOURCE ] }));
    return { bundlePath, sourceMapPath };
}

function runPatch(bundlePath, sourceMapPath) {
    return spawnSync(process.execPath, [ SCRIPT_PATH, bundlePath, sourceMapPath ], {
        encoding: 'utf8'
    });
}

test('patches the installed bundle and source map and remains idempotent', async () => {
    const fixture = await createFixture();

    const firstRun = runPatch(fixture.bundlePath, fixture.sourceMapPath);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(await readFile(fixture.bundlePath, 'utf8'), PATCHED_SOURCE);
    assert.match(await readFile(fixture.sourceMapPath, 'utf8'), /\?ApiKey=/);

    const secondRun = runPatch(fixture.bundlePath, fixture.sourceMapPath);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(await readFile(fixture.bundlePath, 'utf8'), PATCHED_SOURCE);
    assert.match(await readFile(fixture.sourceMapPath, 'utf8'), /\?ApiKey=/);
});

test('fails before writing when a dependency artifact is missing', async () => {
    const fixture = await createFixture();
    const missingSourceMap = `${fixture.sourceMapPath}.missing`;

    const result = runPatch(fixture.bundlePath, missingSourceMap);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not read dependency artifact/i);
    assert.equal(await readFile(fixture.bundlePath, 'utf8'), LEGACY_SOURCE);
});

test('fails without partial writes when an artifact has an ambiguous patch shape', async () => {
    const fixture = await createFixture();
    const ambiguousBundle = `${LEGACY_SOURCE}\n${LEGACY_SOURCE}`;
    await writeFile(fixture.bundlePath, ambiguousBundle);

    const result = runPatch(fixture.bundlePath, fixture.sourceMapPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected exactly one legacy or canonical websocket token/i);
    assert.equal(await readFile(fixture.bundlePath, 'utf8'), ambiguousBundle);
    assert.match(await readFile(fixture.sourceMapPath, 'utf8'), /\?api_key=/);
});
