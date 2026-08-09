import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the bug class behind "Failed to initialize ASS renderer".
 *
 * Several modules export their functions by name AND ship a hand-written
 * `export default { ... }` object re-listing them. Consumers that default-import
 * such a module see only what the object lists, so adding a named export without
 * also adding it to the object leaves the call site invoking `undefined` at
 * runtime. Unit tests never catch it, because they import by name.
 *
 * That is exactly how `getAssSubtitleVerticalOffsetPercentage` shipped broken:
 * exported and unit-tested by name, absent from the default object, and called
 * through it by htmlVideoPlayer/plugin.js on every ASS subtitle selection.
 *
 * The fix for that module was to drop the duplicated object and use a namespace
 * import, which cannot drift. This test stops the shape returning elsewhere: a
 * default-export object may lag its named exports only while nothing calls the
 * missing name through it.
 */

const SOURCE_ROOT = join(__dirname);
const SOURCE_EXTENSIONS = [ '.js', '.jsx', '.ts', '.tsx' ];

/** Every source file under src/, excluding tests and vendored trees. */
function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            sourceFiles(full, found);
        } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))
            && !/\.(test|spec)\./.test(entry)) {
            found.push(full);
        }
    }
    return found;
}

/**
 * Keys of a module's top-level `export default { ... }`, by brace matching.
 *
 * @param source - File contents.
 * @returns The listed keys, or null when the module has no such object.
 */
export function defaultExportKeys(source: string): Set<string> | null {
    const opener = /export default\s*\{/.exec(source);
    if (!opener) return null;

    const start = opener.index + opener[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = start; i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) {
        return null;
    }

    const keys = new Set<string>();
    for (const line of source.slice(start + 1, end).split('\n')) {
        const key = /^([A-Za-z_$][\w$]*)\s*(?::|,|$)/.exec(line.trim());
        if (key) keys.add(key[1]);
    }
    return keys;
}

/**
 * Names a module exports individually.
 *
 * @param source - File contents.
 * @returns The exported binding names.
 */
export function namedExports(source: string): Set<string> {
    return new Set(
        [ ...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm) ]
            .map((match) => match[1])
    );
}

/**
 * Default imports of relative specifiers, as [binding, specifier] pairs.
 *
 * @param source - File contents.
 * @returns One entry per `import Binding[, { ... }] from './specifier'`.
 */
export function defaultImportsIn(source: string): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    for (const line of source.split('\n')) {
        // `import type { X } from ...` is a type-only named import, not a
        // default import; its binding word is the `type` keyword.
        const binding = /^import\s+(?!type\b)([A-Za-z_$][\w$]*)/.exec(line);
        if (!binding) {
            continue;
        }
        const specifier = /from\s*['"](\.[^'"]*)['"]/.exec(line);
        if (specifier) {
            found.push([ binding[1], specifier[1] ]);
        }
    }
    return found;
}

/**
 * Whether a module provides a default export at all, in any spelling.
 *
 * @param source - File contents.
 * @returns True when something is exported as default.
 */
export function hasDefaultExport(source: string): boolean {
    return /^export\s+default\b/m.test(source) || /\bas\s+default\b/.test(source);
}

/**
 * Resolve a relative import specifier to a file on disk.
 *
 * @param fromFile - Importing file's path.
 * @param specifier - The relative specifier.
 * @returns Resolved path, or null when it is not a local source file.
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | null {
    const base = join(fromFile, '..', specifier);
    for (const candidate of [
        base,
        ...SOURCE_EXTENSIONS.map((ext) => base + ext),
        ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`))
    ]) {
        // existsSync rather than a try/catch around statSync: a specifier that
        // resolves to nothing on disk is an alias or a package, which is a
        // normal outcome here and not an error to swallow.
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

describe('default-export surfaces cannot drift from named exports', () => {
    // webpack only WARNS on a default import of a module with no default
    // export, and a warning does not fail a build. That is how
    // subtitlesettings.js kept a stale default import through a clean
    // production build; only reading the build log caught it. eslint does not
    // cover it either: `import/default` is enabled via
    // `importPlugin.flatConfigs.errors` but was probed against exactly this
    // case on 2026-08-09 and reported nothing.
    it('tells a default import apart from a type-only or named import', () => {
        expect(defaultImportsIn("import helper from './helper';")).toEqual([ [ 'helper', './helper' ] ]);
        expect(defaultImportsIn("import helper, { named } from './helper';")).toEqual([ [ 'helper', './helper' ] ]);
        expect(defaultImportsIn("import type { Thing } from './types';")).toEqual([]);
        expect(defaultImportsIn("import { named } from './helper';")).toEqual([]);
        expect(defaultImportsIn("import * as ns from './helper';")).toEqual([]);
    });

    it('detects a default import of a module that exports no default', () => {
        expect(hasDefaultExport('export function named() {}')).toBe(false);
        expect(hasDefaultExport('export default {\n    named\n};')).toBe(true);
        expect(hasDefaultExport('function x() {}\nexport { x as default };')).toBe(true);
    });

    it('no file default-imports a local module that has no default export', () => {
        const contents = new Map(
            sourceFiles(SOURCE_ROOT).map((file) => [ file, readFileSync(file, 'utf8') ])
        );
        const broken: string[] = [];

        for (const [ file, source ] of contents) {
            // Parsed line by line rather than with one combined regex: the
            // pattern that spans binding, optional named clause and specifier
            // needs nested quantifiers, which backtrack super-linearly.
            for (const [ binding, specifier ] of defaultImportsIn(source)) {
                // webpack synthesizes the default export for worker modules,
                // so a `.worker` import legitimately has none in source.
                if (/\.worker(\.\w+)?$/.test(specifier)) {
                    continue;
                }
                const resolved = resolveRelativeImport(file, specifier);
                if (!resolved) {
                    continue;
                }
                const target = contents.get(resolved);
                if (target !== undefined && !hasDefaultExport(target)) {
                    broken.push(`${file}: default-imports ${binding} from ${specifier}, which has no default export`);
                }
            }
        }

        expect(broken).toEqual([]);
    });

    // The detector has to be able to report both answers, or a clean sweep
    // proves nothing. These two cases are the controls.
    it('detects a default object that omits a named export', () => {
        const drifted = [
            'export function kept() {}',
            'export function forgotten() {}',
            'export default {',
            '    kept',
            '};'
        ].join('\n');
        const missing = [ ...namedExports(drifted) ]
            .filter((name) => !defaultExportKeys(drifted)?.has(name));
        expect(missing).toEqual([ 'forgotten' ]);
    });

    it('reports a complete default object as clean', () => {
        const complete = [
            'export function kept() {}',
            'export function alsoKept() {}',
            'export default {',
            '    kept,',
            '    alsoKept',
            '};'
        ].join('\n');
        const missing = [ ...namedExports(complete) ]
            .filter((name) => !defaultExportKeys(complete)?.has(name));
        expect(missing).toEqual([]);
    });

    it('no default-import call site reaches a name the default object omits', () => {
        const contents = new Map(
            sourceFiles(SOURCE_ROOT).map((file) => [ file, readFileSync(file, 'utf8') ])
        );
        const drifting = findDriftingModules(contents);

        const reachable: string[] = [];
        for (const [ file, source ] of contents) {
            reachable.push(...findReachableOmissions(file, source, drifting));
        }

        expect(reachable).toEqual([]);
    });
});

/**
 * Modules whose default object re-lists named exports, but not all of them.
 *
 * @param contents - Source file path to contents.
 * @returns Module path to the names its default object leaves out.
 */
function findDriftingModules(contents: Map<string, string>): Map<string, Set<string>> {
    const drifting = new Map<string, Set<string>>();
    for (const [ file, source ] of contents) {
        const listed = defaultExportKeys(source);
        if (!listed) {
            continue;
        }
        const named = namedExports(source);
        // Only an object that re-lists this module's own exports can drift from
        // them; an unrelated default export (a config, a component) cannot.
        if (![ ...named ].some((name) => listed.has(name))) {
            continue;
        }
        const omitted = new Set([ ...named ].filter((name) => !listed.has(name)));
        if (omitted.size) {
            drifting.set(file, omitted);
        }
    }
    return drifting;
}

/**
 * Call sites in one file that reach an omitted name through a default import.
 *
 * @param file - Path of the consuming file.
 * @param source - Its contents.
 * @param drifting - Output of findDriftingModules.
 * @returns Human-readable descriptions of each live mismatch.
 */
function findReachableOmissions(
    file: string,
    source: string,
    drifting: Map<string, Set<string>>
): string[] {
    const found: string[] = [];
    for (const [ modulePath, omitted ] of drifting) {
        const stem = modulePath.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
        const imports = source.matchAll(new RegExp(
            `^import\\s+([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*['"][^'"]*${stem}['"]`,
            'gm'
        ));
        for (const importMatch of imports) {
            for (const name of omitted) {
                if (new RegExp(`\\b${importMatch[1]}\\.${name}\\b`).test(source)) {
                    found.push(
                        `${file}: ${importMatch[1]}.${name} is not in the default export of ${modulePath}`
                    );
                }
            }
        }
    }
    return found;
}
