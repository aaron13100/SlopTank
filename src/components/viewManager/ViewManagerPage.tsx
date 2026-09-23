// SlopTank modification notice: added or changed by SlopTank on 2026-08-03, 2026-08-11, 2026-08-12, 2026-09-08, 2026-09-09.
import { Action } from 'history';
import { FunctionComponent, useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

import globalize from 'lib/globalize';
import type { RestoreViewFailResponse } from 'types/viewManager';

import viewManager from './viewManager';
import { AppType } from 'constants/appType';
import { useVideoOsdPresence } from 'hooks/useVideoOsdPresence';
import { setRouteSearchOverride } from 'utils/url';
import { loadDynamicModule } from 'utils/dynamicImport';
import { prefetchVideoController } from './prefetchVideoController';

/** The view type every route that mounts the video player already declares. */
const VIDEO_OSD_VIEW_TYPE = 'video-osd';

export interface ViewManagerPageProps {
    appType?: AppType
    controller: string
    view: string
    type?: string
    isFullscreen?: boolean
    isNowPlayingBarEnabled?: boolean
    isThemeMediaSupported?: boolean
    transition?: string
    /** Verified route parameters supplied by a canonical permalink adapter. */
    routeParameters?: URLSearchParams | string
}

interface ViewOptions {
    url: string
    type?: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: any
    autoFocus: boolean
    fullscreen?: boolean
    transition?: string
    options: {
        supportsThemeMedia?: boolean
        enableMediaControl?: boolean
    }
}

export const importController = (
    appType: AppType,
    controller: string,
    view: string
) => {
    switch (appType) {
        case AppType.Dashboard:
            return Promise.all([
                loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../apps/dashboard/controllers/${controller}`), '../../apps/dashboard/controllers/${controller}'),
                loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../apps/dashboard/controllers/${view}`),
                    '../../apps/dashboard/controllers/${view}').then(html => globalize.translateHtml(html))
            ]);
        case AppType.Wizard:
            return Promise.all([
                loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../apps/wizard/controllers/${controller}`), '../../apps/wizard/controllers/${controller}'),
                loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../apps/wizard/controllers/${view}`),
                    '../../apps/wizard/controllers/${view}').then(html => globalize.translateHtml(html))
            ]);
        default:
            return Promise.all([
                loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../controllers/${controller}`), '../../controllers/${controller}'),
                loadDynamicModule(() => import(/* webpackChunkName: "[request]", webpackExclude: /(?:^|[\\/])(?:__tests__|__mocks__|__fixtures__|fixtures?|tests?|mocks?)(?:[\\/]|$)|(?:\.(?:test|spec|stories|story|bench|benchmark|fixture|mock)(?:-d)?\.[cm]?[jt]sx?|\.snap)$/i */ `../../controllers/${view}`),
                    '../../controllers/${view}').then(html => globalize.translateHtml(html))
            ]);
    }
};

/**
 * The path part of a recorded view URL, which always begins at '/' and is
 * already relative to the router basename.
 *
 * @param url A view URL as recorded by viewContainer, or null.
 * @returns The path with any query string removed, or null.
 */
const pathnameOf = (url: string | null): string | null => {
    if (url === null) return null;
    const queryStart = url.indexOf('?');
    return queryStart === -1 ? url : url.slice(0, queryStart);
};

const loadView = async (
    appType: AppType,
    controller: string,
    view: string,
    viewOptions: ViewOptions
) => {
    const [ controllerFactory, viewHtml ] = await importController(appType, controller, view);

    viewManager.loadView({
        ...viewOptions,
        controllerFactory,
        view: viewHtml
    });
};

/**
 * Page component that renders legacy views via the ViewManager.
 * NOTE: Any new pages should use the generic Page component instead.
 */
const ViewManagerPage: FunctionComponent<ViewManagerPageProps> = ({
    appType = AppType.Stable,
    controller,
    view,
    type,
    isFullscreen = false,
    isNowPlayingBarEnabled = true,
    isThemeMediaSupported = false,
    transition,
    routeParameters
}) => {
    const location = useLocation();
    const navigationType = useNavigationType();

    // Every route that mounts the video player already says so, by asking for
    // the `video-osd` view type. Declaring presence from that one existing
    // signal is what keeps the app chrome correct on routes that do not exist
    // yet: the alternative, each route telling the layout separately, is the
    // arrangement that left the navigation toolbar over a playing movie as
    // soon as playback gained a second URL (2026-08-12).
    useVideoOsdPresence(type === VIDEO_OSD_VIEW_TYPE);

    // Warm the video player controller while the details page (the only
    // route Play is clicked from) is on screen, so the click-to-video-element
    // phase is not also paying for a cold chunk fetch and module evaluation.
    useEffect(() => {
        prefetchVideoController(appType, controller, importController);
    }, [ appType, controller ]);

    // Flattened to a string BEFORE the dependency list, never compared as an
    // object. Callers build these per render (PermalinkRedirectPage returns a
    // fresh URLSearchParams every time), so depending on the object identity
    // re-ran this effect on every re-render of the route -- and re-running it
    // rebuilds the view, which dispatches `viewbeforehide`, on which the video
    // OSD stops playback. Merely opening the Subtitles action sheet re-renders
    // the route, so the movie ended when the menu opened. The effect's real
    // dependency was always the search VALUE.
    const explicitSearch = typeof routeParameters === 'string' ?
        routeParameters : routeParameters?.toString();

    useEffect(() => {
        const loadPage = () => {
            const effectiveSearch = explicitSearch ?
                `?${explicitSearch.replace(/^\?/, '')}` : location.search;
            setRouteSearchOverride(explicitSearch ? effectiveSearch : null);
            const viewOptions = {
                url: location.pathname + effectiveSearch,
                type,
                state: location.state,
                autoFocus: false,
                fullscreen: isFullscreen,
                transition,
                options: {
                    supportsThemeMedia: isThemeMediaSupported,
                    enableMediaControl: isNowPlayingBarEnabled
                }
            };

            // A route change that is only a re-spelling of the URL already on
            // screen -- a GUID route replaced by the canonical permalink for
            // the very item it is showing -- must not rebuild the view.
            // viewContainer.loadView dispatches `viewbeforehide` on the
            // outgoing view, and the video OSD stops playback on that event,
            // so tidying the address bar would end the movie.
            //
            // `canonicalizedFrom` is the pathname the canonicalizer saw on
            // screen when it judged the change cosmetic. Re-checking it
            // against the view that is on screen NOW is what makes the claim
            // falsifiable: if the user navigated away while the alias was
            // being minted, or this is a fresh load of a pasted permalink, the
            // paths differ and the view loads normally.
            const canonicalizedFrom = (location.state as { canonicalizedFrom?: string } | null)?.canonicalizedFrom;
            if (canonicalizedFrom && canonicalizedFrom === pathnameOf(viewManager.currentViewUrl())) {
                console.debug('[ViewManagerPage] retargeting view [%s] to [%s]', view, viewOptions.url);
                viewManager.retargetCurrentView(viewOptions.url);
                return Promise.resolve();
            }

            if (navigationType !== Action.Pop) {
                console.debug('[ViewManagerPage] loading view [%s]', view);
                return loadView(appType, controller, view, viewOptions);
            }

            console.debug('[ViewManagerPage] restoring view [%s]', view);
            return viewManager.tryRestoreView(viewOptions)
                .catch(async (result?: RestoreViewFailResponse) => {
                    if (!result?.cancelled) {
                        console.debug('[ViewManagerPage] restore failed; loading view [%s]', view);
                        return loadView(appType, controller, view, viewOptions);
                    }
                });
        };

        loadPage();
        return () => setRouteSearchOverride(null);
    },
    // location.state and navigationType are NOT included as dependencies here since dialogs will update state while the current view stays the same
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
        controller,
        view,
        type,
        isFullscreen,
        isNowPlayingBarEnabled,
        isThemeMediaSupported,
        transition,
        explicitSearch,
        location.pathname,
        location.search
    ]);

    return null;
};

export default ViewManagerPage;
