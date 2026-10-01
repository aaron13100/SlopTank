// SlopTank modification notice: added or changed by SlopTank on 2026-09-30.
/**
 * The Document Picture-in-Picture popup only has the styles copied into it.
 * Production CSS-in-JS (Emotion speedy mode) keeps its rules in the CSSOM with
 * an empty text node, which a plain node clone silently drops.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { copyDocumentStyles, COPIED_STYLE_ATTRIBUTE } from './documentPipStyles';

function cssText(styleElement) {
    return Array.from(styleElement.sheet.cssRules).map(rule => rule.cssText).join('\n');
}

function copiedStyles(targetDocument) {
    return Array.from(targetDocument.head.querySelectorAll(`style[${COPIED_STYLE_ATTRIBUTE}]`));
}

/** An iframe document stands in for the popup: it has a browsing context, so its styles parse into sheets. */
function newTargetDocument() {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    return frame.contentDocument;
}

describe('copyDocumentStyles', () => {
    afterEach(() => {
        document.body.querySelectorAll('iframe').forEach(element => element.remove());
        document.head.querySelectorAll('style').forEach(element => element.remove());
    });

    it('copies rules a runtime inserted with insertRule into an empty style element', () => {
        const source = document.createElement('style');
        source.setAttribute('data-emotion', 'css');
        document.head.appendChild(source);
        source.sheet.insertRule(':root { --jf-palette-background-paper: #0e1d2a; }', 0);
        expect(source.textContent).toBe('');

        const target = newTargetDocument();
        copyDocumentStyles(document, target);

        const copies = copiedStyles(target);
        expect(copies).toHaveLength(1);
        expect(cssText(copies[0])).toContain('--jf-palette-background-paper');
        expect(copies[0].getAttribute('data-emotion')).toBe('css');
    });

    it('copies ordinary text-filled style elements', () => {
        const source = document.createElement('style');
        source.textContent = '.plain { color: red; }';
        document.head.appendChild(source);

        const target = newTargetDocument();
        copyDocumentStyles(document, target);

        expect(cssText(copiedStyles(target)[0])).toContain('.plain');
    });

    it('replaces an earlier copy instead of stacking a second one', () => {
        const source = document.createElement('style');
        source.textContent = '.once { color: red; }';
        document.head.appendChild(source);

        const target = newTargetDocument();
        copyDocumentStyles(document, target);
        copyDocumentStyles(document, target);

        expect(copiedStyles(target)).toHaveLength(1);
    });
});
