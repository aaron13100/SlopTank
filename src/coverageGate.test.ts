// @vitest-environment node
/**
 * Regression coverage for the coverage ratchet itself.
 *
 * Runs in the node environment, not the suite's default jsdom: this file
 * imports the real vite.config.ts, which pulls in vite and esbuild, and
 * esbuild refuses to load against jsdom's TextEncoder.
 *
 * `npm run test:coverage` is the command CI runs, and it is only a gate while
 * three things stay true: the CI matrix runs that command (not the coverage-less
 * `test`), the command actually passes --coverage, and vite.config.ts feeds the
 * committed floor from coverage-baseline.json into vitest's thresholds. Break
 * any one and the suite keeps passing while coverage silently rots, which is the
 * exact failure this gate exists to prevent, so each is asserted here.
 *
 * The ratchet generator is exercised as the CLI operators actually run
 * (`node scripts/coverage-baseline.mjs`), in a temporary directory, never
 * against the committed baseline.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverageV8Options } from 'vitest/node';

import viteConfig from '../vite.config';
import { METRICS, SCHEMA_VERSION, readCoverageBaseline, CoverageBaselineError } from '../scripts/coverage-baseline.mjs';

const repositoryRoot = process.cwd();
const generator = resolvePath(repositoryRoot, 'scripts/coverage-baseline.mjs');
const committedBaseline = JSON.parse(
    readFileSync(resolvePath(repositoryRoot, 'coverage-baseline.json'), 'utf8')
) as { schemaVersion: number, thresholds: Record<string, number> };
const packageJson = JSON.parse(
    readFileSync(resolvePath(repositoryRoot, 'package.json'), 'utf8')
) as { scripts: Record<string, string> };
const qualityChecksWorkflow = readFileSync(
    resolvePath(repositoryRoot, '.github/workflows/__quality_checks.yml'), 'utf8'
);
// vitest types coverage options as a union across its providers, and only the
// custom-provider arm lacks the fields asserted below; this suite is about the
// v8 provider the repo actually runs.
const coverageOptions = viteConfig.test?.coverage as CoverageV8Options | undefined;

const sandboxes: string[] = [];

/** A throwaway directory holding a summary/baseline pair for one CLI run. */
function sandbox() {
    const directory = mkdtempSync(join(tmpdir(), 'coverage-ratchet-'));
    sandboxes.push(directory);
    return {
        baselinePath: join(directory, 'coverage-baseline.json'),
        summaryPath: join(directory, 'coverage-summary.json')
    };
}

/** Write a coverage/coverage-summary.json shaped like the json-summary reporter's. */
function writeSummary(path: string, percentages: Record<string, number>) {
    const total = Object.fromEntries(
        Object.entries(percentages).map(([ metric, pct ]) => [ metric, { covered: 1, pct, skipped: 0, total: 100 } ])
    );
    writeFileSync(path, JSON.stringify({ total }));
}

function writeBaseline(path: string, thresholds: Record<string, number>, extra: Record<string, unknown> = {}) {
    writeFileSync(path, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...extra, thresholds }, null, 4));
}

function readBaselineDocument(path: string) {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function runGenerator(args: string[]) {
    const result = spawnSync(process.execPath, [ generator, ...args ], { encoding: 'utf8' });
    return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

const evenPercentages = { branches: 40, functions: 20, lines: 10, statements: 10 };

afterEach(() => {
    while (sandboxes.length > 0) {
        rmSync(sandboxes.pop() as string, { force: true, recursive: true });
    }
});

describe('coverage ratchet: vitest configuration', () => {
    it('gates the suite on the committed coverage floor', () => {
        expect(coverageOptions?.thresholds).toEqual(committedBaseline.thresholds);
    });

    it('gates on every metric vitest can threshold, none of them at zero', () => {
        const thresholds = coverageOptions?.thresholds as Record<string, number>;

        const byName = (left: string, right: string) => left.localeCompare(right);

        expect(Object.keys(thresholds).sort(byName)).toEqual([ ...METRICS ].sort(byName));
        for (const metric of METRICS) {
            expect(thresholds[metric]).toBeGreaterThan(0);
            expect(thresholds[metric]).toBeLessThanOrEqual(100);
        }
    });

    it('measures the whole src tree, so untested files count against the floor', () => {
        expect(coverageOptions?.include).toEqual([ 'src' ]);
    });

    it('writes the json-summary report the ratchet generator reads back', () => {
        expect(coverageOptions?.reporter).toContain('json-summary');
    });
});

describe('coverage ratchet: commands that keep coverage measured', () => {
    it('actually collects coverage in the test:coverage script', () => {
        expect(packageJson.scripts['test:coverage']).toContain('--coverage');
    });

    it('exposes the generator as an npm script so the floor can be raised', () => {
        expect(packageJson.scripts['coverage:baseline']).toContain('scripts/coverage-baseline.mjs');
    });

    it('runs the coverage command, not the coverage-less one, in CI quality checks', () => {
        const lines = qualityChecksWorkflow.split('\n');
        const commandsStart = lines.indexOf('        command:');
        const commands = lines.slice(commandsStart + 1)
            .filter(line => line.startsWith('          - '))
            .map(line => line.slice('          - '.length));

        expect(commands).toContain('test:coverage');
        expect(commands).not.toContain('test');
    });
});

describe('coverage ratchet: reading the committed floor', () => {
    it('rejects a missing baseline instead of leaving the suite ungated', () => {
        const { baselinePath } = sandbox();

        expect(() => readCoverageBaseline(baselinePath)).toThrow(CoverageBaselineError);
        expect(() => readCoverageBaseline(baselinePath)).toThrow(/does not exist/);
    });

    it('rejects a baseline missing a metric', () => {
        const { baselinePath } = sandbox();
        writeBaseline(baselinePath, { branches: 40, functions: 20, lines: 10 });

        expect(() => readCoverageBaseline(baselinePath)).toThrow(/"statements" is undefined/);
    });

    it('rejects a zero threshold, which would gate nothing', () => {
        const { baselinePath } = sandbox();
        writeBaseline(baselinePath, { ...evenPercentages, lines: 0 });

        expect(() => readCoverageBaseline(baselinePath)).toThrow(/"lines" is 0/);
    });

    it('rejects an unparseable baseline', () => {
        const { baselinePath } = sandbox();
        writeFileSync(baselinePath, '{ not json');

        expect(() => readCoverageBaseline(baselinePath)).toThrow(/not valid JSON/);
    });

    it('refuses a baseline written by a newer schema rather than misreading it', () => {
        const { baselinePath } = sandbox();
        writeBaseline(baselinePath, evenPercentages, { schemaVersion: SCHEMA_VERSION + 1 });

        expect(() => readCoverageBaseline(baselinePath)).toThrow(/newer than this checkout understands/);
    });

    it('still reads a baseline written before the format was versioned', () => {
        const { baselinePath } = sandbox();
        writeFileSync(baselinePath, JSON.stringify({ thresholds: evenPercentages }));

        expect(readCoverageBaseline(baselinePath)).toEqual(evenPercentages);
    });

    it('declares the schema version in the committed baseline', () => {
        expect(committedBaseline.schemaVersion).toBe(SCHEMA_VERSION);
    });
});

describe('coverage ratchet: scripts/coverage-baseline.mjs', () => {
    it('creates the floor from a first measurement', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeSummary(summaryPath, evenPercentages);

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(0);
        expect(readCoverageBaseline(baselinePath)).toEqual(evenPercentages);
    });

    it('rounds the floor down so it never sits above measured coverage', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeSummary(summaryPath, { ...evenPercentages, lines: 10.129 });

        runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(readCoverageBaseline(baselinePath).lines).toBe(10.12);
    });

    it('raises the floor when coverage improves', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages);
        writeSummary(summaryPath, { ...evenPercentages, lines: 11.5 });

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(0);
        expect(readCoverageBaseline(baselinePath).lines).toBe(11.5);
    });

    it('stamps the schema version and keeps fields a newer writer added', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages, { fieldFromANewerWriter: 'keep me' });
        writeSummary(summaryPath, { ...evenPercentages, lines: 11.5 });

        runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);
        const written = readBaselineDocument(baselinePath);

        expect(written.schemaVersion).toBe(SCHEMA_VERSION);
        expect(written.fieldFromANewerWriter).toBe('keep me');
    });

    it('refuses to regenerate over a newer schema', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages, { schemaVersion: SCHEMA_VERSION + 1 });
        writeSummary(summaryPath, { ...evenPercentages, lines: 11.5 });

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('newer than this checkout understands');
        expect(readBaselineDocument(baselinePath).thresholds).toEqual(evenPercentages);
    });

    it('refuses to lower the floor and leaves the committed file untouched', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages);
        writeSummary(summaryPath, { ...evenPercentages, lines: 9.5 });

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('lines: 10% -> 9.5%');
        expect(readCoverageBaseline(baselinePath)).toEqual(evenPercentages);
    });

    it('lowers the floor only when the drop is declared with --allow-decrease', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages);
        writeSummary(summaryPath, { ...evenPercentages, lines: 9.5 });

        const result = runGenerator([ '--allow-decrease', '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(0);
        expect(readCoverageBaseline(baselinePath).lines).toBe(9.5);
    });

    it('fails when no coverage run has produced a summary', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages);

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('npm run test:coverage');
        expect(readCoverageBaseline(baselinePath)).toEqual(evenPercentages);
    });

    it('fails on an unparseable summary rather than zeroing the floor', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages);
        writeFileSync(summaryPath, 'not json at all');

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not valid JSON');
        expect(readCoverageBaseline(baselinePath)).toEqual(evenPercentages);
    });

    it('fails on a summary that reports no totals', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages);
        writeFileSync(summaryPath, '{ "src/index.ts": { "lines": { "pct": 10 } } }');

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('no "total" section');
    });

    it('fails on a summary missing one metric rather than recording a partial floor', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeBaseline(baselinePath, evenPercentages);
        writeSummary(summaryPath, { branches: 40, functions: 20, lines: 10 });

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('total.statements.pct');
    });

    it('rejects an unknown argument instead of silently ignoring it', () => {
        const { baselinePath, summaryPath } = sandbox();
        writeSummary(summaryPath, evenPercentages);

        const result = runGenerator([ '--summary', summaryPath, '--baseline', baselinePath, '--force' ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Unknown argument "--force"');
    });

    it('rejects a flag whose path argument is missing', () => {
        const result = runGenerator([ '--baseline' ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('--baseline requires a path');
    });
});
