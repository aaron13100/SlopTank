// scripts/coverage-baseline.mjs - read and (re)generate coverage-baseline.json
//
// Deliberately has no `#!/usr/bin/env node` shebang, unlike its sibling
// scripts/modularity-baseline.mjs: vite.config.ts imports this file, and vite
// bundles its config with esbuild, which chokes on a shebang in an inlined
// module. It is always invoked as `node scripts/coverage-baseline.mjs`
// (npm run coverage:baseline), so nothing needs one.
//
// vite.config.ts feeds coverage-baseline.json's numbers straight into vitest's
// `test.coverage.thresholds`, so `npm run test:coverage` (the command CI runs)
// fails the moment global coverage drops below the recorded floor. This file
// owns that JSON in both directions: vite.config.ts imports readCoverageBaseline
// to load it, and `npm run coverage:baseline` runs this file as a CLI to move
// the floor up after new tests land.
//
// It is a RATCHET, not a snapshot: regenerating refuses to record a number
// lower than the one already in the file unless --allow-decrease is passed
// explicitly, so "coverage went down, let me just re-baseline" cannot happen by
// accident. Same shape as scripts/modularity-baseline.mjs's --allow-growth.
//
// The floor is stored as the measured percentage rounded DOWN to two decimals,
// so a threshold is never set above what the suite actually achieves.
//
// Usage:
//   npm run test:coverage                                  # writes coverage/coverage-summary.json
//   node scripts/coverage-baseline.mjs                      # ratchet up; refuses any decrease
//   node scripts/coverage-baseline.mjs --allow-decrease     # record a decrease (tests deleted on purpose)
//   node scripts/coverage-baseline.mjs --summary <path> --baseline <path>   # path overrides (tests)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Anchored to this file, not the working directory: `npm run coverage:baseline`
// and vite.config.ts's import must resolve the same repository root.
const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..');

/** Metrics vitest accepts under `coverage.thresholds`, in report order. */
export const METRICS = [ 'lines', 'statements', 'functions', 'branches' ];

// coverage-baseline.json is a committed, machine-written format, so it carries a
// version from its first release. Changes stay additive (new optional fields
// only); anything that removes or redefines an existing field bumps this, and a
// reader that meets a higher version refuses to guess rather than under-enforce
// the gate. Unknown fields are preserved on rewrite and ignored on read, so a
// newer writer's additions survive an older generator.
export const SCHEMA_VERSION = 1;

export const DEFAULT_SUMMARY_PATH = join(ROOT, 'coverage', 'coverage-summary.json');
export const DEFAULT_BASELINE_PATH = join(ROOT, 'coverage-baseline.json');

const BASELINE_NOTE = 'Coverage ratchet floor for `npm run test:coverage` (wired into vitest\'s '
    + 'coverage.thresholds by vite.config.ts). These are the percentages the committed suite '
    + 'already achieves, rounded down; a change that drops below any of them fails the run. '
    + 'Raise them with `npm run coverage:baseline` after adding tests. Lowering requires '
    + '`node scripts/coverage-baseline.mjs --allow-decrease`, which is deliberate: coverage '
    + 'is meant to ratchet up, never silently regress.';

/**
 * Error raised for every unusable coverage-baseline.json / coverage-summary.json
 * state, carrying the operator-facing next step rather than just a stack trace.
 */
export class CoverageBaselineError extends Error {
    /**
     * @param {string} code machine-readable reason, e.g. 'baseline-missing'
     * @param {string} message what is wrong
     * @param {string} hint what the operator should do about it
     * @param {unknown} [cause] underlying error, when this wraps one
     */
    constructor(code, message, hint, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'CoverageBaselineError';
        this.code = code;
        this.hint = hint;
    }
}

/**
 * Parse JSON, preserving the underlying parse error as `cause`.
 *
 * @param {string} path file to read
 * @param {string} code error code to report if it is missing or unparseable
 * @param {string} hint operator-facing next step for that failure
 * @returns {unknown} the parsed document
 */
function readJson(path, code, hint) {
    if (!existsSync(path)) {
        throw new CoverageBaselineError(code, `${path} does not exist.`, hint);
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new CoverageBaselineError(code, `${path} is not valid JSON: ${error.message}`, hint, error);
    }
}

/**
 * Validate a thresholds map: every metric present, numeric, and a real percentage.
 * A gate at 0 is not a gate, so 0 is rejected too.
 *
 * @param {unknown} thresholds candidate map
 * @param {string} source path it came from, for the error message
 * @returns {Record<string, number>} the validated map
 */
function validateThresholds(thresholds, source) {
    if (thresholds === null || typeof thresholds !== 'object') {
        throw new CoverageBaselineError(
            'baseline-malformed',
            `${source} has no "thresholds" object.`,
            'Regenerate it with `npm run coverage:baseline`.'
        );
    }
    for (const metric of METRICS) {
        const value = thresholds[metric];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
            throw new CoverageBaselineError(
                'baseline-malformed',
                `${source} threshold "${metric}" is ${JSON.stringify(value)}; expected a percentage above 0 and at most 100.`,
                'Regenerate it with `npm run coverage:baseline`.'
            );
        }
    }
    return thresholds;
}

/**
 * Load the committed coverage floor. Used by vite.config.ts, so a missing or
 * malformed file throws instead of falling back to a default: a silently
 * disabled coverage gate is worse than a loud config failure.
 *
 * @param {string} [path] baseline file to read
 * @returns {Record<string, number>} thresholds keyed by metric
 */
export function readCoverageBaseline(path = DEFAULT_BASELINE_PATH) {
    return validateThresholds(readBaselineDocument(path).thresholds, path);
}

/**
 * Read and version-check the baseline document, returning it whole so the
 * generator can carry unknown fields forward.
 *
 * @param {string} path baseline file to read
 * @returns {Record<string, unknown>} the parsed document
 */
function readBaselineDocument(path) {
    const document = readJson(
        path,
        'baseline-missing',
        'Run `npm run test:coverage` then `npm run coverage:baseline` to create it.'
    );
    // An absent version means "written before versioning existed"; a higher one
    // means a newer toolchain wrote fields this reader would misread, and
    // guessing there could silently under-enforce the gate.
    const version = document.schemaVersion ?? SCHEMA_VERSION;
    if (typeof version !== 'number' || version > SCHEMA_VERSION) {
        throw new CoverageBaselineError(
            'baseline-version',
            `${path} declares schemaVersion ${JSON.stringify(document.schemaVersion)}, newer than this checkout understands (${SCHEMA_VERSION}).`,
            'Update scripts/coverage-baseline.mjs to the newer format instead of regenerating over it.'
        );
    }
    return document;
}

/**
 * Round down to two decimals, so a recorded floor is never above the measured
 * percentage it came from.
 *
 * @param {number} pct measured percentage
 * @returns {number} the floor
 */
export function floorPercent(pct) {
    return Math.floor(pct * 100) / 100;
}

/**
 * Read `coverage/coverage-summary.json` (the json-summary reporter's output)
 * and reduce it to a thresholds map.
 *
 * @param {string} [path] summary file to read
 * @returns {Record<string, number>} measured floors keyed by metric
 */
export function readMeasuredThresholds(path = DEFAULT_SUMMARY_PATH) {
    const document = readJson(
        path,
        'summary-missing',
        'Run `npm run test:coverage` first; it writes coverage/coverage-summary.json.'
    );
    const total = document.total;
    if (total === null || typeof total !== 'object') {
        throw new CoverageBaselineError(
            'summary-malformed',
            `${path} has no "total" section.`,
            'Re-run `npm run test:coverage`; the json-summary reporter writes it.'
        );
    }
    const measured = {};
    for (const metric of METRICS) {
        const pct = total[metric]?.pct;
        if (typeof pct !== 'number' || !Number.isFinite(pct)) {
            throw new CoverageBaselineError(
                'summary-malformed',
                `${path} total.${metric}.pct is ${JSON.stringify(pct)}; expected a number.`,
                'Re-run `npm run test:coverage`; a partial report cannot set the floor.'
            );
        }
        measured[metric] = floorPercent(pct);
    }
    return measured;
}

/**
 * @param {string[]} argv raw CLI arguments (without node/script)
 * @returns {{ allowDecrease: boolean, baselinePath: string, summaryPath: string }}
 */
function parseArgs(argv) {
    const options = {
        allowDecrease: false,
        baselinePath: DEFAULT_BASELINE_PATH,
        summaryPath: DEFAULT_SUMMARY_PATH
    };
    const usage = 'Usage: node scripts/coverage-baseline.mjs [--allow-decrease] [--summary <path>] [--baseline <path>]';
    const pathFor = (flag, value) => {
        if (typeof value !== 'string' || value.startsWith('--')) {
            throw new CoverageBaselineError('bad-usage', `${flag} requires a path.`, usage);
        }
        return resolve(value);
    };
    let index = 0;
    while (index < argv.length) {
        const arg = argv[index++];
        if (arg === '--allow-decrease') {
            options.allowDecrease = true;
        } else if (arg === '--summary') {
            options.summaryPath = pathFor(arg, argv[index++]);
        } else if (arg === '--baseline') {
            options.baselinePath = pathFor(arg, argv[index++]);
        } else {
            throw new CoverageBaselineError('bad-usage', `Unknown argument "${arg}".`, usage);
        }
    }
    return options;
}

function main(argv) {
    const { allowDecrease, baselinePath, summaryPath } = parseArgs(argv);
    const measured = readMeasuredThresholds(summaryPath);
    const document = existsSync(baselinePath) ? readBaselineDocument(baselinePath) : null;
    const existing = document === null ? null : validateThresholds(document.thresholds, baselinePath);

    const decreases = existing === null ?
        [] :
        METRICS
            .filter((metric) => measured[metric] < existing[metric])
            .map((metric) => ({ metric, from: existing[metric], to: measured[metric] }));

    if (decreases.length > 0) {
        console.error(`${decreases.length} coverage metric(s) fell below the recorded baseline:`);
        for (const { metric, from, to } of decreases) {
            console.error(`  ${metric}: ${from}% -> ${to}%`);
        }
        if (!allowDecrease) {
            console.error('Refusing to lower the coverage floor: this looks like lost coverage, not intentional.');
            console.error('Add tests to restore it, or if the drop is genuinely intended, re-run with --allow-decrease.');
            return 1;
        }
        console.error('--allow-decrease passed: recording the lower floor above.');
    }

    // Everything this generator does not own is carried forward verbatim, so
    // fields a newer writer added survive a regeneration by an older checkout.
    const carriedForward = { ...document };
    delete carriedForward.schemaVersion;
    delete carriedForward._meta;
    delete carriedForward.thresholds;

    const output = {
        schemaVersion: SCHEMA_VERSION,
        _meta: {
            note: BASELINE_NOTE,
            generatedBy: 'scripts/coverage-baseline.mjs'
        },
        thresholds: Object.fromEntries(METRICS.map((metric) => [ metric, measured[metric] ])),
        ...carriedForward
    };
    writeFileSync(baselinePath, `${JSON.stringify(output, null, 4)}\n`);

    console.log(`Wrote ${baselinePath}`);
    for (const metric of METRICS) {
        const before = existing === null ? 'none' : `${existing[metric]}%`;
        console.log(`  ${metric}: ${before} -> ${measured[metric]}%`);
    }
    return 0;
}

// CLI entry point. Guarded so vite.config.ts can import readCoverageBaseline
// from this file without running the generator.
if (process.argv[1] && resolve(process.argv[1]) === HERE) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        if (error instanceof CoverageBaselineError) {
            console.error(`${error.message}\n${error.hint}`);
            process.exitCode = 1;
        } else {
            throw error;
        }
    }
}
