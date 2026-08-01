import { afterEach, describe, expect, it } from 'vitest';

import EpisodePlaybackMenu from './EpisodePlaybackMenu';

function createItem(overrides = {}) {
    return {
        Id: 'episode-1',
        Type: 'Episode',
        SeriesId: 'series-1',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        Name: 'The Beginning',
        Overview: 'The crew sets out together.',
        RunTimeTicks: 1_000,
        UserData: {
            Played: false,
            PlaybackPositionTicks: 250
        },
        ...overrides
    };
}

function createHarness({ episodes, loadError } = {}) {
    document.body.innerHTML = `
        <button class="btnEpisodes hide" aria-expanded="false">Episodes</button>
        <section class="episodePlaybackMenu hide">
            <button class="episodePlaybackMenu-closeButton">Close</button>
            <div class="episodePlaybackMenu-list"></div>
        </section>
    `;
    const reportedErrors = [];
    const playedEpisodes = [];
    const lifecycleEvents = [];
    const menu = new EpisodePlaybackMenu({
        button: document.querySelector('.btnEpisodes'),
        panel: document.querySelector('.episodePlaybackMenu'),
        canPlay: item => item.LocationType !== 'Virtual',
        loadEpisodes: async () => {
            if (loadError) throw loadError;
            return episodes || [];
        },
        onClose: () => lifecycleEvents.push('close'),
        onOpen: () => lifecycleEvents.push('open'),
        onOutsideDismiss: () => lifecycleEvents.push('outside-dismiss'),
        playEpisode: async item => {
            playedEpisodes.push(item);
        },
        reportError: (...args) => {
            reportedErrors.push(args);
        },
        translate: key => ({
            Close: 'Close',
            CurrentEpisode: 'Current episode',
            Episodes: 'Episodes',
            NoOverviewAvailable: 'No summary available',
            Unwatched: 'Unwatched',
            Watched: 'Watched'
        })[key] || key
    });

    return { lifecycleEvents, menu, playedEpisodes, reportedErrors };
}

describe('EpisodePlaybackMenu', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('shows a multi-episode series with current, watched, summary, and resume state', async () => {
        const current = createItem();
        const watched = createItem({
            Id: 'episode-2',
            IndexNumber: 2,
            Name: 'The Return',
            Overview: '',
            UserData: { Played: true, PlaybackPositionTicks: 0 }
        });
        const harness = createHarness({ episodes: [ current, watched ] });

        await harness.menu.update(current);
        const button = document.querySelector('.btnEpisodes');
        button.click();

        expect(button.classList.contains('hide')).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(document.querySelector('.episodePlaybackMenu').classList.contains('hide')).toBe(false);
        expect(document.querySelectorAll('.episodePlaybackMenu-item')).toHaveLength(2);
        expect(document.querySelector('[data-item-id="episode-1"]').getAttribute('aria-current')).toBe('true');
        expect(document.querySelector('[data-item-id="episode-1"] .episodePlaybackMenu-summary').textContent)
            .toBe('The crew sets out together.');
        expect(document.querySelector('[data-item-id="episode-1"] [role="progressbar"]').getAttribute('aria-valuenow'))
            .toBe('25');
        expect(document.querySelector('[data-item-id="episode-2"] .episodePlaybackMenu-summary').textContent)
            .toBe('No summary available');
        expect(document.querySelector('[data-item-id="episode-2"] .episodePlaybackMenu-watchedState').textContent)
            .toBe('Watched');
    });

    it('switches through the visible episode button and closes the panel', async () => {
        const current = createItem();
        const next = createItem({ Id: 'episode-2', IndexNumber: 2, Name: 'The Return' });
        const harness = createHarness({ episodes: [ current, next ] });

        await harness.menu.update(current);
        document.querySelector('.btnEpisodes').click();
        document.querySelector('[data-item-id="episode-2"]').click();

        expect(harness.playedEpisodes).toEqual([ next ]);
        expect(document.querySelector('.episodePlaybackMenu').classList.contains('hide')).toBe(true);
        expect(document.querySelector('.btnEpisodes').getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on Escape before the player handles the key', async () => {
        const current = createItem();
        const next = createItem({ Id: 'episode-2', IndexNumber: 2 });
        const harness = createHarness({ episodes: [ current, next ] });

        await harness.menu.update(current);
        document.querySelector('.btnEpisodes').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(document.querySelector('.episodePlaybackMenu').classList.contains('hide')).toBe(true);
        expect(harness.lifecycleEvents).toEqual([ 'open', 'close', 'outside-dismiss' ]);
    });

    it('omits the control for movies, one playable episode, and virtual episodes', async () => {
        const current = createItem();
        const virtual = createItem({ Id: 'episode-2', LocationType: 'Virtual' });
        const harness = createHarness({ episodes: [ current, virtual ] });

        await harness.menu.update({ Id: 'movie-1', Type: 'Movie' });
        expect(document.querySelector('.btnEpisodes').classList.contains('hide')).toBe(true);

        await harness.menu.update(current);
        expect(document.querySelector('.btnEpisodes').classList.contains('hide')).toBe(true);
    });

    it('fails closed and reports the underlying episode request error', async () => {
        const requestError = new TypeError('HTTP 500 from /Shows/series-1/Episodes');
        const harness = createHarness({ loadError: requestError });

        await harness.menu.update(createItem());

        expect(document.querySelector('.btnEpisodes').classList.contains('hide')).toBe(true);
        expect(harness.reportedErrors).toEqual([[ 'EpisodeListFailed', requestError ]]);
    });
});
