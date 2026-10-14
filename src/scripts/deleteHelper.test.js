// SlopTank modification notice: added or changed by SlopTank on 2026-09-14, 2026-09-15.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELETE_FAILURE_MESSAGE_KEYS, deleteErrorSuffix, describeDeleteError } from './deleteHelper';

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
});

const STRINGS_DIR = resolve(__dirname, '../strings');
const MAPPED_KEYS = Object.values(DELETE_FAILURE_MESSAGE_KEYS);

function readStrings(file) {
    return JSON.parse(readFileSync(resolve(STRINGS_DIR, file), 'utf8'));
}

/**
 * The framing text is shown in front of the server's reason in every locale,
 * so no locale may carry the old write-access guess under a key the code
 * actually reads. Retired keys must stay retired: they still carry the guess
 * in translated locales that are not edited here.
 */
describe('delete-failure message keys', () => {
    it('carry no write-access guess in any locale', () => {
        const files = readdirSync(STRINGS_DIR).filter(file => file.endsWith('.json'));
        expect(files.length).toBeGreaterThan(1);

        for (const file of files) {
            const strings = readStrings(file);
            for (const key of MAPPED_KEYS) {
                if (strings[key] !== undefined) {
                    expect(strings[key], `${file}: ${key}`).not.toMatch(/write.?access/i);
                }
            }
        }
    });

    it('are all defined in en-us.json', () => {
        const strings = readStrings('en-us.json');

        for (const key of MAPPED_KEYS) {
            expect(strings[key], key).toBeDefined();
        }
    });

    it('do not reuse a retired key', () => {
        for (const key of MAPPED_KEYS) {
            expect(['ErrorDeletingItem', 'ErrorDeletingLyrics'], key).not.toContain(key);
        }
    });

    it('rejects an unknown kind with a TypeError naming it', async () => {
        await expect(async () => describeDeleteError(null, 'nonsense'))
            .rejects.toThrow(TypeError);
        await expect(async () => describeDeleteError(null, 'nonsense'))
            .rejects.toThrow(/nonsense/);
    });
});
