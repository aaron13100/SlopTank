/**
 * Apply SlopTank's modern-authorization compatibility patch to the archived
 * jellyfin-apiclient package after dependency installation.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LEGACY_TOKEN = '?api_key=';
const CANONICAL_TOKEN = '?ApiKey=';
const DEFAULT_ARTIFACTS = [
    fileURLToPath(new URL('../node_modules/jellyfin-apiclient/dist/jellyfin-apiclient.js', import.meta.url)),
    fileURLToPath(new URL('../node_modules/jellyfin-apiclient/dist/jellyfin-apiclient.js.map', import.meta.url))
];

class DependencyPatchError extends Error {
    /**
     * Describe a dependency patch failure with an actionable code and hint.
     *
     * @param {object} options - Structured failure context.
     * @param {unknown} [options.cause] - Underlying filesystem error, when present.
     * @param {string} options.code - Stable failure code for diagnostics.
     * @param {string} options.hint - Action that should resolve the failure.
     * @param {string} options.message - Specific failure detail.
     */
    constructor({ cause, code, hint, message }) {
        super(message, { cause });
        this.name = 'DependencyPatchError';
        this.code = code;
        this.hint = hint;
    }
}

/**
 * Count non-overlapping occurrences of a literal string.
 *
 * @param {string} source - Text to inspect.
 * @param {string} token - Literal token to count.
 * @returns {number} Number of occurrences.
 */
function countOccurrences(source, token) {
    return source.split(token).length - 1;
}

/**
 * Validate and prepare one dependency artifact without writing it.
 *
 * @param {string} path - Artifact path used in diagnostic messages.
 * @param {string} source - Installed artifact contents.
 * @returns {{ changed: boolean, path: string, source: string }} Prepared artifact.
 */
function prepareArtifact(path, source) {
    const legacyCount = countOccurrences(source, LEGACY_TOKEN);
    const canonicalCount = countOccurrences(source, CANONICAL_TOKEN);

    if (legacyCount === 1 && canonicalCount === 0) {
        return {
            changed: true,
            path,
            source: source.replace(LEGACY_TOKEN, CANONICAL_TOKEN)
        };
    }

    if (legacyCount === 0 && canonicalCount === 1) {
        return { changed: false, path, source };
    }

    throw new DependencyPatchError({
        code: 'DEPENDENCY_PATCH_SHAPE_MISMATCH',
        hint: 'Verify jellyfin-apiclient is still pinned to 1.11.0, then update this patch for the new artifact shape.',
        message: `Expected exactly one legacy or canonical WebSocket token in ${path}; found ${legacyCount} legacy and ${canonicalCount} canonical tokens.`
    });
}

/**
 * Patch all artifacts only after every input has been read and validated.
 *
 * @param {string[]} paths - Bundle and source-map paths to patch.
 * @returns {Promise<number>} Number of artifacts changed.
 */
async function patchArtifacts(paths) {
    let sources;
    try {
        sources = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    } catch (cause) {
        throw new DependencyPatchError({
            cause,
            code: 'DEPENDENCY_ARTIFACT_UNREADABLE',
            hint: 'Run npm install with Node 24+ and confirm jellyfin-apiclient@1.11.0 is present.',
            message: `Could not read dependency artifact: ${cause instanceof Error ? cause.message : String(cause)}`
        });
    }

    const prepared = paths.map((path, index) => prepareArtifact(path, sources[index]));
    const changed = prepared.filter(artifact => artifact.changed);
    await Promise.all(changed.map(artifact => writeFile(artifact.path, artifact.source)));
    return changed.length;
}

const artifactPaths = process.argv.slice(2);
const paths = artifactPaths.length > 0 ? artifactPaths : DEFAULT_ARTIFACTS;

if (paths.length !== 2) {
    console.error('DependencyPatchError [DEPENDENCY_ARTIFACT_COUNT]: expected exactly two artifact paths (bundle and source map). Hint: omit arguments for the installed dependency, or pass both fixture paths.');
    process.exitCode = 1;
} else {
    try {
        const changedCount = await patchArtifacts(paths);
        console.log(`jellyfin-apiclient WebSocket authorization patch ready (${changedCount} artifact${changedCount === 1 ? '' : 's'} changed).`);
    } catch (error) {
        if (error instanceof DependencyPatchError) {
            console.error(`${error.name} [${error.code}]: ${error.message} Hint: ${error.hint}`);
        } else {
            console.error(`DependencyPatchError [UNEXPECTED_FAILURE]: ${error instanceof Error ? error.message : String(error)}. Hint: inspect the installed jellyfin-apiclient artifacts before retrying.`);
        }
        process.exitCode = 1;
    }
}
