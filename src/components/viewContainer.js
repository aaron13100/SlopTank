import { importModule } from '@uupaa/dynamic-import-polyfill';
import './viewManager/viewContainer.scss';
import Dashboard from '../utils/dashboard';

const getMainAnimatedPages = () => {
    return document.querySelector('.mainAnimatedPages');
};

function setControllerClass(view, options) {
    if (options.controllerFactory) {
        return Promise.resolve();
    }

    let controllerUrl = view.getAttribute('data-controller');

    if (controllerUrl) {
        if (controllerUrl.indexOf('__plugin/') === 0) {
            controllerUrl = controllerUrl.substring('__plugin/'.length);
        }

        controllerUrl = Dashboard.getPluginUrl(controllerUrl);
        const apiUrl = ApiClient.getUrl('/web/' + controllerUrl);
        return importModule(apiUrl).then((ControllerFactory) => {
            options.controllerFactory = ControllerFactory;
        });
    }

    return Promise.resolve();
}

export function loadView(options) {
    if (!options.cancel) {
        const selected = selectedPageIndex;
        const previousAnimatable = selected === -1 ? null : allPages[selected];
        let pageIndex = selected + 1;

        if (pageIndex >= pageContainerCount) {
            pageIndex = 0;
        }

        const isPluginpage = options.url.includes('configurationpage');
        const newViewInfo = normalizeNewView(options, isPluginpage);
        const newView = newViewInfo.elem;

        const currentPage = allPages[pageIndex];

        if (currentPage) {
            triggerDestroy(currentPage);
        }

        let view = newView;

        if (typeof view == 'string') {
            view = document.createElement('div');
            view.innerHTML = newView;
        }

        view.classList.add('mainAnimatedPage');

        const mainAnimatedPages = getMainAnimatedPages();

        if (!mainAnimatedPages) {
            console.warn('[viewContainer] main animated pages element is not present');
            return;
        }

        if (currentPage) {
            if (newViewInfo.hasScript && window.$) {
                mainAnimatedPages.removeChild(currentPage);
                view = $(view).appendTo(mainAnimatedPages)[0];
            } else {
                mainAnimatedPages.replaceChild(view, currentPage);
            }
        } else if (newViewInfo.hasScript && window.$) {
            view = $(view).appendTo(mainAnimatedPages)[0];
        } else {
            mainAnimatedPages.appendChild(view);
        }

        if (options.type) {
            view.setAttribute('data-type', options.type);
        }

        const properties = [];

        if (options.fullscreen) {
            properties.push('fullscreen');
        }

        if (properties.length) {
            view.setAttribute('data-properties', properties.join(','));
        }

        allPages[pageIndex] = view;

        return setControllerClass(view, options)
        // Timeout for polyfilled CustomElements (webOS 1.2)
            .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
            .then(() => {
                if (onBeforeChange) {
                    onBeforeChange(view, false, options);
                }

                beforeAnimate(allPages, pageIndex, selected);
                selectedPageIndex = pageIndex;
                currentUrls[pageIndex] = options.url;

                if (!options.cancel && previousAnimatable) {
                    afterAnimate(allPages, pageIndex);
                }

                if (window.$) {
                    $.mobile = $.mobile || {};
                    $.mobile.activePage = view;
                }

                return view;
            });
    }
}

function parseHtml(html, hasScript) {
    if (hasScript) {
        html = html
            .replaceAll('\x3c!--<script', '<script')
            .replaceAll('</script>--\x3e', '</script>');
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    return wrapper.querySelector('div[data-role="page"]');
}

function normalizeNewView(options, isPluginpage) {
    const viewHtml = options.view;

    if (viewHtml.indexOf('data-role="page"') === -1) {
        return viewHtml;
    }

    let hasScript = viewHtml.indexOf('<script') !== -1;
    const elem = parseHtml(viewHtml, hasScript);

    if (hasScript) {
        hasScript = elem.querySelector('script') != null;
    }

    let hasjQuery = false;
    let hasjQuerySelect = false;
    let hasjQueryChecked = false;

    if (isPluginpage) {
        hasjQuery = viewHtml.indexOf('jQuery') != -1 || viewHtml.indexOf('$(') != -1 || viewHtml.indexOf('$.') != -1;
        hasjQueryChecked = viewHtml.indexOf('.checked(') != -1;
        hasjQuerySelect = viewHtml.indexOf('.selectmenu(') != -1;
    }

    return {
        elem: elem,
        hasScript: hasScript,
        hasjQuerySelect: hasjQuerySelect,
        hasjQueryChecked: hasjQueryChecked,
        hasjQuery: hasjQuery
    };
}

function beforeAnimate(allPages, newPageIndex, oldPageIndex) {
    for (let index = 0, length = allPages.length; index < length; index++) {
        if (newPageIndex !== index && oldPageIndex !== index) {
            allPages[index].classList.add('hide');
        }
    }
}

function afterAnimate(allPages, newPageIndex) {
    for (let index = 0, length = allPages.length; index < length; index++) {
        if (newPageIndex !== index) {
            allPages[index].classList.add('hide');
        }
    }
}

export function setOnBeforeChange(fn) {
    onBeforeChange = fn;
}

/**
 * The URL recorded for the view currently on screen, or null when nothing has
 * been loaded yet.
 *
 * A view's URL is its identity here: tryRestoreView matches on it, and
 * loadView records it. Exposing it is what lets a caller ask the only honest
 * version of "am I already looking at this?" instead of inferring it.
 *
 * @returns {string|null} The recorded URL of the on-screen view.
 */
export function getCurrentViewUrl() {
    return selectedPageIndex === -1 ? null : (currentUrls[selectedPageIndex] ?? null);
}

/**
 * Re-labels the on-screen view with a new URL without rebuilding it.
 *
 * Used when a route change is a pure re-spelling of the same content: a GUID
 * route replaced by the canonical permalink for the very item it is already
 * showing. Rebuilding in that case is not merely wasteful, it is destructive,
 * because loadView dispatches `viewbeforehide` on the outgoing view and the
 * video OSD stops playback on that event. Keeping currentUrls in step means a
 * later restore of this history entry still finds this view.
 *
 * @param {string} url The URL the on-screen view should now answer to.
 * @returns {boolean} Whether a view was on screen to re-label.
 */
export function retargetCurrentView(url) {
    if (selectedPageIndex === -1) {
        return false;
    }

    currentUrls[selectedPageIndex] = url;
    return true;
}

export function tryRestoreView(options) {
    console.debug('[viewContainer] tryRestoreView', options);
    const url = options.url;
    const index = currentUrls.indexOf(url);

    if (index !== -1) {
        const animatable = allPages[index];
        const view = animatable;

        if (view) {
            if (options.cancel) {
                return;
            }

            const selected = selectedPageIndex;
            const previousAnimatable = selected === -1 ? null : allPages[selected];
            return setControllerClass(view, options).then(() => {
                if (onBeforeChange) {
                    onBeforeChange(view, true, options);
                }

                beforeAnimate(allPages, index, selected);
                animatable.classList.remove('hide');
                selectedPageIndex = index;

                if (!options.cancel && previousAnimatable) {
                    afterAnimate(allPages, index);
                }

                if (window.$) {
                    $.mobile = $.mobile || {};
                    $.mobile.activePage = view;
                }

                return view;
            });
        }
    }

    return Promise.reject();
}

function triggerDestroy(view) {
    view.dispatchEvent(new CustomEvent('viewdestroy', {}));
}

export function reset() {
    console.debug('[viewContainer] resetting view cache');
    allPages = [];
    currentUrls = [];
    const mainAnimatedPages = getMainAnimatedPages();
    if (mainAnimatedPages) mainAnimatedPages.innerHTML = '';
    selectedPageIndex = -1;
}

let onBeforeChange;
let allPages = [];
let currentUrls = [];
const pageContainerCount = 3;
let selectedPageIndex = -1;
reset();
getMainAnimatedPages()?.classList.remove('hide');

// No default export on purpose. This module used to also ship a hand-written
// object re-listing its functions, and every consumer default-imported that
// object rather than the named exports, so any function added here without
// also being added to the list resolved to `undefined` at the call site while
// named-import unit tests kept passing. That exact drift shipped a broken ASS
// renderer from subtitleappearancehelper.js (fixed 2026-08-09, commit
// 23e5c64708); getCurrentViewUrl and retargetCurrentView below would have been
// the next instance. Consumers use `import * as viewContainer`, whose
// namespace object cannot drift from the named exports.
