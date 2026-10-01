// SlopTank modification notice: added or changed by SlopTank on 2026-10-01.
/**
 * Pure markup rendering for action sheet rows. Kept apart from the dialog
 * lifecycle in actionSheet.ts so the item model can be tested without the
 * dialog, layout and router modules that the sheet itself pulls in.
 * @module components/actionSheet/actionSheetItemMarkup
 */

import escapeHtml from 'escape-html';

/**
 * Leading pill for a row: short text (an ISO 639 language code) or, when no
 * text applies, a glyph from the material icon font.
 */
export interface ItemBadge {
    /** Short label rendered inside the pill. Wins over `icon`. */
    text?: string;
    /** Material icon name used when there is no `text`. */
    icon?: string;
}

/**
 * One action sheet row. Every field beyond `id`/`name`/`selected`/`asideText`
 * is opt-in; a caller that sets none of them renders exactly as it always did.
 */
export interface OptionItem {
    asideText?: string;
    /** Opt-in leading pill; replaces the leading icon slot and moves the selected check to the trailing edge. */
    badge?: ItemBadge;
    /** Opt-in trailing chevron marking a row that opens a submenu. */
    chevron?: boolean;
    divider?: boolean;
    icon?: string;
    id?: string | number;
    innerText?: string;
    name?: string;
    secondaryText?: string;
    selected?: boolean;
    textContent?: string;
    value?: string;
}

/** Result of rendering a list of rows. */
export interface RenderedItems {
    /** Markup for every row, in order. */
    html: string;
    /** True when at least one row reserves a leading icon/badge slot, so the sheet left-aligns instead of centering. */
    hasLeadingSlot: boolean;
}

function renderBadge(badge: ItemBadge): string {
    if (badge.text) {
        return `<span class="actionSheetBadge" aria-hidden="true">${escapeHtml(badge.text)}</span>`;
    }

    return '<span class="actionSheetBadge actionSheetBadge-glyph" aria-hidden="true">'
        + `<span class="material-icons ${escapeHtml(badge.icon || 'translate')}"></span></span>`;
}

/**
 * Render the rows of an action sheet.
 * @param items - Rows to render, dividers included.
 * @param menuItemClass - Class list applied to every row button.
 * @param isTv - Whether the TV layout is active (marks the first selected row for autofocus).
 * @returns The markup and whether a leading slot is reserved.
 */
export function renderActionSheetItems(items: OptionItem[], menuItemClass: string, isTv: boolean): RenderedItems {
    // A badged row keeps its selection in a trailing check, so the leading
    // slot belongs to the badge; every other row keeps the historic rule.
    let hasLeadingSlot = false;
    const icons: string[] = [];
    for (const item of items) {
        const itemIcon = item.badge ? null : (item.icon || (item.selected ? 'check' : null));

        if (itemIcon || item.badge) {
            hasLeadingSlot = true;
        }
        icons.push(itemIcon || '');
    }

    let html = '';

    // 'items' may be an HTMLOptionsCollection, so no fancy loops
    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.divider) {
            html += '<div class="actionsheetDivider"></div>';
            continue;
        }

        const autoFocus = item.selected && isTv ? ' autoFocus' : '';
        const isBadgeSelected = !!item.badge && !!item.selected;
        let rowClass = menuItemClass;
        if (isBadgeSelected) {
            rowClass += ' actionSheetMenuItem-selected';
        }
        if (item.chevron) {
            rowClass += ' actionSheetMenuItem-submenu';
        }

        // Check for null in case int 0 was passed in
        const optionId = item.id == null || item.id === '' ? item.value : item.id;
        const current = isBadgeSelected ? ' aria-current="true"' : '';
        html += '<button' + autoFocus + ' is="emby-button" type="button" class="' + rowClass + '" data-id="' + optionId + '"' + current + '>';

        const itemIcon = icons[i];

        if (item.badge) {
            html += renderBadge(item.badge);
        } else if (itemIcon) {
            html += `<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${itemIcon}" aria-hidden="true"></span>`;
        } else if (hasLeadingSlot) {
            html += '<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons check" aria-hidden="true" style="visibility:hidden;"></span>';
        }

        html += '<div class="listItemBody actionsheetListItemBody">';

        html += '<div class="listItemBodyText actionSheetItemText">';
        html += escapeHtml(item.name || item.textContent || item.innerText);
        html += '</div>';

        if (item.secondaryText) {
            html += `<div class="listItemBodyText secondary">${escapeHtml(item.secondaryText)}</div>`;
        }

        html += '</div>';

        if (item.asideText) {
            html += `<div class="listItemAside actionSheetItemAsideText">${escapeHtml(item.asideText)}</div>`;
        }

        if (item.chevron) {
            html += '<span class="actionSheetChevron material-icons chevron_right" aria-hidden="true"></span>';
        }

        if (isBadgeSelected) {
            html += '<span class="actionSheetTrailingCheck material-icons check" aria-hidden="true"></span>';
        }

        html += '</button>';
    }

    return { html, hasLeadingSlot };
}
