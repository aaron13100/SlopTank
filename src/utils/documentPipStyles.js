// SlopTank modification notice: added or changed by SlopTank on 2026-09-30, 2026-10-01.
/**
 * Copies an app document's loaded styles into another document (the Document
 * Picture-in-Picture popup), which resolves CSS against its own stylesheets
 * only.
 *
 * Lives in utils, not src/plugins: pluginManager bundles every file under
 * src/plugins through a dynamic import context, which would drag this module's
 * vitest test into the production build and trip the boundary plugin.
 */

/**
 * Attribute that marks every node this module adds, so a later copy can
 * remove the previous one.
 */
export const COPIED_STYLE_ATTRIBUTE = 'data-sloptank-pip-style';

/**
 * Copy every stylesheet of `sourceDocument` into the head of `targetDocument`,
 * replacing any earlier copy.
 *
 * `<link>` sheets are re-linked by absolute URL. `<style>` sheets are copied
 * from their live rules, not their text: CSS-in-JS runtimes (Emotion in
 * production "speedy" mode, which MUI uses) fill a `<style>` through
 * `insertRule`, leaving its text content empty, so cloning the node copies
 * nothing and every theme variable and MUI rule they hold is missing in the
 * popup.
 *
 * Limitation: a snapshot. Rules a runtime inserts after the copy do not
 * propagate.
 * @param {Document} sourceDocument - Document whose styles are copied.
 * @param {Document} targetDocument - Document receiving the copies.
 * @returns {void}
 */
export function copyDocumentStyles(sourceDocument, targetDocument) {
    targetDocument.querySelectorAll(`[${COPIED_STYLE_ATTRIBUTE}]`)
        .forEach(element => {
            element.remove();
        });

    for (const source of sourceDocument.querySelectorAll('link[rel="stylesheet"], style')) {
        const copy = source.cloneNode(true);
        copy.setAttribute(COPIED_STYLE_ATTRIBUTE, '');
        if (source instanceof HTMLLinkElement && copy instanceof HTMLLinkElement) {
            copy.href = source.href;
        } else if (source instanceof HTMLStyleElement && !source.textContent && source.sheet) {
            copy.textContent = Array.from(source.sheet.cssRules).map(rule => rule.cssText).join('\n');
        }
        targetDocument.head.appendChild(copy);
    }
}
