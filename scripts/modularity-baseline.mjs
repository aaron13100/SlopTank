#!/usr/bin/env node
// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-09-09.
// scripts/modularity-baseline.mjs - (Re)generate src/modularity.ignore.json
//
// src/modularity.test.js enforces file/function/class line limits as a
// BASELINE RATCHET: this repo is a ~790-file fork of upstream jellyfin-web
// written to no such limits, so a greenfield gate would fail on a large
// fraction of the tree on day one. src/modularity.ignore.json snapshots the
// violations that already existed when the gate was scaffolded (2026-07-23)
// as recorded DEBT, not a licence to add more: anything not already in the
// snapshot must fit under the real limits, and this generator refuses to let
// an existing entry grow silently.
//
// The gate lives at src/modularity.test.js rather than the checklist's usual
// tests/modularity.test.js because tests/ is a reserved private root in this
// fork's public-boundary policy (tools/public-boundary-manifest.json PB-001).
// protect-modularity-test.sh locks by basename only, so the owner-lock still
// applies at this path. See t_260723_054720_705.
//
// This scan logic is deliberately duplicated (not imported) inside
// src/modularity.test.js. That test file is owner-locked by
// protect-modularity-test.sh specifically so Claude cannot weaken the gate;
// if this script's logic were imported by the test, editing this editable
// script would be an equivalent way to weaken it. Keep the two copies in
// sync by hand if the scan logic ever changes.
//
// Usage:
//   node scripts/modularity-baseline.mjs                # regenerate; refuses if any entry would grow
//   node scripts/modularity-baseline.mjs --allow-growth  # regenerate; logs and allows entries that grew
//   node scripts/modularity-baseline.mjs --check         # dry run; exit 1 if the file is stale

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const IGNORE_PATH = join(SRC, 'modularity.ignore.json');

const FILE_LIMIT = 300;
const FUNCTION_LIMIT = 50;
const CLASS_LIMIT = 200;

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const TEST_EXT = /\.(test|spec)\.[jt]sx?$/;

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (CODE_EXT.test(entry.name) && !TEST_EXT.test(entry.name)) return [full];
        return [];
    });
}

function countCodeLines(text) {
    return text.split('\n').filter((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    }).length;
}

function scriptKindFor(path) {
    if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (path.endsWith('.ts')) return ts.ScriptKind.TS;
    if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
}

function nameOf(node, sourceFile) {
    if (node.name) return node.name.getText(sourceFile);
    const parent = node.parent;
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name) {
        return parent.name.getText(sourceFile);
    }
    return '<anonymous>';
}

function collectSpans(sourceFile, text) {
    const functions = [];
    const classes = [];
    function visit(node) {
        if (
            ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
            || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
            || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node)
        ) {
            if (node.body) {
                const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
                const bodyText = text.slice(node.body.getFullStart(), node.body.getEnd());
                functions.push({ name: nameOf(node, sourceFile), startLine, lines: countCodeLines(bodyText) });
            }
        } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            const bodyText = text.slice(node.getStart(sourceFile), node.getEnd());
            classes.push({ name: nameOf(node, sourceFile) || '<anonymous>', startLine, lines: countCodeLines(bodyText) });
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return { functions, classes };
}

function scan() {
    const files = walk(SRC).map((f) => relative(ROOT, f)).sort();
    const result = { files: {}, functions: {}, classes: {} };

    for (const file of files) {
        const text = readFileSync(join(ROOT, file), 'utf8');
        const lines = countCodeLines(text);
        if (lines > FILE_LIMIT) result.files[file] = lines;

        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
        const { functions, classes } = collectSpans(sourceFile, text);
        for (const fn of functions) {
            if (fn.lines > FUNCTION_LIMIT) {
                const key = `${file}::${fn.name}::${fn.startLine}`;
                result.functions[key] = fn.lines;
            }
        }
        for (const cls of classes) {
            if (cls.lines > CLASS_LIMIT) {
                const key = `${file}::${cls.name}::${cls.startLine}`;
                result.classes[key] = cls.lines;
            }
        }
    }
    return result;
}

function diffGrowth(oldSection, newSection) {
    const grown = [];
    for (const [key, newCount] of Object.entries(newSection)) {
        const oldCount = oldSection[key];
        if (oldCount !== undefined && newCount > oldCount) {
            grown.push({ key, oldCount, newCount });
        }
    }
    return grown;
}

const args = process.argv.slice(2);
const allowGrowth = args.includes('--allow-growth');
const checkOnly = args.includes('--check');

const existing = existsSync(IGNORE_PATH) ?
    JSON.parse(readFileSync(IGNORE_PATH, 'utf8')) :
    { files: {}, functions: {}, classes: {} };

const scanned = scan();

const grownFiles = diffGrowth(existing.files ?? {}, scanned.files);
const grownFunctions = diffGrowth(existing.functions ?? {}, scanned.functions);
const grownClasses = diffGrowth(existing.classes ?? {}, scanned.classes);
const allGrown = [...grownFiles, ...grownFunctions, ...grownClasses];

if (allGrown.length > 0) {
    console.error(`${allGrown.length} entries grew past their recorded baseline:`);
    for (const { key, oldCount, newCount } of allGrown) {
        console.error(`  ${key}: ${oldCount} -> ${newCount}`);
    }
    if (!allowGrowth) {
        console.error('Refusing to regenerate the baseline: this looks like a regression, not intentional debt.');
        console.error('Fix the regression, or if the growth is genuinely intentional, re-run with --allow-growth.');
        process.exit(1);
    }
    console.error('--allow-growth passed: recording the growth above as new debt.');
}

const output = {
    _meta: {
        note: 'Baseline ratchet snapshot for the modularity gate (src/modularity.test.js). '
            + 'Entries are recorded debt from before this gate existed, not a licence to add more: '
            + 'anything not listed here must fit under the limits below. Regenerate with '
            + '`node scripts/modularity-baseline.mjs` after shrinking a file/function/class; the '
            + 'generator refuses silent growth unless --allow-growth is passed.',
        fileLimit: FILE_LIMIT,
        functionLimit: FUNCTION_LIMIT,
        classLimit: CLASS_LIMIT,
        generatedBy: 'scripts/modularity-baseline.mjs'
    },
    files: scanned.files,
    functions: scanned.functions,
    classes: scanned.classes
};

if (checkOnly) {
    const same = JSON.stringify(existing.files) === JSON.stringify(output.files)
        && JSON.stringify(existing.functions) === JSON.stringify(output.functions)
        && JSON.stringify(existing.classes) === JSON.stringify(output.classes);
    if (!same || allGrown.length > 0) {
        console.error('src/modularity.ignore.json is stale. Run `node scripts/modularity-baseline.mjs` to refresh it.');
        process.exit(1);
    }
    console.log('src/modularity.ignore.json is up to date.');
    process.exit(0);
}

writeFileSync(IGNORE_PATH, `${JSON.stringify(output, null, 4)}\n`);
console.log(`Wrote ${IGNORE_PATH}`);
console.log(`files: ${Object.keys(output.files).length}, functions: ${Object.keys(output.functions).length}, classes: ${Object.keys(output.classes).length}`);
