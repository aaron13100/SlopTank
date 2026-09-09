// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-07-31, 2026-08-03, 2026-08-11, 2026-09-08, 2026-09-09.
/**
 * Presentation for resolved and unresolved permalink route states.
 * allow-no-test-found: rendered through its own route by PermalinkRedirectPage.test.tsx and e2e/permalink.spec.ts
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { type FC, useCallback, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';

import Loading from 'components/loading/LoadingComponent';
import Page from 'components/Page';
import { permalinkCanonicalizationHandoff } from 'components/router/permalinkCanonicalizer';
import { parsePermalinkId, permalinkStartSecondsToTicks } from 'components/router/permalinkId';
import {
    resolvePermalink,
    type PermalinkChoice,
    type PermalinkTarget
} from 'components/router/permalinkResolver';
import { useApi } from 'hooks/useApi';
import globalize from 'lib/globalize';
import Button from 'elements/emby-button/Button';
import LinkButton from 'elements/emby-button/LinkButton';
import ViewManagerPage, { type ViewManagerPageProps } from 'components/viewManager/ViewManagerPage';

export type PermalinkPurpose = 'info' | 'watch';

/**
 * Renders one of the two pretty-permalink hash routes (/web/p/:permalinkId,
 * /web/w/:permalinkId, docs/internal/permalink-url-design.md sections 3 and 4.2).
 *
 * Resolution runs entirely through the server's protected permalink endpoint:
 * this page never queries the library, never ranks candidates and never
 * guesses. On a single verified match it replaces the entry with the
 * corresponding legacy route (/web/details or /web/video) so the existing detail and
 * playback controllers own everything past this point. Ambiguity, absence,
 * a pending lineage (409), an unreachable capsule (503) and an unminted
 * external alias (EvidenceRequired) are each rendered as their own state,
 * with the server's own code in the message.
 */
const PermalinkRedirectPage: FC<{
    purpose: PermalinkPurpose
    viewPageComponent?: FC<ViewManagerPageProps>
}> = ({ purpose, viewPageComponent = ViewManagerPage }) => {
    const { permalinkId } = useParams();
    const [ searchParams ] = useSearchParams();
    const location = useLocation();
    const { api, user } = useApi();
    const queryClient = useQueryClient();
    const parsed = permalinkId ? parsePermalinkId(permalinkId) : null;
    const serverId = user?.ServerId ?? '';
    const [ chosenTarget, setChosenTarget ] = useState<PermalinkTarget>();
    const handoff = permalinkCanonicalizationHandoff(location.state, permalinkId, serverId, user?.Id);

    // Keyed on (permalinkId, purpose, serverId, userId) per design 4.2. Leases
    // are single-use, so nothing here may be replayed from cache: `gcTime: 0`
    // drops the entry the moment the route unmounts, which also aborts the
    // in-flight request, and a retry re-runs discovery for a fresh lease.
    const { data, isPending, isError, error, refetch } = useQuery({
        queryKey: [ 'Permalink', purpose, permalinkId, serverId, user?.Id ],
        queryFn: ({ signal }) => resolvePermalink({
            api: api!,
            serverId,
            parsed: parsed!,
            kind: purpose,
            signal
        }),
        // Waits for the user, not just the api. serverId and the handoff check
        // both come from it, so starting earlier meant resolving against an
        // empty serverId and then aborting the in-flight request the moment
        // the user arrived and a handoff became readable -- surfacing as an
        // unhandled CancelledError on the page.
        enabled: !!api && !!user && !!parsed && !handoff,
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
        refetchOnMount: 'always',
        refetchOnWindowFocus: false,
        refetchOnReconnect: false
    });

    const retry = useCallback(() => {
        queryClient
            .removeQueries({ queryKey: [ 'Permalink', purpose, permalinkId, serverId, user?.Id ] });
        void refetch();
    }, [ permalinkId, purpose, queryClient, refetch, serverId, user?.Id ]);

    if (!permalinkId || !parsed) {
        return <PermalinkMessage text={globalize.translate('PermalinkInvalid')} />;
    }

    // The canonicalizer rewrote the address bar for the item this route is
    // already showing, and carried that item with it. Re-resolving would burn
    // a single-use lease to rediscover what the same process just minted, and
    // would flash a spinner over a playing movie to do it.
    if (handoff) {
        return (
            <PermalinkPresentation
                purpose={purpose}
                item={handoff}
                searchParams={searchParams}
                ViewPageComponent={viewPageComponent}
            />
        );
    }

    // Must match `enabled` above: a disabled query reports isPending forever,
    // so anything the query waits for has to keep showing the resolving state
    // rather than fall through to a data branch that has no data.
    if (!api || !user || isPending) {
        return (
            <Page id='permalinkResolvingPage' isBackButtonEnabled={false}>
                <Loading />
            </Page>
        );
    }

    if (isError) {
        return (
            <PermalinkMessage
                text={globalize.translate('PermalinkResolveError', describeThrown(error))}
                onRetry={retry}
            />
        );
    }

    if (chosenTarget) {
        return (
            <PermalinkPresentation
                purpose={purpose}
                item={chosenTarget}
                searchParams={searchParams}
                ViewPageComponent={viewPageComponent}
            />
        );
    }

    switch (data.status) {
        case 'resolved':
            return (
                <PermalinkPresentation
                    purpose={purpose}
                    item={data.item}
                    searchParams={searchParams}
                    ViewPageComponent={viewPageComponent}
                />
            );
        case 'ambiguous':
            return <PermalinkChooser candidates={data.candidates} onChoose={setChosenTarget} />;
        case 'evidence-required':
            return (
                <PermalinkMessage
                    text={globalize.translate('PermalinkEvidenceRequired', data.message)}
                />
            );
        case 'conflict':
            return (
                <PermalinkMessage
                    text={globalize.translate('PermalinkPending', `${data.code}: ${data.message}`)}
                    onRetry={retry}
                />
            );
        case 'unavailable':
            return (
                <PermalinkMessage
                    text={globalize.translate('PermalinkUnavailable', `${data.code}: ${data.message}`)}
                    onRetry={retry}
                />
            );
        case 'error':
            return (
                <PermalinkMessage
                    text={globalize.translate('PermalinkResolveError', `${data.code}: ${data.message}`)}
                    onRetry={retry}
                />
            );
        default:
            return <PermalinkMessage text={globalize.translate('PermalinkNotFound', permalinkId)} />;
    }
};

/** Renders a thrown value without collapsing it into a generic failure line. */
function describeThrown(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function presentationSearch(purpose: PermalinkPurpose, item: PermalinkTarget, searchParams: URLSearchParams) {
    // eslint-disable-next-line compat/compat -- URLSearchParams is already required throughout the supported web client.
    const parameters = new URLSearchParams({ id: item.itemId, serverId: item.serverId });

    if (purpose === 'watch') {
        parameters.set('permalinkPlayback', '1');
        const startSeconds = searchParams.get('t');
        if (permalinkStartSecondsToTicks(startSeconds) !== null) {
            parameters.set('t', startSeconds!);
        }
    }

    return parameters;
}

const PermalinkPresentation: FC<{
    purpose: PermalinkPurpose
    item: PermalinkTarget
    searchParams: URLSearchParams
    ViewPageComponent: FC<ViewManagerPageProps>
}> = ({ purpose, item, searchParams, ViewPageComponent }) => (
    <ViewPageComponent
        controller={purpose === 'info' ? 'itemDetails/index' : 'playback/video/index'}
        view={purpose === 'info' ? 'itemDetails/index.html' : 'playback/video/index.html'}
        type={purpose === 'watch' ? 'video-osd' : undefined}
        isFullscreen={purpose === 'watch'}
        isNowPlayingBarEnabled={purpose !== 'watch'}
        isThemeMediaSupported={purpose === 'watch'}
        routeParameters={presentationSearch(purpose, item, searchParams)}
    />
);

const PermalinkMessage: FC<{ text: string, onRetry?: () => void }> = ({ text, onRetry }) => (
    <Page id='permalinkMessagePage' className='mainAnimatedPage libraryPage' shouldAutoFocus>
        <div className='padded-left padded-right'>
            <p>{text}</p>
            {onRetry && (
                <Button
                    type='button'
                    id='permalinkRetryButton'
                    className='raised button-submit block'
                    title={globalize.translate('Retry')}
                    onClick={onRetry}
                />
            )}
            <LinkButton className='button-link' href='/web/home'>
                {globalize.translate('GoHome')}
            </LinkButton>
        </div>
    </Page>
);

const PermalinkChoiceButton: FC<{
    candidate: PermalinkChoice
    onChoose: (candidate: PermalinkChoice) => void
}> = ({ candidate, onChoose }) => {
    const productionYear = candidate.productionYear ? ` (${candidate.productionYear})` : '';
    const title = `${candidate.name}${productionYear} - ${candidate.type}`;
    const handleClick = useCallback(() => onChoose(candidate), [ candidate, onChoose ]);

    return (
        <Button
            type='button'
            className='button-link'
            title={title}
            onClick={handleClick}
        />
    );
};

const PermalinkChooser: FC<{
    candidates: PermalinkChoice[]
    onChoose: (candidate: PermalinkChoice) => void
}> = ({ candidates, onChoose }) => (
    <Page id='permalinkChooserPage' className='mainAnimatedPage libraryPage' shouldAutoFocus>
        <div className='padded-left padded-right'>
            <p>{globalize.translate('PermalinkAmbiguous')}</p>
            <ul>
                {candidates.map(candidate => (
                    <li key={candidate.itemId}>
                        <PermalinkChoiceButton candidate={candidate} onChoose={onChoose} />
                    </li>
                ))}
            </ul>
        </div>
    </Page>
);

export default PermalinkRedirectPage;
