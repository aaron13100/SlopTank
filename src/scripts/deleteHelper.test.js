// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteErrorSuffix } from './deleteHelper';

/**
 * Regression coverage for the misleading delete-failure message (c47): the
 * old handler discarded the rejection entirely and asserted a permissions
 * cause the server never stated, sending the owner to check folder write
 * access for a permalink fence. The surfaced text must carry the real
 * refusal (the ProblemDetails title is the fence code) and the shipped
 * strings must never claim a write-access cause. The suffix extractor is
 * pure, so these tests drive it directly with the rejection shapes the api
 * client actually produces; no internal module is mocked.
 */
describe('deleteErrorSuffix', () => {
    it('surfaces the fence code and detail from a ProblemDetails body', async () => {
        const err = {
            status: 409,
            text: () => Promise.resolve(JSON.stringify({
                title: 'content-mismatch',
                detail: "Current content for '/media/F1.mp4' does not match capsule '49643eb3'."
            }))
        };

        const suffix = await deleteErrorSuffix(err);

        expect(suffix).toContain('content-mismatch');
        expect(suffix).toContain("Current content for '/media/F1.mp4'");
        expect(suffix).not.toContain('write access');
    });

    it('falls back to the HTTP status when the body carries nothing usable', async () => {
        const suffix = await deleteErrorSuffix({ status: 500, text: () => Promise.resolve('') });

        expect(suffix).toBe(' (HTTP 500)');
    });

    it('uses an error message when no response surface exists', async () => {
        const suffix = await deleteErrorSuffix(new Error('network down'));

        expect(suffix).toBe(' (network down)');
    });

    it('degrades to empty for an empty rejection', async () => {
        expect(await deleteErrorSuffix(null)).toBe('');
    });

    it('never ships a write-access guess in the delete-failure strings', () => {
        const strings = JSON.parse(
            readFileSync(resolve(__dirname, '../strings/en-us.json'), 'utf8'));

        for (const key of ['ErrorDeletingItem', 'ErrorDeletingLyrics']) {
            expect(strings[key], key).toBeDefined();
            expect(strings[key], key).not.toContain('write access');
        }
    });
});
