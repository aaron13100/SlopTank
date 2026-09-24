// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns the seek slider and the time texts around it: position, remaining
 * time and ends-at, live-TV time-of-day progress, slider bubbles and
 * chapter markers, and seeking from the slider.
 *
 * Constructed by video/index.js, which injects its dependencies (the view,
 * the slider element, the playback manager adapter, and accessors for the
 * current player/item/trickplay resolution).
 *
 * @module controllers/playback/video/positionDisplay
 */

import datetime from '../../../scripts/datetime';
import mediaInfo from '../../../components/mediainfo/mediainfo';
import layoutManager from '../../../components/layoutManager';
import * as userSettings from '../../../scripts/settings/userSettings';
import keyboardnavigation from '../../../scripts/keyboardNavigation';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getChapterBubbleHtml, updateTrickplayBubbleHtml } from './chapterBubble';

/**
 * Creates the position display controller.
 *
 * @param {object} options - Dependencies injected by video/index.js.
 * @param {HTMLElement} options.view - The video OSD view element.
 * @param {HTMLElement} options.slider - The .osdPositionSlider element.
 * @param {object} options.playback - The playback manager adapter.
 * @param {Function} options.getPlayer - Returns the current player.
 * @param {Function} options.getItem - Returns the current now-playing item.
 * @param {Function} options.getTrickplayResolution - Returns the current trickplay resolution.
 * @param {Function} options.showOsd - Shows the OSD (resets its idle timer).
 * @returns {object} { updateTimeDisplay, setProgressByTimeOfDay, setProgramTimes, setPlaybackStartTimeTicks, setRuntimeTicks, bind }
 */
export function createPositionDisplay(options) {
    const { view, slider, playback, getPlayer, getItem, getTrickplayResolution, showOsd } = options;

    const nowPlayingPositionSlider = slider;
    const nowPlayingPositionText = view.querySelector('.osdPositionText');
    const nowPlayingDurationText = view.querySelector('.osdDurationText');
    const startTimeText = view.querySelector('.startTimeText');
    const endTimeText = view.querySelector('.endTimeText');
    const endsAtText = view.querySelector('.endsAtText');

    let enableProgressByTimeOfDay;
    let programStartDateMs = 0;
    let programEndDateMs = 0;
    let playbackStartTimeTicks = 0;
    let currentRuntimeTicks = 0;

    function getDisplayTimeWithoutAmPm(date, showSeconds) {
        if (showSeconds) {
            return datetime.toLocaleTimeString(date, {
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit'
            }).toLowerCase().replace('am', '').replace('pm', '').trim();
        }

        return datetime.getDisplayTime(date).toLowerCase().replace('am', '').replace('pm', '').trim();
    }

    function setDisplayTime(elem, date) {
        let html;

        if (date) {
            date = datetime.parseISO8601Date(date);
            html = getDisplayTimeWithoutAmPm(date);
        }

        elem.innerHTML = html || '';
    }

    function shouldEnableProgressByTimeOfDay(item) {
        return !(item.Type !== 'TvChannel' || !item.CurrentProgram);
    }

    function getDisplayPercentByTimeOfDay(startDateMs, runtimeMs, nowMs) {
        return (nowMs - startDateMs) / runtimeMs * 100;
    }

    function updateTimeText(elem, ticks, divider) {
        if (ticks == null) {
            elem.innerHTML = '';
            return;
        }

        let html = datetime.getDisplayRunningTime(ticks);

        if (divider) {
            html = '&nbsp;/&nbsp;' + html;
        }

        elem.innerHTML = html;
    }

    function nowPlayingDurationTextClick() {
        userSettings.enableVideoRemainingTime(!userSettings.enableVideoRemainingTime());
        // immediately update the text, without waiting for the next tick update or if the player is paused
        const state = playback.getPlayerState(getPlayer());
        const playState = state.PlayState;
        const nowPlayingItem = state.NowPlayingItem;
        updateTimeDisplay(playState.PositionTicks, nowPlayingItem.RunTimeTicks, playState.PlaybackStartTimeTicks, playState.PlaybackRate, playState.BufferedRanges || []);
    }

    function updateTimeDisplay(positionTicks, runtimeTicks, playStartTimeTicks, playbackRate, bufferedRanges) {
        if (enableProgressByTimeOfDay) {
            if (nowPlayingPositionSlider && !nowPlayingPositionSlider.dragging) {
                if (programStartDateMs && programEndDateMs) {
                    const currentTimeMs = (playStartTimeTicks + (positionTicks || 0)) / 1e4;
                    const programRuntimeMs = programEndDateMs - programStartDateMs;

                    nowPlayingPositionSlider.value = getDisplayPercentByTimeOfDay(programStartDateMs, programRuntimeMs, currentTimeMs);

                    if (bufferedRanges.length) {
                        const rangeStart = getDisplayPercentByTimeOfDay(programStartDateMs, programRuntimeMs, (playStartTimeTicks + (bufferedRanges[0].start || 0)) / 1e4);
                        const rangeEnd = getDisplayPercentByTimeOfDay(programStartDateMs, programRuntimeMs, (playStartTimeTicks + (bufferedRanges[0].end || 0)) / 1e4);
                        nowPlayingPositionSlider.setBufferedRanges([{
                            start: rangeStart,
                            end: rangeEnd
                        }]);
                    } else {
                        nowPlayingPositionSlider.setBufferedRanges([]);
                    }
                } else {
                    nowPlayingPositionSlider.value = 0;
                    nowPlayingPositionSlider.setBufferedRanges([]);
                }
            }

            nowPlayingPositionText.innerHTML = '';
            nowPlayingDurationText.innerHTML = '';
        } else {
            if (nowPlayingPositionSlider && !nowPlayingPositionSlider.dragging) {
                if (runtimeTicks) {
                    let pct = positionTicks / runtimeTicks;
                    pct *= 100;
                    nowPlayingPositionSlider.value = pct;
                } else {
                    nowPlayingPositionSlider.value = 0;
                }

                if (runtimeTicks && positionTicks != null && currentRuntimeTicks && !enableProgressByTimeOfDay && getItem().RunTimeTicks && getItem().Type !== 'Recording' && playbackRate !== null) {
                    endsAtText.innerHTML = '&nbsp;&nbsp;&nbsp;&nbsp;' + mediaInfo.getEndsAtFromPosition(runtimeTicks, positionTicks, playbackRate, true);
                } else {
                    endsAtText.innerHTML = '';
                }
            }

            if (nowPlayingPositionSlider) {
                nowPlayingPositionSlider.setBufferedRanges(bufferedRanges, runtimeTicks, positionTicks);
            }

            if (positionTicks >= 0) {
                updateTimeText(nowPlayingPositionText, positionTicks);
                nowPlayingPositionText.classList.remove('hide');
            } else {
                nowPlayingPositionText.classList.add('hide');
            }

            if (userSettings.enableVideoRemainingTime()) {
                const leftTicks = runtimeTicks - positionTicks;
                if (leftTicks >= 0) {
                    updateTimeText(nowPlayingDurationText, leftTicks);
                    nowPlayingDurationText.innerHTML = '-' + nowPlayingDurationText.innerHTML;
                    nowPlayingDurationText.classList.remove('hide');
                } else {
                    nowPlayingPositionText.classList.add('hide');
                }
            } else {
                updateTimeText(nowPlayingDurationText, runtimeTicks);
                nowPlayingDurationText.classList.remove('hide');
            }
        }
    }

    function setProgressByTimeOfDay(item) {
        enableProgressByTimeOfDay = shouldEnableProgressByTimeOfDay(item);
    }

    function setProgramTimes(displayItem) {
        if (enableProgressByTimeOfDay) {
            setDisplayTime(startTimeText, displayItem.StartDate);
            setDisplayTime(endTimeText, displayItem.EndDate);
            startTimeText.classList.remove('hide');
            endTimeText.classList.remove('hide');
            programStartDateMs = displayItem.StartDate ? datetime.parseISO8601Date(displayItem.StartDate).getTime() : 0;
            programEndDateMs = displayItem.EndDate ? datetime.parseISO8601Date(displayItem.EndDate).getTime() : 0;
        } else {
            startTimeText.classList.add('hide');
            endTimeText.classList.add('hide');
            startTimeText.innerHTML = '';
            endTimeText.innerHTML = '';
            programStartDateMs = 0;
            programEndDateMs = 0;
        }
    }

    function setPlaybackStartTimeTicks(ticks) {
        playbackStartTimeTicks = ticks;
    }

    function setRuntimeTicks(ticks) {
        currentRuntimeTicks = ticks;
    }

    function bind() {
        nowPlayingPositionSlider.enableKeyboardDragging();

        if (layoutManager.tv) {
            nowPlayingPositionSlider.classList.add('focusable');
        }

        nowPlayingDurationText.addEventListener('click', nowPlayingDurationTextClick);

        nowPlayingPositionSlider.addEventListener('change', function () {
            const player = getPlayer();

            if (player) {
                const newPercent = parseFloat(this.value);

                if (enableProgressByTimeOfDay) {
                    let seekAirTimeTicks = newPercent / 100 * (programEndDateMs - programStartDateMs) * 1e4;
                    seekAirTimeTicks += 1e4 * programStartDateMs;
                    seekAirTimeTicks -= playbackStartTimeTicks;
                    playback.seek(seekAirTimeTicks, player);
                } else {
                    playback.seekPercent(newPercent, player);
                }
            }
        });

        nowPlayingPositionSlider.addEventListener('keydown', function (e) {
            if (e.defaultPrevented) return;

            const key = keyboardnavigation.getKeyName(e);
            if (key === 'Enter') {
                playback.playPause(getPlayer());
            }
        });

        nowPlayingPositionSlider.updateBubbleHtml = function(bubble, value) {
            showOsd();

            const item = getItem();
            const ticks = currentRuntimeTicks * value / 100;

            if (getTrickplayResolution() && item?.Trickplay) {
                return updateTrickplayBubbleHtml(
                    ServerConnections.getApiClient(item.ServerId),
                    getTrickplayResolution(),
                    item,
                    getPlayer().streamInfo.mediaSource.Id,
                    bubble,
                    ticks);
            }

            return false;
        };

        nowPlayingPositionSlider.getBubbleHtml = function (value) {
            showOsd();
            if (enableProgressByTimeOfDay) {
                if (programStartDateMs && programEndDateMs) {
                    let ms = programEndDateMs - programStartDateMs;
                    ms /= 100;
                    ms *= value;
                    ms += programStartDateMs;
                    return '<h1 class="sliderBubbleText">' + getDisplayTimeWithoutAmPm(new Date(parseInt(ms, 10)), true) + '</h1>'; // allow-direct-time: builds a Date from a computed program timestamp, not a clock read
                }

                return '--:--';
            }

            if (!currentRuntimeTicks) {
                return '--:--';
            }

            let ticks = currentRuntimeTicks;
            ticks /= 100;
            ticks *= value;
            const item = getItem();

            if (item?.Chapters?.length && item.Chapters[0].ImageTag) {
                const html = getChapterBubbleHtml(ServerConnections.getApiClient(item.ServerId), item, item.Chapters, ticks);

                if (html) {
                    return html;
                }
            }

            return '<h1 class="sliderBubbleText">' + datetime.getDisplayRunningTime(ticks) + '</h1>';
        };

        nowPlayingPositionSlider.getMarkerInfo = function () {
            // use markers based on chapters
            const item = getItem();
            return item?.Chapters?.map(currentChapter => ({
                name: currentChapter.Name,
                progress: currentChapter.StartPositionTicks / item.RunTimeTicks
            })) || [];
        };
    }

    return { updateTimeDisplay, setProgressByTimeOfDay, setProgramTimes, setPlaybackStartTimeTicks, setRuntimeTicks, bind };
}
