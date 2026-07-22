/**
 * Regression coverage for the GitHub Actions manifests that users exercise by opening pull
 * requests or pushing branches to SlopTank. These assertions keep upstream-only Jellyfin gates
 * and credentials from silently disabling the fork's jobs after an upstream workflow merge.
 */
import { describe, expect, it } from 'vitest';

const workflows = import.meta.glob('../.github/workflows/*.{yml,yaml}', {
    eager: true,
    import: 'default',
    query: '?raw'
}) as Record<string, string>;

const workflowText = Object.entries(workflows)
    .map(([ path, contents ]) => `FILE: ${path}\n${contents}`)
    .join('\n');

describe('SlopTank GitHub Actions repository policy', () => {
    it('does not silently gate jobs to the upstream Jellyfin repository', () => {
        expect(workflowText).not.toMatch(
            /github\.repository\s*==\s*['"]jellyfin\/jellyfin-web['"]/
        );
    });

    it('does not retain broad Jellyfin-organization repository gates', () => {
        expect(workflowText).not.toMatch(
            /contains\(github\.repository,\s*['"]jellyfin\/['"]\)/
        );
    });

    it('does not depend on Jellyfin bot credentials unavailable to SlopTank', () => {
        expect(workflowText).not.toContain('JF_BOT_TOKEN');
    });
});
