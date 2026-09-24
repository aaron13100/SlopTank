// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import Screenfull from 'screenfull';

import { AppFeature } from 'constants/appFeature';

/**
 * Owns presentation and output controls on the currently active (or a given)
 * player: aspect ratio, playback speed, volume, fullscreen, picture-in-
 * picture, AirPlay and subtitle offset.
 *
 * Uses from the shared context:
 * - context.manager as the PlaybackManager instance (`manager._currentPlayer`
 *   is the default player, and its own public members - getPlaybackRate,
 *   setPlaybackRate, getSubtitleStreamIndex, isSubtitleStreamExternal - are
 *   called back through it since those live on other collaborators or the
 *   facade itself).
 * - context.appHost.supports(...) to detect a device with physical volume
 *   buttons, which the player-driven volume controls defer to.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context and stores this factory's return value as
 * context.controls.
 *
 * @param {object} context The shared PlaybackContext built by
 * playbackmanager.js.
 * @returns {object} toggleAspectRatio, setAspectRatio,
 * getSupportedAspectRatios, getAspectRatio, increasePlaybackRate,
 * decreasePlaybackRate, getSupportedPlaybackRates, setVolume, getVolume,
 * volumeUp, volumeDown, isFullscreen, toggleFullscreen,
 * togglePictureInPicture, toggleAirPlay, supportSubtitleOffset,
 * enableShowingSubtitleOffset, disableShowingSubtitleOffset,
 * isShowingSubtitleOffsetEnabled, setSubtitleOffset,
 * getPlayerSubtitleOffset, canHandleOffsetOnCurrentSubtitle.
 */
export function createPlayerControls(context) {
    const { manager } = context;

    function supportsPhysicalVolumeControl(player) {
        return player.isLocalPlayer && context.appHost.supports(AppFeature.PhysicalVolumeControl);
    }

    function toggleAspectRatio(player) {
        player = player || manager._currentPlayer;

        if (player) {
            const current = manager.getAspectRatio(player);

            const supported = manager.getSupportedAspectRatios(player);

            let index = -1;
            for (let i = 0, length = supported.length; i < length; i++) {
                if (supported[i].id === current) {
                    index = i;
                    break;
                }
            }

            index++;
            if (index >= supported.length) {
                index = 0;
            }

            manager.setAspectRatio(supported[index].id, player);
        }
    }

    function setAspectRatio(val, player) {
        player = player || manager._currentPlayer;

        if (player?.setAspectRatio) {
            player.setAspectRatio(val);
        }
    }

    function getSupportedAspectRatios(player) {
        player = player || manager._currentPlayer;

        if (player?.getSupportedAspectRatios) {
            return player.getSupportedAspectRatios();
        }

        return [];
    }

    function getAspectRatio(player) {
        player = player || manager._currentPlayer;

        if (player?.getAspectRatio) {
            return player.getAspectRatio();
        }
    }

    function increasePlaybackRate(player) {
        player = player || manager._currentPlayer;
        if (player) {
            const current = manager.getPlaybackRate(player);
            const supported = manager.getSupportedPlaybackRates(player);

            let index = -1;
            for (let i = 0, length = supported.length; i < length; i++) {
                if (supported[i].id === current) {
                    index = i;
                    break;
                }
            }

            index = Math.min(index + 1, supported.length - 1);
            manager.setPlaybackRate(supported[index].id, player);
        }
    }

    function decreasePlaybackRate(player) {
        player = player || manager._currentPlayer;
        if (player) {
            const current = manager.getPlaybackRate(player);
            const supported = manager.getSupportedPlaybackRates(player);

            let index = -1;
            for (let i = 0, length = supported.length; i < length; i++) {
                if (supported[i].id === current) {
                    index = i;
                    break;
                }
            }

            index = Math.max(index - 1, 0);
            manager.setPlaybackRate(supported[index].id, player);
        }
    }

    function getSupportedPlaybackRates(player) {
        player = player || manager._currentPlayer;
        if (player?.getSupportedPlaybackRates) {
            return player.getSupportedPlaybackRates();
        }
        return [];
    }

    function setVolume(val, player) {
        player = player || manager._currentPlayer;

        if (player && !supportsPhysicalVolumeControl(player)) {
            player.setVolume(val);
        }
    }

    function getVolume(player) {
        player = player || manager._currentPlayer;

        if (player && !supportsPhysicalVolumeControl(player)) {
            return player.getVolume();
        }

        return 1;
    }

    function volumeUp(player) {
        player = player || manager._currentPlayer;

        if (player && !supportsPhysicalVolumeControl(player)) {
            player.volumeUp();
        }
    }

    function volumeDown(player) {
        player = player || manager._currentPlayer;

        if (player && !supportsPhysicalVolumeControl(player)) {
            player.volumeDown();
        }
    }

    function isFullscreen(player) {
        player = player || manager._currentPlayer;
        if (!player.isLocalPlayer || player.isFullscreen) {
            return player.isFullscreen();
        }

        if (!Screenfull.isEnabled) {
            // iOS Safari
            return document.webkitIsFullScreen;
        }

        return Screenfull.isFullscreen;
    }

    function toggleFullscreen(player) {
        player = player || manager._currentPlayer;
        if (!player.isLocalPlayer || player.toggleFullscreen) {
            return player.toggleFullscreen();
        }

        if (Screenfull.isEnabled) {
            Screenfull.toggle();
        } else if (document.webkitIsFullScreen && document.webkitCancelFullscreen) {
            // iOS Safari
            document.webkitCancelFullscreen();
        } else {
            const elem = document.querySelector('video');
            if (elem?.webkitEnterFullscreen) {
                elem.webkitEnterFullscreen();
            }
        }
    }

    function togglePictureInPicture(player) {
        player = player || manager._currentPlayer;
        return player.togglePictureInPicture();
    }

    function toggleAirPlay(player) {
        player = player || manager._currentPlayer;
        return player.toggleAirPlay();
    }

    function supportSubtitleOffset(player) {
        player = player || manager._currentPlayer;
        return player && 'setSubtitleOffset' in player;
    }

    function enableShowingSubtitleOffset(player) {
        player = player || manager._currentPlayer;
        player.enableShowingSubtitleOffset();
    }

    function disableShowingSubtitleOffset(player) {
        player = player || manager._currentPlayer;
        if (player.disableShowingSubtitleOffset) {
            player.disableShowingSubtitleOffset();
        }
    }

    function isShowingSubtitleOffsetEnabled(player) {
        player = player || manager._currentPlayer;
        return player.isShowingSubtitleOffsetEnabled();
    }

    function setSubtitleOffset(value, player) {
        player = player || manager._currentPlayer;
        if (player.setSubtitleOffset) {
            player.setSubtitleOffset(value);
        }
    }

    function getPlayerSubtitleOffset(player) {
        player = player || manager._currentPlayer;
        if (player.getSubtitleOffset) {
            return player.getSubtitleOffset();
        }
    }

    function canHandleOffsetOnCurrentSubtitle(player) {
        player = player || manager._currentPlayer;
        // The player knows what its installed rendering path can actually
        // shift (embedded direct-play tracks are client-rendered and
        // offsetable); the external-only stream-metadata heuristic stays
        // as the fallback for players without the capability query.
        if (player && typeof player.canHandleSubtitleOffset === 'function') {
            return player.canHandleSubtitleOffset();
        }

        const index = manager.getSubtitleStreamIndex(player);
        return index !== -1 && manager.isSubtitleStreamExternal(index, player);
    }

    return {
        toggleAspectRatio,
        setAspectRatio,
        getSupportedAspectRatios,
        getAspectRatio,
        increasePlaybackRate,
        decreasePlaybackRate,
        getSupportedPlaybackRates,
        setVolume,
        getVolume,
        volumeUp,
        volumeDown,
        isFullscreen,
        toggleFullscreen,
        togglePictureInPicture,
        toggleAirPlay,
        supportSubtitleOffset,
        enableShowingSubtitleOffset,
        disableShowingSubtitleOffset,
        isShowingSubtitleOffsetEnabled,
        setSubtitleOffset,
        getPlayerSubtitleOffset,
        canHandleOffsetOnCurrentSubtitle
    };
}
