// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import { enableLocalPlaylistManagement } from './playerRegistry';
import { includesAny } from '../../utils/container.ts';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';

/**
 * Owns audio and subtitle track selection on the playing item: choosing and
 * cycling the active audio, subtitle and secondary-subtitle streams, and
 * deciding whether a subtitle change can be handled client side or needs a
 * re-request of the transcoded stream.
 *
 * Uses from the shared context:
 * - `context.manager`: the PlaybackManager instance (public API,
 *   `_currentPlayer`), for the calls this module makes back onto the
 *   manager for members owned by other modules or the facade.
 * - `context.state.getPlayerData` / `context.state.getCurrentTicks`: this
 *   player's cached playback state.
 * - `context.streams.changeStream`: re-requests the active stream from the
 *   server when a track change cannot be handled client side.
 *
 * The PlaybackManager facade (playbackmanager.js) creates this module via
 * `createPlaybackTrackSelection(context)` and stores it as `context.tracks`.
 *
 * @param {object} context The shared PlaybackContext built by
 *   playbackmanager.js.
 * @returns {object} playerHasSecondarySubtitleSupport,
 *   trackHasSecondarySubtitleSupport, secondarySubtitleTracks,
 *   getSubtitleStream, changeAudioStream, changeSubtitleStream,
 *   getAudioStreamIndex, setAudioStreamIndex, getSubtitleStreamIndex,
 *   getSecondarySubtitleStreamIndex, setSubtitleStreamIndex,
 *   setSecondarySubtitleStreamIndex, isSubtitleStreamExternal,
 *   getPreviousSource.
 */
export function createPlaybackTrackSelection(context) {
    const { manager } = context;

    const playerHasSecondarySubtitleSupport = function (player = manager._currentPlayer) {
        if (!player) return false;
        return Boolean(player.supports('SecondarySubtitles'));
    };

    /**
     * Checks if:
     * - the track can be used directly as a secondary subtitle
     * - or if it can be paired with a secondary subtitle when used as a primary subtitle
     */
    const trackHasSecondarySubtitleSupport = function (track, player = manager._currentPlayer) {
        if (!player || !track) return false;
        const format = (track.Codec || '').toLowerCase();
        // Text-based ASS/SSA tracks have independent renderer instances,
        // so they can now be primary or secondary without tearing each
        // other down. Bitmap PGS remains a primary-only renderer.
        return format !== 'pgssub' && getDeliveryMethod(track) === 'External';
    };

    const secondarySubtitleTracks = function (player = manager._currentPlayer) {
        const streams = manager.subtitleTracks(player);
        return streams.filter((stream) => manager.trackHasSecondarySubtitleSupport(stream, player));
    };

    function getCurrentSubtitleStream(player, isSecondaryStream = false) {
        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        const index = isSecondaryStream ? context.state.getPlayerData(player).secondarySubtitleStreamIndex : context.state.getPlayerData(player).subtitleStreamIndex;

        if (index == null || index === -1) {
            return null;
        }

        return manager.getSubtitleStream(player, index);
    }

    const getSubtitleStream = function (player, index) {
        return manager.subtitleTracks(player).filter(function (s) {
            return s.Type === 'Subtitle' && s.Index === index;
        })[0];
    };

    const changeAudioStream = function (player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.changeAudioStream();
        }

        if (!player) {
            return;
        }

        const currentMediaSource = manager.currentMediaSource(player);
        const mediaStreams = [];
        for (let i = 0, length = currentMediaSource.MediaStreams.length; i < length; i++) {
            if (currentMediaSource.MediaStreams[i].Type === 'Audio') {
                mediaStreams.push(currentMediaSource.MediaStreams[i]);
            }
        }

        // Nothing to change
        if (mediaStreams.length <= 1) {
            return;
        }

        const currentStreamIndex = manager.getAudioStreamIndex(player);
        let indexInList = -1;
        for (let i = 0, length = mediaStreams.length; i < length; i++) {
            if (mediaStreams[i].Index === currentStreamIndex) {
                indexInList = i;
                break;
            }
        }

        let nextIndex = indexInList + 1;
        if (nextIndex >= mediaStreams.length) {
            nextIndex = 0;
        }

        nextIndex = nextIndex === -1 ? -1 : mediaStreams[nextIndex].Index;

        manager.setAudioStreamIndex(nextIndex, player);
    };

    const changeSubtitleStream = function (player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.changeSubtitleStream();
        }

        if (!player) {
            return;
        }

        const currentMediaSource = manager.currentMediaSource(player);
        const mediaStreams = [];
        for (let i = 0, length = currentMediaSource.MediaStreams.length; i < length; i++) {
            if (currentMediaSource.MediaStreams[i].Type === 'Subtitle') {
                mediaStreams.push(currentMediaSource.MediaStreams[i]);
            }
        }

        // No known streams, nothing to change
        if (!mediaStreams.length) {
            return;
        }

        const currentStreamIndex = manager.getSubtitleStreamIndex(player);
        let indexInList = -1;
        for (let i = 0, length = mediaStreams.length; i < length; i++) {
            if (mediaStreams[i].Index === currentStreamIndex) {
                indexInList = i;
                break;
            }
        }

        let nextIndex = indexInList + 1;
        if (nextIndex >= mediaStreams.length) {
            nextIndex = -1;
        }

        nextIndex = nextIndex === -1 ? -1 : mediaStreams[nextIndex].Index;

        manager.setSubtitleStreamIndex(nextIndex, player);
    };

    const getAudioStreamIndex = function (player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.getAudioStreamIndex();
        }

        return context.state.getPlayerData(player).audioStreamIndex;
    };

    function isAudioStreamSupported(mediaSource, index, deviceProfile) {
        let mediaStream;
        const mediaStreams = mediaSource.MediaStreams;

        for (let i = 0, length = mediaStreams.length; i < length; i++) {
            if (mediaStreams[i].Type === 'Audio' && mediaStreams[i].Index === index) {
                mediaStream = mediaStreams[i];
                break;
            }
        }

        if (!mediaStream) {
            return false;
        }

        const container = mediaSource.Container.toLowerCase();
        const codec = (mediaStream.Codec || '').toLowerCase();

        if (!codec) {
            return false;
        }

        const profiles = deviceProfile.DirectPlayProfiles || [];

        return profiles.some(function (p) {
            return p.Type === 'Video'
                && includesAny((p.Container || '').toLowerCase(), container)
                && includesAny((p.AudioCodec || '').toLowerCase(), codec);
        });
    }

    const setAudioStreamIndex = function (index, player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.setAudioStreamIndex(index);
        }

        if (manager.playMethod(player) === 'Transcode' || !player.canSetAudioStreamIndex()) {
            context.streams.changeStream(player, context.state.getCurrentTicks(player), { AudioStreamIndex: index });
            context.state.getPlayerData(player).audioStreamIndex = index;
        } else {
            // See if the player supports the track without transcoding
            player.getDeviceProfile(manager.currentItem(player)).then(function (profile) {
                if (isAudioStreamSupported(manager.currentMediaSource(player), index, profile)) {
                    player.setAudioStreamIndex(index);
                    context.state.getPlayerData(player).audioStreamIndex = index;
                } else {
                    context.streams.changeStream(player, context.state.getCurrentTicks(player), { AudioStreamIndex: index });
                    context.state.getPlayerData(player).audioStreamIndex = index;
                }
            });
        }
    };

    const getSubtitleStreamIndex = function (player) {
        player = player || manager._currentPlayer;

        if (player && !enableLocalPlaylistManagement(player)) {
            return player.getSubtitleStreamIndex();
        }

        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        return context.state.getPlayerData(player).subtitleStreamIndex;
    };

    const getSecondarySubtitleStreamIndex = function (player) {
        player = player || manager._currentPlayer;

        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingPlayer, 'player cannot be null');
        }

        try {
            if (!enableLocalPlaylistManagement(player)) {
                return player.getSecondarySubtitleStreamIndex();
            }
        } catch (e) {
            console.error('[playbackmanager] Failed to get secondary stream index:', e);
        }

        return context.state.getPlayerData(player).secondarySubtitleStreamIndex;
    };

    function getDeliveryMethod(subtitleStream) {
        // This will be null for internal subs for local items
        if (subtitleStream.DeliveryMethod) {
            return subtitleStream.DeliveryMethod;
        }

        return subtitleStream.IsExternal ? 'External' : 'Embed';
    }

    const setSubtitleStreamIndex = function (index, player) {
        player = player || manager._currentPlayer;
        if (player && !enableLocalPlaylistManagement(player)) {
            return player.setSubtitleStreamIndex(index);
        }

        const currentStream = getCurrentSubtitleStream(player);

        const newStream = manager.getSubtitleStream(player, index);

        if (!currentStream && !newStream) {
            return;
        }

        let selectedTrackElementIndex = -1;

        const currentPlayMethod = manager.playMethod(player);

        if (currentStream && !newStream) {
            if (getDeliveryMethod(currentStream) === 'Encode' || (getDeliveryMethod(currentStream) === 'Embed' && currentPlayMethod === 'Transcode')) {
                // Need to change the transcoded stream to remove subs
                context.streams.changeStream(player, context.state.getCurrentTicks(player), { SubtitleStreamIndex: -1 });
            }
        } else if (!currentStream && newStream) {
            if (getDeliveryMethod(newStream) === 'External') {
                selectedTrackElementIndex = index;
            } else if (getDeliveryMethod(newStream) === 'Embed' && currentPlayMethod !== 'Transcode') {
                selectedTrackElementIndex = index;
            } else {
                // Need to change the transcoded stream to add subs
                context.streams.changeStream(player, context.state.getCurrentTicks(player), { SubtitleStreamIndex: index });
            }
        } else if (currentStream && newStream) {
            // Switching tracks
            // We can handle this clientside if the new track is external or the new track is embedded and we're not transcoding
            if (getDeliveryMethod(newStream) === 'External' || (getDeliveryMethod(newStream) === 'Embed' && currentPlayMethod !== 'Transcode')) {
                selectedTrackElementIndex = index;

                // But in order to handle this client side, if the previous track is being added via transcoding, we'll have to remove it
                if (getDeliveryMethod(currentStream) !== 'External' && getDeliveryMethod(currentStream) !== 'Embed') {
                    context.streams.changeStream(player, context.state.getCurrentTicks(player), { SubtitleStreamIndex: -1 });
                }
            } else {
                // Need to change the transcoded stream to add subs
                context.streams.changeStream(player, context.state.getCurrentTicks(player), { SubtitleStreamIndex: index });
            }
        }

        player.setSubtitleStreamIndex(selectedTrackElementIndex);

        // Also disable secondary subtitles when disabling the primary
        // subtitles, or if it doesn't support a secondary pair
        if (selectedTrackElementIndex === -1 || !manager.trackHasSecondarySubtitleSupport(newStream)) {
            manager.setSecondarySubtitleStreamIndex(-1);
        }

        context.state.getPlayerData(player).subtitleStreamIndex = index;
    };

    const setSecondarySubtitleStreamIndex = function (index, player) {
        player = player || manager._currentPlayer;
        if (!manager.playerHasSecondarySubtitleSupport(player)) return;
        if (player && !enableLocalPlaylistManagement(player)) {
            try {
                return player.setSecondarySubtitleStreamIndex(index);
            } catch (e) {
                console.error('[playbackmanager] AutoSet - Failed to set secondary track:', e);
            }
        }

        const currentStream = getCurrentSubtitleStream(player, true);

        const newStream = manager.getSubtitleStream(player, index);

        if (!currentStream && !newStream) {
            return;
        }

        // Secondary subtitles are currently only handled client side
        // Changes to the server code are required before we can handle other delivery methods
        if (newStream && !manager.trackHasSecondarySubtitleSupport(newStream, player)) {
            return;
        }

        try {
            player.setSecondarySubtitleStreamIndex(index);
            context.state.getPlayerData(player).secondarySubtitleStreamIndex = index;
        } catch (e) {
            console.error('[playbackmanager] AutoSet - Failed to set secondary track:', e);
        }
    };

    const isSubtitleStreamExternal = function (index, player) {
        const stream = manager.getSubtitleStream(player, index);
        return stream ? getDeliveryMethod(stream) === 'External' : false;
    };

    function getPreviousSource(player) {
        const prevSource = manager.currentMediaSource(player);
        const prevPlayerData = context.state.getPlayerData(player);
        return {
            ...prevSource,
            DefaultAudioStreamIndex: prevPlayerData.audioStreamIndex,
            DefaultSubtitleStreamIndex: prevPlayerData.subtitleStreamIndex,
            DefaultSecondarySubtitleStreamIndex: prevPlayerData.secondarySubtitleStreamIndex
        };
    }

    return {
        playerHasSecondarySubtitleSupport,
        trackHasSecondarySubtitleSupport,
        secondarySubtitleTracks,
        getSubtitleStream,
        changeAudioStream,
        changeSubtitleStream,
        getAudioStreamIndex,
        setAudioStreamIndex,
        getSubtitleStreamIndex,
        getSecondarySubtitleStreamIndex,
        setSubtitleStreamIndex,
        setSecondarySubtitleStreamIndex,
        isSubtitleStreamExternal,
        getPreviousSource
    };
}
