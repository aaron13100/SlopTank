import cardBuilder from 'components/cardbuilder/cardBuilder';
import imageLoader from 'components/images/imageLoader';
import { ServerConnections } from 'lib/jellyfin-apiclient';

const SUPPORTED_ITEM_TYPES = new Set([
    'Movie',
    'Trailer',
    'Series',
    'Program',
    'Recording',
    'MusicAlbum',
    'MusicArtist',
    'Playlist',
    'Audio'
]);

const activeRenders = new WeakMap();

export function disposeSimilarItems(page) {
    const activeRender = activeRenders.get(page);

    if (activeRender?.observer) {
        activeRender.observer.disconnect();
    }

    activeRenders.delete(page);
}

function loadSimilarItems(page, item, context, section, render) {
    const apiClient = ServerConnections.getApiClient(item.ServerId);
    const options = {
        userId: apiClient.getCurrentUserId(),
        limit: 12,
        fields: 'PrimaryImageAspectRatio,CanDelete'
    };

    if (item.Type === 'MusicAlbum' && item.AlbumArtists?.length) {
        options.ExcludeArtistIds = item.AlbumArtists[0].Id;
    }

    apiClient.getSimilarItems(item.Id, options).then(function (result) {
        if (activeRenders.get(page) !== render || !section.isConnected) {
            return;
        }

        if (!result.Items.length) {
            section.classList.add('hide');
            return;
        }

        const html = cardBuilder.getCardsHtml({
            items: result.Items,
            shape: 'autooverflow',
            showParentTitle: item.Type === 'MusicAlbum',
            centerText: true,
            showTitle: true,
            context,
            lazy: true,
            showDetailsMenu: true,
            coverImage: item.Type === 'MusicAlbum' || item.Type === 'MusicArtist',
            overlayPlayButton: true,
            overlayText: false,
            showYear: item.Type === 'Movie' || item.Type === 'Trailer' || item.Type === 'Series'
        });
        const similarContent = section.querySelector('.similarContent');

        if (similarContent) {
            similarContent.innerHTML = html;
            imageLoader.lazyChildren(similarContent);
            section.classList.remove('hide');
        }
    });
}

export default function renderSimilarItems(page, item, context) {
    disposeSimilarItems(page);

    const section = page.querySelector('#similarCollapsible');

    if (!section) {
        return;
    }

    if (!SUPPORTED_ITEM_TYPES.has(item.Type)) {
        section.classList.add('hide');
        return;
    }

    section.classList.remove('hide');

    const render = {
        observer: null
    };
    activeRenders.set(page, render);

    if (typeof IntersectionObserver === 'undefined') {
        loadSimilarItems(page, item, context, section, render);
        return;
    }

    render.observer = new IntersectionObserver((entries, observer) => {
        if (!entries.some(entry => entry.isIntersecting) || activeRenders.get(page) !== render) {
            return;
        }

        observer.disconnect();
        render.observer = null;
        loadSimilarItems(page, item, context, section, render);
    }, {
        rootMargin: '0px',
        threshold: 0
    });
    render.observer.observe(section);
}
