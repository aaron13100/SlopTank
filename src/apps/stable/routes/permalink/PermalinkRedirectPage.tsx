/**
 * Presentation for resolved and unresolved permalink route states.
 * allow-no-test-found: rendered through its own route by PermalinkRedirectPage.test.tsx and e2e/permalink.spec.ts
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { type FC, useCallback } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';

import Loading from 'components/loading/LoadingComponent';
import Page from 'components/Page';
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

export type PermalinkPurpose = 'info' | 'watch';

/**
 * Renders one of the two pretty-permalink hash routes (#/p/:permalinkId,
 * #/w/:permalinkId, docs/internal/permalink-url-design.md sections 3 and 4.2).
 *
 * Resolution runs entirely through the server's protected permalink endpoint:
 * this page never queries the library, never ranks candidates and never
 * guesses. On a single verified match it replaces the entry with the
 * corresponding legacy route (#/details or #/video) so the existing detail and
 * playback controllers own everything past this point. Ambiguity, absence,
 * a pending lineage (409), an unreachable capsule (503) and an unminted
 * external alias (EvidenceRequired) are each rendered as their own state,
 * with the server's own code in the message.
 */
const PermalinkRedirectPage: FC<{ purpose: PermalinkPurpose }> = ({ purpose }) => {
    const { permalinkId } = useParams();
    const [ searchParams ] = useSearchParams();
    const { api, user } = useApi();
    const queryClient = useQueryClient();
    const parsed = permalinkId ? parsePermalinkId(permalinkId) : null;
    const serverId = user?.ServerId ?? '';

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
        enabled: !!api && !!parsed,
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

    if (!api || isPending) {
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

    switch (data.status) {
        case 'resolved':
            return <Navigate replace to={toRouteLocation(purpose, data.item, searchParams)} />;
        case 'ambiguous':
            return <PermalinkChooser purpose={purpose} candidates={data.candidates} />;
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

function legacySearch(item: PermalinkTarget): string {
    return `?id=${item.itemId}&serverId=${item.serverId}`;
}

function toRouteLocation(purpose: PermalinkPurpose, item: PermalinkTarget, searchParams: URLSearchParams) {
    let search = legacySearch(item);

    if (purpose === 'watch') {
        const startSeconds = searchParams.get('t');
        if (permalinkStartSecondsToTicks(startSeconds) !== null) {
            search += `&t=${startSeconds}`;
        }
    }

    return {
        pathname: purpose === 'info' ? '/details' : '/video',
        search
    };
}

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
            <LinkButton className='button-link' href='#/home'>
                {globalize.translate('GoHome')}
            </LinkButton>
        </div>
    </Page>
);

const PermalinkChooser: FC<{ purpose: PermalinkPurpose, candidates: PermalinkChoice[] }> = ({ purpose, candidates }) => (
    <Page id='permalinkChooserPage' className='mainAnimatedPage libraryPage' shouldAutoFocus>
        <div className='padded-left padded-right'>
            <p>{globalize.translate('PermalinkAmbiguous')}</p>
            <ul>
                {candidates.map(candidate => (
                    <li key={candidate.itemId}>
                        <LinkButton
                            className='button-link'
                            href={`#${purpose === 'info' ? '/details' : '/video'}${legacySearch(candidate)}`}
                        >
                            {candidate.name}{candidate.productionYear ? ` (${candidate.productionYear})` : ''} - {candidate.type}
                        </LinkButton>
                    </li>
                ))}
            </ul>
        </div>
    </Page>
);

export default PermalinkRedirectPage;
