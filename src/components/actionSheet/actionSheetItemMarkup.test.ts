// SlopTank modification notice: added or changed by SlopTank on 2026-10-01.
import { describe, expect, it } from 'vitest';

import { renderActionSheetItems } from './actionSheetItemMarkup';

const ITEM_CLASS = 'listItem listItem-button actionSheetMenuItem';

/**
 * Queue task c307 extended the action sheet with opt-in item fields (badge,
 * chevron). Callers that use none of them must render byte-for-byte as before.
 */
describe('renderActionSheetItems', () => {
    it('renders legacy items (name, selected, asideText, divider) exactly as before', () => {
        const { html, hasLeadingSlot } = renderActionSheetItems([
            { id: 'a', name: 'A', selected: true },
            { id: 'b', name: 'B', asideText: 'aside', secondaryText: 'sub' },
            { divider: true }
        ], ITEM_CLASS, false);

        expect(hasLeadingSlot).toBe(true);
        expect(html).toBe(
            `<button is="emby-button" type="button" class="${ITEM_CLASS}" data-id="a">`
            + '<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons check" aria-hidden="true"></span>'
            + '<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">A</div></div></button>'
            + `<button is="emby-button" type="button" class="${ITEM_CLASS}" data-id="b">`
            + '<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons check" aria-hidden="true" style="visibility:hidden;"></span>'
            + '<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">B</div>'
            + '<div class="listItemBodyText secondary">sub</div></div>'
            + '<div class="listItemAside actionSheetItemAsideText">aside</div></button>'
            + '<div class="actionsheetDivider"></div>'
        );
    });

    it('reports no leading slot when no item has an icon or selection', () => {
        const { hasLeadingSlot } = renderActionSheetItems([ { id: 'a', name: 'A' } ], ITEM_CLASS, false);
        expect(hasLeadingSlot).toBe(false);
    });

    it('renders a text badge pill in the leading slot and a trailing check when selected', () => {
        const { html, hasLeadingSlot } = renderActionSheetItems([
            { id: '3', name: 'English', badge: { text: 'EN' }, selected: true }
        ], ITEM_CLASS, false);

        expect(hasLeadingSlot).toBe(true);
        expect(html).toContain('<span class="actionSheetBadge" aria-hidden="true">EN</span>');
        expect(html).toContain('actionSheetMenuItem-selected');
        expect(html).toContain('actionSheetTrailingCheck');
        expect(html).not.toContain('material-icons check" aria-hidden="true"></span><div');
    });

    it('renders a glyph badge when the badge carries an icon', () => {
        const { html } = renderActionSheetItems([
            { id: '5', name: 'Track', badge: { icon: 'translate' } }
        ], ITEM_CLASS, false);

        expect(html).toContain('actionSheetBadge actionSheetBadge-glyph');
        expect(html).toContain('material-icons translate');
        expect(html).not.toContain('actionSheetTrailingCheck');
        expect(html).not.toContain('actionSheetMenuItem-selected');
    });

    it('renders a chevron after the aside value for submenu rows', () => {
        const { html } = renderActionSheetItems([
            { id: 'x', name: 'Appearance', icon: 'text_fields', asideText: '100%', chevron: true }
        ], ITEM_CLASS, false);

        expect(html.indexOf('actionSheetItemAsideText')).toBeLessThan(html.indexOf('actionSheetChevron'));
        expect(html).toContain('material-icons chevron_right');
    });

    it('escapes badge text and names', () => {
        const { html } = renderActionSheetItems([
            { id: 'x', name: '<b>', badge: { text: '<i>' } }
        ], ITEM_CLASS, false);

        expect(html).not.toContain('<b>');
        expect(html).not.toContain('<i>');
    });
});
