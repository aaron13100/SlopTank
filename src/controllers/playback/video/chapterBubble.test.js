// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import { describe, expect, it } from 'vitest';

import { getChapterBubbleHtml, updateTrickplayBubbleHtml } from './chapterBubble';

/**
 * Behavior-preserving-extraction smoke coverage (queue task c180): these
 * functions moved out of video/index.js verbatim to make room for that
 * file's new subtitle-cycle hotkey without growing an already-oversized
 * file; this confirms the extraction itself did not change behavior.
 */
function fakeApiClient() {
    return {
        getUrl: (path, params) => `https://jellyfin.test.invalid/${path}?ApiKey=${params.ApiKey}`,
        accessToken: () => 'test-token',
        getScaledImageUrl: (itemId, options) => `https://jellyfin.test.invalid/Items/${itemId}/Images/Chapter/${options.index}`
    };
}

describe('updateTrickplayBubbleHtml', () => {
    it('builds the bubble markup on first call and reuses it on the next', () => {
        const bubble = document.createElement('div');
        const item = { Id: 'item-1', Chapters: [ { Name: 'Chapter One', StartPositionTicks: 0 } ] };
        const trickplayInfo = { Width: 100, Height: 60, Interval: 10000, TileWidth: 4, TileHeight: 4 };

        const first = updateTrickplayBubbleHtml(fakeApiClient(), trickplayInfo, item, 'source-1', bubble, 50_000_000);
        expect(first).toBe(true);
        expect(bubble.querySelector('.chapterThumbContainer')).not.toBeNull();
        expect(bubble.querySelector('h2.chapterThumbText')?.textContent).not.toBe('');

        // Second call against the same bubble reuses the existing elements
        // instead of rebuilding them (doFullUpdate stays false).
        const existingContainer = bubble.querySelector('.chapterThumbContainer');
        const second = updateTrickplayBubbleHtml(fakeApiClient(), trickplayInfo, item, 'source-1', bubble, 60_000_000);
        expect(second).toBe(true);
        expect(bubble.querySelector('.chapterThumbContainer')).toBe(existingContainer);
    });
});

describe('getChapterBubbleHtml', () => {
    it('returns null when the current chapter has no image', () => {
        const item = { Id: 'item-1' };
        const chapters = [ { Name: 'Chapter One', StartPositionTicks: 0 } ];

        expect(getChapterBubbleHtml(fakeApiClient(), item, chapters, 0)).toBeNull();
    });

    it('renders the chapter name and an image tag when the chapter has an image', () => {
        const item = { Id: 'item-1' };
        const chapters = [ { Name: 'Chapter <One>', StartPositionTicks: 0, ImageTag: 'tag-1' } ];

        const html = getChapterBubbleHtml(fakeApiClient(), item, chapters, 0);

        expect(html).toContain('<img class="chapterThumb"');
        // Escaped, not raw: the name can contain characters from an
        // untrusted source (item metadata) and is concatenated into HTML.
        expect(html).toContain('Chapter &lt;One&gt;');
        expect(html).not.toContain('Chapter <One>');
    });
});
