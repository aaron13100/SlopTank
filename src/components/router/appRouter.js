import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';

import { setBackdropTransparency } from '../backdrop/backdrop';
import globalize from '../../lib/globalize';
import itemHelper from '../itemHelper';
import loading from '../loading/loading';
import alert from '../alert';

import { LayoutMode } from 'constants/layoutMode';
import { getItemQuery } from 'hooks/useItem';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { toApi } from 'utils/jellyfin-apiclient/compat';
import { queryClient } from 'utils/query/queryClient';
import { getRememberedPermalinkAlias } from './permalinkSession';
import { buildPermalinkPath } from './permalinkId';
import { isVideoOsdMounted } from 'components/playback/videoOsdPresence';

/** Pages of "no return" (when "Go back" should behave differently, probably quitting the application). */
const START_PAGE_PATHS = ['/web/home', '/web/login', '/web/selectserver'];

/** Pages that do not require a user to be logged in to view. */
export const PUBLIC_PATHS = [
    '/web/addserver',
    '/web/selectserver',
    '/web/login',
    '/web/forgotpassword',
    '/web/forgotpasswordpin',
    '/web/wizard/remoteaccess',
    '/web/wizard/finish',
    '/web/wizard/library',
    '/web/wizard/settings',
    '/web/wizard/start',
    '/web/wizard/user'
];

export class AppRouter {
    forcedLogoutMsg;
    msgTimeout;
    promiseShow;
    resolveOnNextShow;
    /** @type {import('history').History|undefined} The history backing navigation. */
    history;
    #unlisten;

    /**
     * @param {import('history').History} [routerHistory] The history backing
     * navigation. The app singleton is constructed without one and receives
     * the real router history from the composition root (RootAppRouter) via
     * initialize(); tests pass a memory history here directly.
     */
    constructor(routerHistory) {
        document.addEventListener('viewshow', () => this.onViewShow());

        // The server injects a fixed BaseUrl-aware /web/ base into index.html.
        // It remains correct on root permalink pages where pathname inference cannot.
        this.baseRoute = document.baseURI.endsWith('/') ? document.baseURI.slice(0, -1) : document.baseURI;

        if (routerHistory) {
            this.initialize(routerHistory);
        }
    }

    /**
     * Attaches the history that backs all navigation. Called once by the
     * composition root after the router is created; navigation methods must
     * not be used before then.
     * @param {import('history').History} routerHistory
     */
    initialize(routerHistory) {
        if (this.history === routerHistory) return;

        this.#unlisten?.();
        this.history = routerHistory;
        this.lastPath = this.history.location.pathname + this.history.location.search;
        this.#unlisten = this.listen();
    }

    ready() {
        return this.promiseShow || Promise.resolve();
    }

    /**
     * Whether there is an in-app history entry behind the current one.
     * React-router tracks its entry index in history.state.idx; 0 means this
     * is the first in-app entry, so a pop would leave the app or, when the
     * browser marks the previous entry skippable, silently do nothing. Falls
     * back to the session-history length when the router state is absent.
     */
    #hasInAppHistory() {
        const routerIdx = window.history.state?.idx;
        if (routerIdx != null) {
            return routerIdx > 0;
        }

        return window.history.length > 1;
    }

    async back() {
        if (this.promiseShow) await this.promiseShow;

        // With no in-app history behind this page (e.g. a permalink opened
        // in a fresh tab), a pop is a silent no-op: the history listener
        // below would never fire, leaving promiseShow pending forever and
        // wedging every later navigation behind it. Route home instead so
        // "back" always leaves the page.
        if (!this.#hasInAppHistory()) {
            return this.goHome();
        }

        this.promiseShow = new Promise((resolve) => {
            const unlisten = this.history.listen(() => {
                unlisten();
                this.promiseShow = null;
                resolve();
            });
            this.history.back();
        });

        return this.promiseShow;
    }

    async show(path, options) {
        return this.#navigate(path, options, false);
    }

    /**
     * Navigates like show(), but replaces the current history entry instead
     * of pushing a new one. Use for in-place transitions (such as the video
     * player moving to the next episode) that must not grow the back stack.
     */
    async replace(path, options) {
        return this.#navigate(path, options, true);
    }

    /**
     * Rewrites the address bar to a canonical spelling of the route already on
     * screen, through the router rather than behind its back.
     *
     * Deliberately NOT routed through show()/replace(). Those await
     * `promiseShow`, which only resolves on the next `viewshow` DOM event, and
     * a canonicalization is defined by the view NOT reloading, so no viewshow
     * would ever fire and every later navigation would wedge behind a promise
     * that never settles.
     *
     * Equally deliberately not `window.history.replaceState`, which is what
     * this used to be: React Router never observes a raw history write, so its
     * location and the browser's diverged until some later re-render made the
     * router re-read window.location, match the permalink route and unmount
     * the player mid-movie (fixed 2026-08-11, reported 2026-08-09).
     *
     * The caller's state is MERGED over the entry being re-spelled, never
     * substituted for it. A canonicalization changes only how the current
     * entry is spelled, so everything that entry was already carrying is still
     * true afterwards, and other features legitimately keep their own keys
     * there. dialogHelper is the one that bites: it records the open dialog
     * stack in `state.dialogs` and closes any dialog whose hash is missing
     * from a history update, so a wholesale replace tore open menus out of the
     * DOM. Merging here rather than at each call site is what makes that
     * impossible for every caller, present and future.
     *
     * @param {string} path Router path, relative to the deployment basename.
     * @param {object} [state] Keys to add to the current entry's state.
     * @returns {boolean} Whether the address bar was rewritten.
     */
    canonicalizeAddressBar(path, state) {
        if (!this.history) return false;

        const current = this.history.location.pathname + this.history.location.search;
        if (current === path) return false;

        this.history.replace(path, { ...this.history.location.state, ...state });
        return true;
    }

    async #navigate(path, options, replace) {
        if (this.promiseShow) await this.promiseShow;

        // Accept legacy hash-shaped targets while callers migrate.
        if (path.startsWith('#')) {
            path = path.substring(1);
        }
        // Support legacy '#!' routes since people may have old bookmarks, etc.
        if (path.startsWith('!')) {
            path = path.substring(1);
        }

        if (path.indexOf('/') !== 0 && path.indexOf('://') === -1) {
            path = '/' + path;
        }

        path = path.replace(this.baseUrl(), '');

        if (!path.startsWith('/web/') && path !== '/web' && !/^\/(?:w\/)?(?:tt\d+|tm-(?:mv|tv|ep|se|co)-[1-9]\d*|sk-[0-9a-hjkmnp-tv-z]{26})(?:[?#]|$)/.test(path)) {
            path = `/web${path}`;
        }

        // can't use this with home right now due to the back menu
        const currentFullPath = this.history.location.pathname + this.history.location.search;
        if ((this.history.location.pathname === path || currentFullPath === path) && path !== '/web/home') {
            loading.hide();
            return Promise.resolve();
        }

        this.promiseShow = new Promise((resolve) => {
            this.resolveOnNextShow = resolve;
            // Schedule a call to return the promise
            setTimeout(() => {
                if (replace) {
                    this.history.replace(path, options);
                } else {
                    this.history.push(path, options);
                }
            }, 0);
        });

        return this.promiseShow;
    }

    listen() {
        return this.history.listen(({ location }) => {
            const normalizedPath = location.pathname.replace(/^!/, '');
            const fullPath = normalizedPath + location.search;

            if (fullPath === this.lastPath) {
                console.debug('[appRouter] path did not change, resolving promise');
                this.onViewShow();
            }

            this.lastPath = fullPath;
        });
    }

    baseUrl() {
        return this.baseRoute;
    }

    /**
     * Whether the given page (current one by default) is a "no return" start
     * page, where going back would mean leaving the application.
     */
    isStartPage(path = this.history.location.pathname) {
        return START_PAGE_PATHS.includes(path);
    }

    canGoBack(path = this.history.location.pathname) {
        if (
            !document.querySelector('.dialogContainer')
            && this.isStartPage(path)
        ) {
            return false;
        }

        return this.#hasInAppHistory();
    }

    showItem(item, serverId, options) {
        // TODO: Refactor this so it only gets items, not strings.
        if (typeof item === 'string') {
            const apiClient = serverId ? ServerConnections.getApiClient(serverId) : ServerConnections.currentApiClient();
            const api = toApi(apiClient);
            const userId = apiClient.getCurrentUserId();

            queryClient
                .fetchQuery(getItemQuery(api, item, userId))
                .then(itemObject => {
                    this.showItem(itemObject, options);
                })
                .catch(err => {
                    console.error('[AppRouter] Failed to fetch item', err);
                });
        } else {
            if (arguments.length === 2) {
                options = arguments[1];
            }

            const url = this.getRouteUrl(item, options);
            this.show(url);
        }
    }

    /**
     * Sets the backdrop, background, and document transparency
     * @deprecated use Dashboard.setBackdropTransparency
     */
    setTransparency(level) {
        // TODO: Remove this after JMP is updated to not use this function
        console.warn('Deprecated! Use Dashboard.setBackdropTransparency');
        setBackdropTransparency(level);
    }

    onViewShow() {
        const resolve = this.resolveOnNextShow;
        if (resolve) {
            this.promiseShow = null;
            this.resolveOnNextShow = null;
            resolve();
        }
    }

    onForcedLogoutMessageTimeout() {
        const msg = this.forcedLogoutMsg;
        this.forcedLogoutMsg = null;

        if (msg) {
            alert(msg);
        }
    }

    showForcedLogoutMessage(msg) {
        this.forcedLogoutMsg = msg;
        if (this.msgTimeout) {
            clearTimeout(this.msgTimeout);
        }

        this.msgTimeout = setTimeout(this.onForcedLogoutMessageTimeout, 100);
    }

    onRequestFail(_e, data) {
        const apiClient = this;

        if (data.status === 403 && data.errorCode === 'ParentalControl') {
            const currentPath = appRouter.history?.location.pathname ?? window.location.pathname;
            const isPublicPage = PUBLIC_PATHS.includes(currentPath);

            // Bounce to the login screen, but not if a password entry fails.
            if (!isPublicPage) {
                appRouter.showForcedLogoutMessage(globalize.translate('AccessRestrictedTryAgainLater'));
                appRouter.showLocalLogin(apiClient.serverId());
            }
        }
    }

    getRouteUrl(item, options) {
        if (!item) {
            throw new Error('item cannot be null');
        }

        if (item.url) {
            return item.url;
        }

        const context = options ? options.context : null;
        const id = item.Id || item.ItemId;

        if (!options) {
            options = {};
        }

        let url;
        // TODO: options will never be false. Replace condition with lodash's isEmpty()
        const itemType = item.Type || (options ? options.itemType : null);
        const serverId = item.ServerId || options.serverId;

        const rememberedAlias = id ? getRememberedPermalinkAlias(serverId, id) : undefined;
        if (rememberedAlias && itemHelper.isLocalItem(item)) {
            return buildPermalinkPath(options.autoplay ? 'watch' : 'info', rememberedAlias);
        }
        if (item === 'settings') {
            return '/web/mypreferencesmenu';
        }

        if (item === 'wizard') {
            return '/web/wizard/start';
        }

        if (item === 'manageserver') {
            return '/web/dashboard';
        }

        if (item === 'recordedtv') {
            return '/web/livetv?tab=3&serverId=' + serverId;
        }

        if (item === 'nextup') {
            return '/web/list?type=nextup&serverId=' + serverId;
        }

        if (item === 'list') {
            let urlForList = '/web/list?serverId=' + serverId + '&type=' + options.itemTypes;

            if (options.isFavorite) {
                urlForList += '&IsFavorite=true';
            }

            if (options.isAiring) {
                urlForList += '&IsAiring=true';
            }

            if (options.isMovie) {
                urlForList += '&IsMovie=true';
            }

            if (options.isSeries) {
                urlForList += '&IsSeries=true&IsMovie=false&IsNews=false';
            }

            if (options.isSports) {
                urlForList += '&IsSports=true';
            }

            if (options.isKids) {
                urlForList += '&IsKids=true';
            }

            if (options.isNews) {
                urlForList += '&IsNews=true';
            }

            return urlForList;
        }

        if (item === 'livetv') {
            if (options.section === 'programs') {
                return '/web/livetv?tab=0&serverId=' + serverId;
            }
            if (options.section === 'guide') {
                return '/web/livetv?tab=1&serverId=' + serverId;
            }

            if (options.section === 'movies') {
                return '/web/list?type=Programs&IsMovie=true&serverId=' + serverId;
            }

            if (options.section === 'shows') {
                return '/web/list?type=Programs&IsSeries=true&IsMovie=false&IsNews=false&serverId=' + serverId;
            }

            if (options.section === 'sports') {
                return '/web/list?type=Programs&IsSports=true&serverId=' + serverId;
            }

            if (options.section === 'kids') {
                return '/web/list?type=Programs&IsKids=true&serverId=' + serverId;
            }

            if (options.section === 'news') {
                return '/web/list?type=Programs&IsNews=true&serverId=' + serverId;
            }

            if (options.section === 'onnow') {
                return '/web/list?type=Programs&IsAiring=true&serverId=' + serverId;
            }

            if (options.section === 'channels') {
                return '/web/livetv?tab=2&serverId=' + serverId;
            }

            if (options.section === 'dvrschedule') {
                return '/web/livetv?tab=4&serverId=' + serverId;
            }

            if (options.section === 'seriesrecording') {
                return '/web/livetv?tab=5&serverId=' + serverId;
            }

            return '/web/livetv?serverId=' + serverId;
        }

        if (itemType == 'SeriesTimer') {
            return '/web/details?seriesTimerId=' + id + '&serverId=' + serverId;
        }

        if (item.CollectionType == CollectionType.Livetv) {
            return `/web/livetv?collectionType=${item.CollectionType}`;
        }

        if (item.Type === 'Genre') {
            url = '/web/list?genreId=' + item.Id + '&serverId=' + serverId;

            if (context === 'livetv') {
                url += '&type=Programs';
            }

            if (options.parentId) {
                url += '&parentId=' + options.parentId;
            }

            return url;
        }

        if (item.Type === 'MusicGenre') {
            url = '/web/list?musicGenreId=' + item.Id + '&serverId=' + serverId;

            if (options.parentId) {
                url += '&parentId=' + options.parentId;
            }

            return url;
        }

        if (item.Type === 'Studio') {
            url = '/web/list?studioId=' + item.Id + '&serverId=' + serverId;

            if (options.parentId) {
                url += '&parentId=' + options.parentId;
            }

            return url;
        }

        if (item === 'tag') {
            url = `/web/list?type=tag&tag=${encodeURIComponent(options.tag)}&serverId=${serverId}`;

            if (options.parentId) {
                url += '&parentId=' + options.parentId;
            }

            return url;
        }

        if (context !== 'folders' && !itemHelper.isLocalItem(item)) {
            if (item.CollectionType == CollectionType.Movies) {
                url = '/movies';

                if (options && options.section === 'latest') {
                    url += '?tab=1';
                }

                return url;
            }

            if (item.CollectionType == CollectionType.Tvshows) {
                url = '/tv';

                if (options && options.section === 'latest') {
                    url += '?tab=1';
                }

                return url;
            }

            if (item.CollectionType == CollectionType.Music) {
                url = '/music';

                if (options?.section === 'latest') {
                    url += '?tab=1';
                }

                return url;
            }

            const layoutMode = localStorage.getItem('layout');

            if (layoutMode === LayoutMode.Experimental && item.CollectionType == CollectionType.Homevideos) {
                url = '/homevideos';

                return url;
            }
        }

        const itemTypes = ['Playlist', 'TvChannel', 'Program', 'BoxSet', 'MusicAlbum', 'MusicGenre', 'Person', 'Recording', 'MusicArtist'];

        if (itemTypes.indexOf(itemType) >= 0) {
            return '/web/details?id=' + id + '&serverId=' + serverId;
        }

        const contextSuffix = context ? '&context=' + context : '';

        if (itemType == 'Series' || itemType == 'Season' || itemType == 'Episode') {
            return '/web/details?id=' + id + contextSuffix + '&serverId=' + serverId;
        }

        if (item.IsFolder) {
            if (id) {
                return '/web/list?parentId=' + id + '&serverId=' + serverId;
            }

            return '#';
        }

        return '/web/details?id=' + id + '&serverId=' + serverId;
    }

    showLocalLogin(serverId) {
        return this.show('login?serverid=' + serverId);
    }

    showVideoOsd(item) {
        const path = item && item.Id && item.ServerId ?
            'video?id=' + item.Id + '&serverId=' + item.ServerId :
            'video';

        // An item change while the player is already showing (next/previous
        // episode, autoplay, queue jump) must not grow the history stack:
        // replace the entry so Back always exits the player instead of
        // stepping back through previously played episodes.
        //
        // Asked of the mounted view rather than of the address: the player has
        // two addresses (`/web/video` before canonicalization, `/w/<alias>`
        // after), and listing them here is what left the navigation toolbar
        // stranded over a playing movie when the second one appeared.
        if (isVideoOsdMounted()) {
            return this.replace(path);
        }

        return this.show(path);
    }

    showSelectServer() {
        return this.show('selectserver');
    }

    showSettings() {
        return this.show('mypreferencesmenu');
    }

    showNowPlaying() {
        return this.show('queue');
    }

    showGuide() {
        return this.show('livetv?tab=1');
    }

    goHome() {
        return this.show('home');
    }

    showSearch() {
        return this.show('search');
    }

    showLiveTV() {
        return this.show('livetv');
    }

    showRecordedTV() {
        return this.show('livetv?tab=3');
    }

    showFavorites() {
        return this.show('home?tab=1');
    }
}

export const appRouter = new AppRouter();

export const isLyricsPage = () => appRouter.history.location.pathname.toLowerCase() === '/web/lyrics';

window.Emby = window.Emby || {};
window.Emby.Page = appRouter;
