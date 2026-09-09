// SlopTank modification notice: added or changed by SlopTank on 2026-08-01, 2026-09-09.
/**
 * In-player series episode list controller.
 * @module controllers/playback/video/EpisodePlaybackMenu
 */

/**
 * Clamp a resume percentage to the progress-bar contract.
 * @param {Object} item - Episode item with user playback data.
 * @returns {number} Integer percentage from 0 through 100.
 */
function getProgressPercent(item) {
    if (item.UserData?.Played) return 100;

    const reported = Number(item.UserData?.PlayedPercentage);
    if (Number.isFinite(reported)) {
        return Math.round(Math.min(Math.max(reported, 0), 100));
    }

    const position = Number(item.UserData?.PlaybackPositionTicks);
    const runtime = Number(item.RunTimeTicks);
    if (Number.isFinite(position) && Number.isFinite(runtime) && runtime > 0) {
        return Math.round(Math.min(Math.max(position / runtime * 100, 0), 100));
    }

    return 0;
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
        this.onOpen = options.onOpen || options.onInteract;
        this.onClose = options.onClose || options.onInteract;
        this.onOutsideDismiss = options.onOutsideDismiss || options.onInteract;
        this.playEpisode = options.playEpisode;
        this.reportError = options.reportError;
        this.translate = options.translate;
        this.list = this.panel.querySelector('.episodePlaybackMenu-list');
        this.closeButton = this.panel.querySelector('.episodePlaybackMenu-closeButton');
        this.currentItemId = null;
        this.episodes = [];
        this.updateId = 0;
        this.destroyed = false;

        this.button.addEventListener('click', this.onButtonClick);
        this.closeButton.addEventListener('click', this.onCloseClick);
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

    onListClick = event => {
        const button = event.target.closest('.episodePlaybackMenu-item');
        if (!button || button.disabled) return;

        const item = this.episodes.find(episode => episode.Id === button.dataset.itemId);
        if (!item) return;

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
            this.render();
            this.button.classList.remove('hide');
        } catch (error) {
            if (!this.destroyed && updateId === this.updateId) {
                this.reportError('EpisodeListFailed', error);
            }
        }
    }

    /**
     * Reveal the list and move focus to its first playable row.
     * @returns {void}
     */
    open() {
        if (this.button.classList.contains('hide') || this.episodes.length <= 1) return;

        this.panel.classList.remove('hide');
        this.button.setAttribute('aria-expanded', 'true');
        this.onOpen();
        const target = this.list.querySelector('.episodePlaybackMenu-item:not([disabled])');
        (target || this.closeButton).focus();
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
     * @returns {boolean} True while the list overlay is open.
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
        this.list.removeEventListener('click', this.onListClick);
        document.removeEventListener('keydown', this.onDocumentKeyDown, { capture: true });
        document.removeEventListener('pointerdown', this.onDocumentPointerDown, { capture: true });
    }

    setUnavailable() {
        this.close();
        this.currentItemId = null;
        this.episodes = [];
        this.list.replaceChildren();
        this.button.classList.add('hide');
        this.button.setAttribute('aria-expanded', 'false');
    }

    render() {
        const fragment = document.createDocumentFragment();
        for (const episode of this.episodes) fragment.append(this.createEpisodeButton(episode));
        this.list.replaceChildren(fragment);
    }

    createEpisodeButton(item) {
        const isCurrent = item.Id === this.currentItemId;
        const progress = getProgressPercent(item);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'episodePlaybackMenu-item';
        button.dataset.itemId = item.Id;
        button.disabled = isCurrent;
        if (isCurrent) button.setAttribute('aria-current', 'true');

        const heading = document.createElement('span');
        heading.className = 'episodePlaybackMenu-heading';
        const title = document.createElement('span');
        title.className = 'episodePlaybackMenu-title';
        title.textContent = this.getEpisodeTitle(item);
        heading.append(title);

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
        const watched = document.createElement('span');
        watched.className = 'episodePlaybackMenu-watchedState';
        watched.textContent = this.translate(item.UserData?.Played ? 'Watched' : 'Unwatched');
        const progressText = document.createElement('span');
        progressText.className = 'episodePlaybackMenu-progressText';
        progressText.textContent = `${progress}%`;
        status.append(watched, progressText);

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

    getEpisodeTitle(item) {
        const season = item.ParentIndexNumber;
        const episode = item.IndexNumber;
        const index = season != null && episode != null ?
            `S${season}:E${episode}` :
            `${this.translate('Episode')} ${episode ?? '?'}`;
        return `${index} - ${item.Name || this.translate('Episode')}`;
    }
}
