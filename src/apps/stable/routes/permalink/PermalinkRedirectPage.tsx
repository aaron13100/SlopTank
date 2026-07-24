/**
 * Presentation for resolved and unresolved permalink route states.
 * allow-no-test-found: exercised through deployed routes by e2e/permalink.spec.ts
 */
import { useQuery } from '@tanstack/react-query';
import React, { type FC } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';

import Loading from 'components/loading/LoadingComponent';
import Page from 'components/Page';
import { parsePermalinkId, permalinkStartSecondsToTicks } from 'components/router/permalinkId';
import { resolvePermalink, type PermalinkCandidate } from 'components/router/permalinkResolver';
import { useApi } from 'hooks/useApi';
import globalize from 'lib/globalize';
import LinkButton from 'elements/emby-button/LinkButton';

export type PermalinkPurpose = 'info' | 'watch';

/**
 * Renders one of the two pretty-permalink hash routes (#/p/:permalinkId,
 * #/w/:permalinkId, docs/internal/permalink-url-design.md section 3). On a
 * resolved match this replaces the entry with the corresponding legacy
 * route (#/details or #/video) so the existing, already-tested detail and
 * playback controllers own everything past this point; ambiguity, not-found
 * and error states render here instead of guessing.
 */
const PermalinkRedirectPage: FC<{ purpose: PermalinkPurpose }> = ({ purpose }) => {
    const { permalinkId } = useParams();
    const [ searchParams ] = useSearchParams();
    const { api } = useApi();
    const parsed = permalinkId ? parsePermalinkId(permalinkId) : null;

    const { data, isPending, isError, error } = useQuery({
        queryKey: [ 'Permalink', permalinkId, api?.basePath ],
        queryFn: () => resolvePermalink(api!, parsed!),
        enabled: !!api && !!parsed,
        staleTime: 1000
    });

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
        return <PermalinkMessage text={globalize.translate('PermalinkResolveError', String(error))} />;
    }

    if (!data) {
        return <PermalinkMessage text={globalize.translate('PermalinkResolveError', 'no response')} />;
    }

    if (data.status === 'resolved') {
        return <Navigate replace to={toRouteLocation(purpose, data.item, searchParams)} />;
    }

    if (data.status === 'ambiguous') {
        return <PermalinkChooser purpose={purpose} candidates={data.candidates} />;
    }

    if (data.status === 'unsupported') {
        return <PermalinkMessage text={data.reason} />;
    }

    if (data.status === 'error') {
        return <PermalinkMessage text={globalize.translate('PermalinkResolveError', data.message)} />;
    }

    // not-found
    return <PermalinkMessage text={globalize.translate('PermalinkNotFound', permalinkId)} />;
};

function toRouteLocation(purpose: PermalinkPurpose, item: PermalinkCandidate, searchParams: URLSearchParams) {
    let search = `?id=${item.id}&serverId=${item.serverId}`;

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

const PermalinkMessage: FC<{ text: string }> = ({ text }) => (
    <Page id='permalinkMessagePage' className='mainAnimatedPage libraryPage' shouldAutoFocus>
        <div className='padded-left padded-right'>
            <p>{text}</p>
            <LinkButton className='button-link' href='#/home'>
                {globalize.translate('GoHome')}
            </LinkButton>
        </div>
    </Page>
);

const PermalinkChooser: FC<{ purpose: PermalinkPurpose, candidates: PermalinkCandidate[] }> = ({ purpose, candidates }) => (
    <Page id='permalinkChooserPage' className='mainAnimatedPage libraryPage' shouldAutoFocus>
        <div className='padded-left padded-right'>
            <p>{globalize.translate('PermalinkAmbiguous')}</p>
            <ul>
                {candidates.map(candidate => (
                    <li key={candidate.id}>
                        <LinkButton
                            className='button-link'
                            href={`#${purpose === 'info' ? '/details' : '/video'}?id=${candidate.id}&serverId=${candidate.serverId}`}
                        >
                            {candidate.name}{candidate.productionYear ? ` (${candidate.productionYear})` : ''} -- {candidate.type}
                        </LinkButton>
                    </li>
                ))}
            </ul>
        </div>
    </Page>
);

export default PermalinkRedirectPage;
