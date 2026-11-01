// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-09, 2026-11-01.
/**
 * In-player series episode list controller.
 * @module controllers/playback/video/EpisodePlaybackMenu
 */

const STATUS_PRESENTATION = {
    watched: { icon: 'check_circle', label: 'Watched' },
    partial: { icon: 'play_circle', label: 'ButtonResume' },
    unwatched: { icon: 'visibility', label: 'Unwatched' }
};

/**
 * Clamp a resume percentage to the progress-bar contract.
 * @param {Object} item - Episode item with user playback data.
 * @returns {number} Integer percentage from 0 through 100.
 */
function getProgressPercent(item) {
    const userData = item.UserData;
    if (userData?.Played) return 100;

    const position = Number(userData?.PlaybackPositionTicks);
    const runtime = Number(item.RunTimeTicks);
    if (Number.isFinite(position) && position > 0 && Number.isFinite(runtime) && runtime > 0) {
        return Math.max(1, Math.round(Math.min(Math.max(position / runtime * 100, 0), 100)));
    }

    const reported = Number(userData?.PlayedPercentage);
    if (Number.isFinite(reported)) {
        return Math.round(Math.min(Math.max(reported, 0), 100));
    }

    return 0;
}

/**
 * @param {Object} item - Episode item with season metadata.
 * @returns {string} Stable grouping key for its season.
 */
function getSeasonKey(item) {
    if (item.SeasonId != null && String(item.SeasonId) !== '') return `id:${item.SeasonId}`;
    if (item.ParentIndexNumber != null && String(item.ParentIndexNumber) !== '') {
        return `number:${item.ParentIndexNumber}`;
    }

    return 'unknown';
}

/**
 * Owns the playback OSD's episode button and list overlay. Data access and
 * playback stay behind injected adapters so this module only presents state.
 */
export default class EpisodePlaybackMenu {
    /**
     * @param {Object} options - Menu elements and boundary adapters.
     * @param {HTMLElement} options.button - OSD Episodes button.
     * @param {HTMLElement} options.panel - Episode list overlay.
     * @param {Function} options.canPlay - Returns whether an item is playable.
     * @param {Function} options.loadEpisodes - Loads series episode items.
     * @param {Function} [options.getPlaybackPositionTicks] - Reads current playback position in ticks.
     * @param {Function} options.onInteract - Keeps the OSD awake after input.
     * @param {Function} options.playEpisode - Starts the selected episode.
     * @param {Function} options.reportError - Surfaces an operation error.
     * @param {Function} options.translate - Localizes visible strings.
     */
    constructor(options) {
        this.button = options.button;
        this.panel = options.panel;
        this.canPlay = options.canPlay;
        this.loadEpisodes = options.loadEpisodes;
        this.getPlaybackPositionTicks = options.getPlaybackPositionTicks;
        this.onOpen = options.onOpen || options.onInteract;
        this.onClose = options.onClose || options.onInteract;
        this.onOutsideDismiss = options.onOutsideDismiss || options.onInteract;
        this.playEpisode = options.playEpisode;
        this.reportError = options.reportError;
        this.translate = options.translate;
        this.list = this.panel.querySelector('.episodePlaybackMenu-list');
        this.seasonSelect = this.panel.querySelector('.episodePlaybackMenu-seasonSelect');
        this.closeButton = this.panel.querySelector('.episodePlaybackMenu-closeButton');
        this.currentItemId = null;
        this.currentSeasonKey = null;
        this.selectedSeasonKey = null;
        this.episodes = [];
        this.seasons = [];
        this.updateId = 0;
        this.destroyed = false;

        this.button.addEventListener('click', this.onButtonClick);
        this.closeButton.addEventListener('click', this.onCloseClick);
        this.seasonSelect?.addEventListener('change', this.onSeasonChange);
        this.list.addEventListener('click', this.onListClick);
        document.addEventListener('keydown', this.onDocumentKeyDown, { capture: true });
        document.addEventListener('pointerdown', this.onDocumentPointerDown, { capture: true });
    }

    onButtonClick = () => {
        if (this.hasOpenOverlay()) this.close();
        else this.open();
    };

    onCloseClick = () => {
        this.close();
    };

    onSeasonChange = () => {
        if (!this.seasonSelect) return;

        this.selectedSeasonKey = this.seasonSelect.value;
        this.render();
        this.list.scrollTop = 0;

        if (this.selectedSeasonKey === this.currentSeasonKey) this.centerCurrentEpisode();
        this.seasonSelect.focus({ preventScroll: true });
    };

    onListClick = event => {
        const button = event.target.closest('.episodePlaybackMenu-item');
        if (!button || button.getAttribute('aria-disabled') === 'true') return;

        const item = this.episodes.find(episode => episode.Id === button.dataset.itemId);
        if (!item || item.Id === this.currentItemId) return;

        this.close();
        this.playEpisode(item).catch(error => {
            this.reportError('EpisodeSwitchFailed', error);
        });
    };

    onDocumentKeyDown = event => {
        if (!this.hasOpenOverlay() || (event.key !== 'Escape' && event.key !== 'Back')) return;
        this.close();
        event.preventDefault();
        event.stopPropagation();
        this.onOutsideDismiss();
    };

    onDocumentPointerDown = event => {
        if (!this.hasOpenOverlay() || this.panel.contains(event.target) || this.button.contains(event.target)) return;
        this.close();
        if (!event.target.closest('.videoOsdBottom, .skinHeader, .upNextContainer')) {
            event.stopPropagation();
            this.onOutsideDismiss();
        }
    };

    /**
     * Refresh eligibility and contents for the active playback item.
     * @param {Object|null} item - Current playback item.
     * @returns {Promise<void>}
     */
    async update(item) {
        const updateId = ++this.updateId;
        this.setUnavailable();

        if (!item || item.Type !== 'Episode' || !item.SeriesId) return;

        try {
            const loadedEpisodes = await this.loadEpisodes(item);
            if (this.destroyed || updateId !== this.updateId) return;

            const seenIds = new Set();
            this.episodes = (loadedEpisodes || []).filter(episode => {
                if (!episode?.Id || episode.Type !== 'Episode' || seenIds.has(episode.Id)
                        || !this.canPlay(episode)) {
                    return false;
                }
                seenIds.add(episode.Id);
                return true;
            });

            if (this.episodes.length <= 1) return;

            this.currentItemId = item.Id;
            const currentEpisode = this.episodes.find(episode => episode.Id === item.Id);
            this.currentSeasonKey = getSeasonKey(currentEpisode || item);
            this.populateSeasons();
            this.selectSeason(this.currentSeasonKey);
            this.render();
            this.button.classList.remove('hide');
        } catch (error) {
            if (!this.destroyed && updateId === this.updateId) {
                this.reportError('EpisodeListFailed', error);
            }
        }
    }

    /**
     * Reveal the list, select the playing episode's season, and center its row.
     * @returns {void}
     */
    open() {
        if (this.button.classList.contains('hide') || this.episodes.length <= 1) return;

        this.selectSeason(this.currentSeasonKey);
        this.refreshCurrentEpisodeProgress();
        this.render();
        this.panel.classList.remove('hide');
        this.button.setAttribute('aria-expanded', 'true');
        this.onOpen();

        if (!this.focusCurrentEpisode()) {
            const target = this.list.querySelector('.episodePlaybackMenu-item:not([aria-disabled="true"])');
            if (target) this.focusAndCenter(target);
            else this.closeButton.focus({ preventScroll: true });
        }
    }

    /**
     * Hide the list and return focus to the Episodes button when appropriate.
     * @returns {void}
     */
    close() {
        if (!this.hasOpenOverlay()) return;

        const hadFocus = this.panel.contains(document.activeElement);
        this.panel.classList.add('hide');
        this.button.setAttribute('aria-expanded', 'false');
        this.onClose();
        if (hadFocus && !this.button.classList.contains('hide')) this.button.focus();
    }

    /**
     * Whether the episode list is currently visible.
     * @returns {boolean} True while the episode list overlay is open.
     */
    hasOpenOverlay() {
        return !this.panel.classList.contains('hide');
    }

    /**
     * Remove listeners and invalidate any pending series response.
     * @returns {void}
     */
    destroy() {
        this.destroyed = true;
        this.updateId++;
        this.close();
        this.button.removeEventListener('click', this.onButtonClick);
        this.closeButton.removeEventListener('click', this.onCloseClick);
        this.seasonSelect?.removeEventListener('change', this.onSeasonChange);
        this.list.removeEventListener('click', this.onListClick);
        document.removeEventListener('keydown', this.onDocumentKeyDown, { capture: true });
        document.removeEventListener('pointerdown', this.onDocumentPointerDown, { capture: true });
    }

    setUnavailable() {
        this.close();
        this.currentItemId = null;
        this.currentSeasonKey = null;
        this.selectedSeasonKey = null;
        this.episodes = [];
        this.seasons = [];
        this.list.replaceChildren();
        this.seasonSelect?.replaceChildren();
        this.button.classList.add('hide');
        this.button.setAttribute('aria-expanded', 'false');
    }

    populateSeasons() {
        const seasonMap = new Map();
        for (const episode of this.episodes) {
            const key = getSeasonKey(episode);
            const existing = seasonMap.get(key);
            if (existing) {
                if (existing.number == null && episode.ParentIndexNumber != null) {
                    existing.number = episode.ParentIndexNumber;
                }
                continue;
            }

            seasonMap.set(key, {
                key,
                number: episode.ParentIndexNumber
            });
        }

        this.seasons = Array.from(seasonMap.values());
        const fragment = document.createDocumentFragment();
        for (const season of this.seasons) {
            const option = document.createElement('option');
            option.value = season.key;
            option.textContent = season.number == null ?
                `${this.translate('Season')} ?` :
                `${this.translate('Season')} ${season.number}`;
            fragment.append(option);
        }
        this.seasonSelect?.replaceChildren(fragment);
    }

    selectSeason(preferredKey) {
        const selected = this.seasons.find(season => season.key === preferredKey) || this.seasons[0];
        this.selectedSeasonKey = selected?.key || null;
        if (this.seasonSelect) this.seasonSelect.value = this.selectedSeasonKey || '';
    }

    render() {
        const fragment = document.createDocumentFragment();
        for (const episode of this.episodes) {
            if (getSeasonKey(episode) === this.selectedSeasonKey) {
                fragment.append(this.createEpisodeButton(episode));
            }
        }
        this.list.replaceChildren(fragment);
    }

    focusCurrentEpisode() {
        const current = this.list.querySelector('.episodePlaybackMenu-item[aria-current="true"]');
        if (!current) return false;

        this.focusAndCenter(current);
        return true;
    }

    focusAndCenter(element) {
        element.focus({ preventScroll: true });
        this.centerElement(element);
    }

    centerElement(element) {
        const listBounds = this.list.getBoundingClientRect();
        const elementBounds = element.getBoundingClientRect();
        const elementCenter = elementBounds.top - listBounds.top + elementBounds.height / 2;
        const nextScrollTop = this.list.scrollTop + elementCenter - this.list.clientHeight / 2;
        this.list.scrollTop = Math.max(0, Math.min(nextScrollTop, this.list.scrollHeight - this.list.clientHeight));
    }

    centerCurrentEpisode() {
        const current = this.list.querySelector('.episodePlaybackMenu-item[aria-current="true"]');
        if (!current) return;

        this.centerElement(current);
    }

    refreshCurrentEpisodeProgress() {
        if (typeof this.getPlaybackPositionTicks !== 'function') return;

        const currentTicks = this.getPlaybackPositionTicks();
        if (!Number.isFinite(currentTicks) || currentTicks < 0) return;

        const currentIndex = this.episodes.findIndex(episode => episode.Id === this.currentItemId);
        if (currentIndex < 0) return;

        const currentEpisode = this.episodes[currentIndex];
        const runtime = Number(currentEpisode.RunTimeTicks);
        if (!Number.isFinite(runtime) || runtime <= 0) return;

        const playedPercentage = Math.min(currentTicks / runtime * 100, 100);
        this.episodes[currentIndex] = {
            ...currentEpisode,
            UserData: {
                ...currentEpisode.UserData,
                PlaybackPositionTicks: currentTicks,
                PlayedPercentage: playedPercentage
            }
        };
    }

    createEpisodeButton(item) {
        const isCurrent = item.Id === this.currentItemId;
        const played = Boolean(item.UserData?.Played);
        const progress = getProgressPercent(item);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'episodePlaybackMenu-item';
        button.dataset.itemId = item.Id;
        if (isCurrent) {
            button.setAttribute('aria-current', 'true');
            button.setAttribute('aria-disabled', 'true');
        }

        const heading = document.createElement('span');
        heading.className = 'episodePlaybackMenu-heading';
        const episodeNumber = document.createElement('span');
        episodeNumber.className = 'episodePlaybackMenu-number';
        episodeNumber.textContent = item.IndexNumber == null ? '-' : String(item.IndexNumber).padStart(2, '0');
        const title = document.createElement('span');
        title.className = 'episodePlaybackMenu-title';
        title.textContent = item.Name || this.translate('Episode');
        heading.append(episodeNumber, title);

        if (isCurrent) {
            const current = document.createElement('span');
            current.className = 'episodePlaybackMenu-current';
            current.textContent = this.translate('CurrentEpisode');
            heading.append(current);
        }

        const summary = document.createElement('span');
        summary.className = 'episodePlaybackMenu-summary';
        summary.textContent = item.Overview || this.translate('NoOverviewAvailable');

        const status = document.createElement('span');
        status.className = 'episodePlaybackMenu-status';
        let statusType = 'unwatched';
        if (played) statusType = 'watched';
        else if (progress > 0) statusType = 'partial';
        const presentation = STATUS_PRESENTATION[statusType];
        status.classList.add(`episodePlaybackMenu-status--${statusType}`);
        const statusIcon = document.createElement('span');
        statusIcon.className = 'episodePlaybackMenu-statusIcon material-icons';
        statusIcon.setAttribute('aria-hidden', 'true');
        statusIcon.textContent = presentation.icon;
        const statusText = document.createElement('span');
        statusText.className = 'episodePlaybackMenu-watchedState';
        statusText.textContent = this.translate(presentation.label);
        status.append(statusIcon, statusText);

        if (!played && progress > 0) {
            const progressText = document.createElement('span');
            progressText.className = 'episodePlaybackMenu-progressText';
            progressText.textContent = `${progress}%`;
            status.append(progressText);

            const progressBar = document.createElement('span');
            progressBar.className = 'episodePlaybackMenu-progress';
            progressBar.setAttribute('role', 'progressbar');
            progressBar.setAttribute('aria-label', `${this.translate('ButtonResume')} ${progress}%`);
            progressBar.setAttribute('aria-valuemin', '0');
            progressBar.setAttribute('aria-valuemax', '100');
            progressBar.setAttribute('aria-valuenow', String(progress));
            const progressValue = document.createElement('span');
            progressValue.className = 'episodePlaybackMenu-progressValue';
            progressValue.style.width = `${progress}%`;
            progressBar.append(progressValue);
            button.append(heading, summary, status, progressBar);
            return button;
        }

        button.append(heading, summary, status);
        return button;
    }
}
