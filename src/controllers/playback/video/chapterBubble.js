// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Chapter/trickplay preview-bubble HTML, shown while scrubbing the seek
 * slider. Extracted from video/index.js (queue task c180) to make room in
 * that file for a genuinely new feature (the subtitle-cycle hotkey) without
 * growing an already-oversized file: these three functions take every
 * dependency as a parameter and close over no page/player state, unlike
 * almost everything else in index.js, so they were a clean, low-risk seam.
 * Mirrors this directory's existing collaborator modules (VolumeControl.js,
 * permalinkResume.js): a real, independently meaningful unit, not a
 * `*.helpers`/`*.utils` split.
 *
 * @module controllers/playback/video/chapterBubble
 */
import escapeHtml from 'escape-html';
import datetime from '../../../scripts/datetime';

/**
 * Render (or update in place) the trickplay thumbnail bubble for the given
 * seek position.
 * @param {object} apiClient - Jellyfin API client for the current server.
 * @param {object} trickplayInfo - Trickplay tile grid metadata for this
 *   media source (Width, Height, Interval, TileWidth, TileHeight).
 * @param {object} item - The currently playing BaseItemDto.
 * @param {string} mediaSourceId - The active media source id.
 * @param {HTMLElement} bubble - The OSD's trickplay bubble container.
 * @param {number} positionTicks - The seek position, in ticks.
 * @returns {boolean} Always true; callers use this to confirm the update ran.
 */
export function updateTrickplayBubbleHtml(apiClient, trickplayInfo, item, mediaSourceId, bubble, positionTicks) {
    let doFullUpdate = false;
    let chapterThumbContainer = bubble.querySelector('.chapterThumbContainer');
    let chapterThumb;
    let chapterThumbText;
    let chapterThumbName;

    // Create bubble elements if they don't already exist
    if (chapterThumbContainer) {
        chapterThumb = chapterThumbContainer.querySelector('.chapterThumbWrapper');
        chapterThumbText = chapterThumbContainer.querySelector('h2.chapterThumbText');
        chapterThumbName = chapterThumbContainer.querySelector('div.chapterThumbText');
    } else {
        doFullUpdate = true;

        chapterThumbContainer = document.createElement('div');
        chapterThumbContainer.classList.add('chapterThumbContainer');
        chapterThumbContainer.style.overflow = 'hidden';

        chapterThumb = document.createElement('div');
        chapterThumb.classList.add('chapterThumbWrapper');
        chapterThumb.style.overflow = 'hidden';
        chapterThumb.style.width = trickplayInfo.Width + 'px';
        chapterThumb.style.height = trickplayInfo.Height + 'px';
        chapterThumbContainer.appendChild(chapterThumb);

        const chapterThumbTextContainer = document.createElement('div');
        chapterThumbTextContainer.classList.add('chapterThumbTextContainer');
        chapterThumbContainer.appendChild(chapterThumbTextContainer);

        chapterThumbName = document.createElement('div');
        chapterThumbName.classList.add('chapterThumbText', 'chapterThumbText-dim');
        chapterThumbTextContainer.appendChild(chapterThumbName);

        chapterThumbText = document.createElement('h2');
        chapterThumbText.classList.add('chapterThumbText');
        chapterThumbTextContainer.appendChild(chapterThumbText);
    }

    let chapter;
    for (const currentChapter of item.Chapters || []) {
        if (positionTicks < currentChapter.StartPositionTicks) {
            break;
        }

        chapter = currentChapter;
    }

    // Update trickplay values
    const currentTimeMs = positionTicks / 10_000;
    const currentTile = Math.floor(currentTimeMs / trickplayInfo.Interval);

    const tileSize = trickplayInfo.TileWidth * trickplayInfo.TileHeight;
    const tileOffset = currentTile % tileSize;
    const index = Math.floor(currentTile / tileSize);

    const tileOffsetX = tileOffset % trickplayInfo.TileWidth;
    const tileOffsetY = Math.floor(tileOffset / trickplayInfo.TileWidth);
    const offsetX = -(tileOffsetX * trickplayInfo.Width);
    const offsetY = -(tileOffsetY * trickplayInfo.Height);

    const imgSrc = apiClient.getUrl('Videos/' + item.Id + '/Trickplay/' + trickplayInfo.Width + '/' + index + '.jpg', {
        ApiKey: apiClient.accessToken(),
        MediaSourceId: mediaSourceId
    });

    chapterThumb.style.backgroundImage = `url('${imgSrc}')`;
    chapterThumb.style.backgroundPositionX = offsetX + 'px';
    chapterThumb.style.backgroundPositionY = offsetY + 'px';

    chapterThumbText.textContent = datetime.getDisplayRunningTime(positionTicks);
    chapterThumbName.textContent = chapter?.Name || '';

    // Set bubble innerHTML if container isn't part of DOM
    if (doFullUpdate) {
        bubble.innerHTML = chapterThumbContainer.outerHTML;
    }

    return true;
}

function getImgUrl(item, chapter, index, maxWidth, apiClient) {
    if (chapter.ImageTag) {
        return apiClient.getScaledImageUrl(item.Id, {
            maxWidth: maxWidth,
            tag: chapter.ImageTag,
            type: 'Chapter',
            index: index
        });
    }

    return null;
}

/**
 * Render the chapter-image preview bubble's HTML for the given seek
 * position, or null when there is no chapter image to show.
 * @param {object} apiClient - Jellyfin API client for the current server.
 * @param {object} item - The currently playing BaseItemDto.
 * @param {Array<object>} chapters - The item's chapters.
 * @param {number} positionTicks - The seek position, in ticks.
 * @returns {string | null} The bubble's inner HTML, or null.
 */
export function getChapterBubbleHtml(apiClient, item, chapters, positionTicks) {
    let chapter;
    let index = -1;

    for (let i = 0, length = chapters.length; i < length; i++) {
        const currentChapter = chapters[i];

        if (positionTicks >= currentChapter.StartPositionTicks) {
            chapter = currentChapter;
            index = i;
        }
    }

    if (!chapter) {
        return null;
    }

    const src = getImgUrl(item, chapter, index, 400, apiClient);

    if (src) {
        let html = '<div class="chapterThumbContainer">';
        html += '<img class="chapterThumb" src="' + src + '" />';
        html += '<div class="chapterThumbTextContainer">';
        html += '<div class="chapterThumbText chapterThumbText-dim">';
        html += escapeHtml(chapter.Name);
        html += '</div>';
        html += '<h2 class="chapterThumbText">';
        html += datetime.getDisplayRunningTime(positionTicks);
        html += '</h2>';
        html += '</div>';
        return html + '</div>';
    }

    return null;
}
