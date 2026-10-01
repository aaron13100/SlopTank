// SlopTank modification notice: added or changed by SlopTank on 2026-07-23, 2026-09-08, 2026-09-09, 2026-09-24, 2026-10-01.
import escapeHtml from 'escape-html';
import dialogHelper from '../dialogHelper/dialogHelper';
import layoutManager from '../layoutManager';
import globalize from '../../lib/globalize';
import dom from '../../utils/dom';
import '../../elements/emby-button/emby-button';
import './actionSheet.scss';
import 'material-design-icons-iconfont';
import '../../styles/scrollstyles.scss';
import '../../components/listview/listview.scss';
import { loadDynamicModule } from 'utils/dynamicImport';
import { renderActionSheetItems, type OptionItem } from './actionSheetItemMarkup';

/**
 * Typed rejection for a sheet dismissed without a selection, so callers can
 * distinguish a normal cancel (code ACTION_SHEET_CANCELED) from a real
 * failure without string matching. Message kept identical to the historical
 * untyped rejection.
 */
export class ActionSheetCanceledError extends Error {
    code = 'ACTION_SHEET_CANCELED';

    constructor() {
        super('ActionSheet closed without resolving');
        this.name = 'ActionSheetCanceledError';
    }
}

interface Options {
    items: OptionItem[];
    border?: boolean;
    callback?: (id: string) => void;
    dialogClass?: string;
    enableHistory?: boolean;
    entryAnimationDuration?: number;
    entryAnimation?: string;
    exitAnimationDuration?: number;
    exitAnimation?: string;
    menuItemClass?: string;
    offsetLeft?: number;
    offsetTop?: number;
    positionTo?: Element | null;
    positionY?: string;
    resolveOnClick?: boolean | (string | null)[];
    shaded?: boolean;
    showCancel?: boolean;
    text?: string;
    timeout?: number;
    title?: string;
}

interface Offset {
    top: number;
    left: number;
    width: number;
    height: number;
}

interface DialogOptions {
    /** true: focus on open; false: never; 'keyboard': only when a keyboard-focused control opened it. */
    autoFocus?: boolean | 'keyboard';
    enableHistory?: boolean;
    entryAnimationDuration?: number;
    entryAnimation?: string;
    exitAnimationDuration?: number;
    exitAnimation?: string;
    modal?: boolean;
    removeOnClose?: boolean;
    scrollY?: boolean;
    size?: string;
}

function getOffsets(elems: Element[]): Offset[] {
    const results: Offset[] = [];

    if (!document) {
        return results;
    }

    for (const elem of elems) {
        const box = elem.getBoundingClientRect();

        results.push({
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height
        });
    }

    return results;
}

function getPosition(positionTo: Element, options: Options, dlg: HTMLElement) {
    const windowSize = dom.getWindowSize();
    const windowHeight = windowSize.innerHeight;
    const windowWidth = windowSize.innerWidth;

    const pos = getOffsets([positionTo])[0];

    if (options.positionY !== 'top') {
        pos.top += (pos.height || 0) / 2;
    }

    pos.left += (pos.width || 0) / 2;

    const height = dlg.offsetHeight || 300;
    const width = dlg.offsetWidth || 160;

    // Account for popup size
    pos.top -= height / 2;
    pos.left -= width / 2;

    // Avoid showing too close to the bottom
    const overflowX = pos.left + width - windowWidth;
    const overflowY = pos.top + height - windowHeight;

    if (overflowX > 0) {
        pos.left -= (overflowX + 20);
    }
    if (overflowY > 0) {
        pos.top -= (overflowY + 20);
    }

    pos.top += (options.offsetTop || 0);
    pos.left += (options.offsetLeft || 0);

    // Do some boundary checking
    pos.top = Math.max(pos.top, 10);
    pos.left = Math.max(pos.left, 10);

    return pos;
}

function centerFocus(elem: Element, horiz: boolean, on: boolean) {
    loadDynamicModule(() => import('../../scripts/scrollHelper'),
        '../../scripts/scrollHelper').then((scrollHelper) => {
        const fn = on ? 'on' : 'off';
        scrollHelper.centerFocus[fn](elem, horiz);
    }).catch(e => {
        console.warn('Error in centerFocus', e);
    });
}

/* eslint-disable-next-line sonarjs/cognitive-complexity */
export function show(options: Options) {
    // items
    // positionTo
    // showCancel
    // title
    const dialogOptions: DialogOptions = {
        removeOnClose: true,
        enableHistory: options.enableHistory,
        scrollY: false
    };

    let isFullscreen;

    if (layoutManager.tv) {
        dialogOptions.size = 'fullscreen';
        isFullscreen = true;
        dialogOptions.autoFocus = true;
    } else {
        dialogOptions.modal = false;
        dialogOptions.entryAnimation = options.entryAnimation;
        dialogOptions.exitAnimation = options.exitAnimation;
        dialogOptions.entryAnimationDuration = options.entryAnimationDuration || 140;
        dialogOptions.exitAnimationDuration = options.exitAnimationDuration || 100;
        // Mouse/touch opens leave focus alone; a keyboard open moves focus into
        // the menu so every item is reachable by Tab.
        dialogOptions.autoFocus = 'keyboard';
    }

    const dlg = dialogHelper.createDialog(dialogOptions);

    if (isFullscreen) {
        dlg.classList.add('actionsheet-fullscreen');
    } else {
        dlg.classList.add('actionsheet-not-fullscreen');
    }

    dlg.classList.add('actionSheet');

    if (options.dialogClass) {
        dlg.classList.add(options.dialogClass);
    }

    let html = '';

    const scrollClassName = layoutManager.tv ? 'scrollY smoothScrollY hiddenScrollY' : 'scrollY';
    let style = '';

    // Admittedly a hack but right now the scrollbar is being factored into the width which is causing truncation
    if (options.items.length > 20) {
        const minWidth = dom.getWindowSize().innerWidth >= 300 ? 240 : 200;
        style += 'min-width:' + minWidth + 'px;';
    }

    let menuItemClass = 'listItem listItem-button actionSheetMenuItem';

    if (options.border || options.shaded) {
        menuItemClass += ' listItem-border';
    }

    if (options.menuItemClass) {
        menuItemClass += ' ' + options.menuItemClass;
    }

    if (layoutManager.tv) {
        menuItemClass += ' listItem-focusscale';
    }

    if (layoutManager.mobile) {
        menuItemClass += ' actionsheet-xlargeFont';
    }

    const rendered = renderActionSheetItems(options.items, menuItemClass, layoutManager.tv);
    const renderIcon = rendered.hasLeadingSlot;

    if (layoutManager.tv) {
        html += `<button is="paper-icon-button-light" class="btnCloseActionSheet hide-mouse-idle-tv" tabindex="-1" title="${globalize.translate('ButtonBack')}">
                     <span class="material-icons arrow_back" aria-hidden="true"></span>
                 </button>`;
    }

    // If any items have an icon, give them all an icon just to make sure they're all lined up evenly
    const center = options.title && (!renderIcon /*|| itemsWithIcons.length != options.items.length*/);

    if (center || layoutManager.tv) {
        html += '<div class="actionSheetContent actionSheetContent-centered">';
    } else {
        html += '<div class="actionSheetContent">';
    }

    if (options.title) {
        html += '<h1 class="actionSheetTitle">' + escapeHtml(options.title) + '</h1>';
    }
    if (options.text) {
        html += '<p class="actionSheetText">' + escapeHtml(options.text) + '</p>';
    }

    let scrollerClassName = 'actionSheetScroller';
    if (layoutManager.tv) {
        scrollerClassName += ' actionSheetScroller-tv focuscontainer-x focuscontainer-y';
    }
    html += '<div class="' + scrollerClassName + ' ' + scrollClassName + '" style="' + style + '">';

    html += rendered.html;

    if (options.showCancel) {
        html += '<div class="buttons">';
        html += `<button is="emby-button" type="button" class="btnCloseActionSheet">${globalize.translate('ButtonCancel')}</button>`;
        html += '</div>';
    }
    html += '</div>';

    dlg.innerHTML = html;

    if (layoutManager.tv) {
        const scroller = dlg.querySelector('.actionSheetScroller');
        if (scroller) {
            centerFocus(scroller, false, true);
        }
    }

    const btnCloseActionSheet = dlg.querySelector('.btnCloseActionSheet');
    if (btnCloseActionSheet) {
        btnCloseActionSheet.addEventListener('click', function () {
            dialogHelper.close(dlg);
        });
    }

    let selectedId: string | null = null;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
        timeout = setTimeout(function () {
            dialogHelper.close(dlg);
        }, options.timeout);
    }

    return new Promise(function (resolve, reject) {
        let isResolved = false;

        dlg.addEventListener('click', function (e) {
            const actionSheetMenuItem = dom.parentWithClass(e.target as HTMLElement, 'actionSheetMenuItem');

            if (actionSheetMenuItem) {
                selectedId = actionSheetMenuItem.getAttribute('data-id');

                if (options.resolveOnClick) {
                    if (Array.isArray(options.resolveOnClick)) {
                        if (options.resolveOnClick.indexOf(selectedId) !== -1) {
                            resolve(selectedId);
                            isResolved = true;
                        }
                    } else {
                        resolve(selectedId);
                        isResolved = true;
                    }
                }

                dialogHelper.close(dlg);
            }
        });

        dlg.addEventListener('close', function () {
            if (layoutManager.tv) {
                const scroller = dlg.querySelector('.actionSheetScroller');
                if (scroller) {
                    centerFocus(scroller, false, false);
                }
            }

            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }

            if (!isResolved) {
                if (selectedId != null) {
                    if (options.callback) {
                        options.callback(selectedId);
                    }

                    resolve(selectedId);
                } else {
                    reject(new ActionSheetCanceledError());
                }
            }
        });

        dialogHelper.open(dlg).catch(e => {
            console.warn('DialogHelper.open error', e);
        });

        const pos = options.positionTo && dialogOptions.size !== 'fullscreen' ? getPosition(options.positionTo, options, dlg) : null;

        if (pos) {
            dlg.style.position = 'fixed';
            dlg.style.margin = '0';
            dlg.style.left = pos.left + 'px';
            dlg.style.top = pos.top + 'px';
        }
    });
}

export default {
    show: show
};
