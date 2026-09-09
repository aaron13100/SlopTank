// SlopTank modification notice: added or changed by SlopTank on 2026-07-22, 2026-07-23, 2026-07-24, 2026-09-09.
/**
 * Regression coverage for the GitHub Actions manifests that users exercise by opening pull
 * requests or pushing branches to SlopTank. These assertions keep upstream-only Jellyfin gates
 * and credentials from silently disabling the fork's jobs after an upstream workflow merge.
 */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';

const workflows = import.meta.glob('../.github/workflows/*.{yml,yaml}', {
    eager: true,
    import: 'default',
    query: '?raw'
}) as Record<string, string>;
const playwrightConfig = import.meta.glob('../playwright.config.ts', {
    eager: true,
    import: 'default',
    query: '?raw'
})['../playwright.config.ts'] as string;

const workflowText = Object.entries(workflows)
    .map(([ path, contents ]) => `FILE: ${path}\n${contents}`)
    .join('\n');

const pullRequestWorkflow = workflows['../.github/workflows/pull_request.yml'];
const qualityChecksWorkflow = workflows['../.github/workflows/__quality_checks.yml'];
const publicWorkflowText = `${pullRequestWorkflow}\n${qualityChecksWorkflow}`;

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

    it('runs fork pull requests with a read-only token and no secrets', () => {
        expect(pullRequestWorkflow).toMatch(/^on:\n {2}pull_request:/m);
        expect(pullRequestWorkflow).not.toContain('pull_request_target');
        expect(pullRequestWorkflow).not.toContain('paths-ignore');
        expect(pullRequestWorkflow).toMatch(/^permissions:\n {2}contents: read$/m);
        expect(publicWorkflowText.split('\n').some(line => line.trim().endsWith(': write'))).toBe(false);
        expect(publicWorkflowText.split('\n').some(line => line.trimStart().startsWith('secrets:'))).toBe(false);
    });

    it('labels contributor-visible checks as the public tier', () => {
        expect(pullRequestWorkflow).toMatch(/^name: Public pull request checks /m);
        expect(qualityChecksWorkflow).toMatch(/^name: Public quality checks /m);
        expect(qualityChecksWorkflow).toMatch(/^ {4}name: 'Public quality: Run [^']+'$/m);
    });

    it('exposes only the public quality job on pull requests', () => {
        const lines = pullRequestWorkflow.split('\n');
        const jobsStart = lines.indexOf('jobs:');
        const jobNames = lines.slice(jobsStart + 1)
            .filter(line => line.startsWith('  ') && !line.startsWith('    ') && line.endsWith(':'))
            .map(line => line.slice(2, -1));

        expect(jobNames).toEqual([ 'quality_checks', 'product_identity' ]);
    });

    it('keeps the quality matrix limited to build, lint, type-check, and public smoke commands', () => {
        const lines = qualityChecksWorkflow.split('\n');
        const commandsStart = lines.indexOf('        command:');
        const commands = lines.slice(commandsStart + 1)
            .filter(line => line.startsWith('          - '))
            .map(line => line.slice('          - '.length));

        expect(commands).toEqual([
            'build:es-check',
            'features',
            'depcruise',
            'lint',
            'stylelint',
            'build:check',
            'test:coverage'
        ]);
        expect(qualityChecksWorkflow).not.toMatch(
            /private-tests|hidden-tests|sloptank-tests/
        );
    });

    it('removes checkout credentials before contributor scripts execute', () => {
        const checkoutSteps = qualityChecksWorkflow
            .split(/\n(?= {6}- name:)/)
            .filter(step => step.includes('uses: actions/checkout@'));

        expect(checkoutSteps).toHaveLength(3);
        for (const checkoutStep of checkoutSteps) {
            expect(checkoutStep).toMatch(/persist-credentials:\s+false/);
        }
    });

    it('runs the Playwright suite against a real SlopTank server on pull requests', () => {
        expect(qualityChecksWorkflow).toMatch(/^ {2}e2e:\n/m);
        expect(qualityChecksWorkflow).toContain('repository: aaron13100/SlopTank-server');
        expect(qualityChecksWorkflow).toMatch(/ref:\s+[0-9a-f]{40}/);
        expect(qualityChecksWorkflow).toContain('npm run build:production');
        expect(qualityChecksWorkflow).toContain('dotnet run --project server/Jellyfin.Server');
        expect(qualityChecksWorkflow).toContain('npm run test:e2e');
        expect(qualityChecksWorkflow).toMatch(/env:\n {6}CI: true/);
        expect(playwrightConfig).toContain('workers: process.env.CI ? 1 : undefined');
    });

    it('builds a disposable media fixture without exposing credentials to fork PRs', () => {
        expect(qualityChecksWorkflow).toContain('ci-e2e-fixture.mp4');
        expect(qualityChecksWorkflow).toContain('ci-e2e-fixture.en.srt');
        expect(qualityChecksWorkflow).toContain('ci-e2e-transcode.mkv');
        expect(qualityChecksWorkflow).toContain('provision-server.mjs');
        expect(qualityChecksWorkflow.split('\n').some(line => line.trimStart().startsWith('secrets:'))).toBe(false);
        expect(qualityChecksWorkflow).toContain('persist-credentials: false');
    });
});
