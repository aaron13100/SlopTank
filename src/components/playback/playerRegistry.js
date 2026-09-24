// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
/**
 * Owns which media players exist, which one is the active player, remote
 * targets (the list of pairable player targets exposed to the UI) and
 * pairing (claiming a remote player as active).
 *
 * Uses `context.manager` (the PlaybackManager instance, for `_currentPlayer`,
 * `getSupportedCommands`, `getPlayers`, `endPlayerUpdates`/`beginPlayerUpdates`
 * and the other public members other modules assign onto it) and
 * `context.session.getDefaultPlayOptions()`.
 *
 * Created by the PlaybackManager facade (playbackmanager.js), which builds
 * the shared context object and passes it to every collaborator factory.
 */

import datetime from '../../scripts/datetime';
import Events from '../../utils/events.ts';
import { currentTimeMs } from 'utils/clock';

import { isServerItem } from './playbackMediaSource';
import { PlaybackManagerError, PlaybackManagerErrorCode } from './playbackManagerError';

/**
 * A player has no `getPlaylist` method (or is not a local player at all):
 * playback then manages its own playlist locally rather than delegating to
 * the player.
 * @param {object} player The player to check.
 * @returns {boolean} Whether local playlist management applies to this player.
 */
export function enableLocalPlaylistManagement(player) {
    if (player.getPlaylist) {
        return false;
    }

    return player.isLocalPlayer;
}

/**
 * Creates the player registry module.
 * @param {object} context The shared PlaybackContext built by
 *   playbackmanager.js.
 * @returns {object} getPlayerInfo, setActivePlayer, trySetActivePlayer,
 *   getTargets, getPlayers, canPlay (public members); setCurrentPlayerInternal,
 *   removeCurrentPlayer, getPlayer, registerPlayer (internal members used by
 *   sibling modules through context.registry).
 */
export function createPlayerRegistry(context) {
    const { manager } = context;

    const players = [];
    let currentTargetInfo;
    let currentPairingId = null;

    function triggerPlayerChange(newPlayer, newTarget, previousPlayer, previousTargetInfo) {
        if (!newPlayer && !previousPlayer) {
            return;
        }

        if (newTarget && previousTargetInfo && newTarget.id === previousTargetInfo.id) {
            return;
        }

        Events.trigger(manager, 'playerchange', [newPlayer, newTarget, previousPlayer]);
    }

    function isAutomaticPlayer(player) {
        return player.isLocalPlayer;
    }

    function getAutomaticPlayers(forceLocalPlayer) {
        if (!forceLocalPlayer) {
            const player = manager._currentPlayer;
            if (player && !isAutomaticPlayer(player)) {
                return [player];
            }
        }

        return manager.getPlayers().filter(isAutomaticPlayer);
    }

    function displayPlayerIndividually(player) {
        return !player.isLocalPlayer;
    }

    function createTarget(player) {
        return {
            name: player.name,
            id: player.id,
            playerName: player.name,
            playableMediaTypes: ['Audio', 'Video', 'Photo', 'Book'].map(player.canPlayMediaType),
            isLocalPlayer: player.isLocalPlayer,
            supportedCommands: manager.getSupportedCommands(player)
        };
    }

    function getPlayerTargets(player) {
        if (player.getTargets) {
            return player.getTargets();
        }

        return Promise.resolve([createTarget(player)]);
    }

    function sortPlayerTargets(a, b) {
        let aVal = a.isLocalPlayer ? 0 : 1;
        let bVal = b.isLocalPlayer ? 0 : 1;

        aVal = aVal.toString() + a.name;
        bVal = bVal.toString() + b.name;

        return aVal.localeCompare(bVal);
    }

    const getPlayerInfo = function () {
        const player = manager._currentPlayer;

        if (!player) {
            return null;
        }

        const target = currentTargetInfo || {};

        return {
            name: player.name,
            isLocalPlayer: player.isLocalPlayer,
            id: target.id,
            deviceName: target.deviceName,
            playableMediaTypes: target.playableMediaTypes,
            supportedCommands: target.supportedCommands
        };
    };

    const setActivePlayer = function (player, targetInfo) {
        if (player === 'localplayer' || player.name === 'localplayer') {
            if (manager._currentPlayer?.isLocalPlayer) {
                return;
            }
            setCurrentPlayerInternal(null, null);
            return;
        }

        if (typeof (player) === 'string') {
            player = players.filter(function (p) {
                return p.name === player;
            })[0];
        }

        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.PlayerNotFound, 'null player');
        }

        setCurrentPlayerInternal(player, targetInfo);
    };

    const trySetActivePlayer = function (player, targetInfo) {
        if (player === 'localplayer' || player.name === 'localplayer') {
            if (manager._currentPlayer?.isLocalPlayer) {
                return;
            }
            return;
        }

        if (typeof (player) === 'string') {
            player = players.filter(function (p) {
                return p.name === player;
            })[0];
        }

        if (!player) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.PlayerNotFound, 'null player');
        }

        if (currentPairingId === targetInfo.id) {
            return;
        }

        currentPairingId = targetInfo.id;

        const promise = player.tryPair ?
            player.tryPair(targetInfo) :
            Promise.resolve();

        Events.trigger(manager, 'pairing');

        promise.then(function () {
            Events.trigger(manager, 'paired');
            setCurrentPlayerInternal(player, targetInfo);
        }, function () {
            Events.trigger(manager, 'pairerror');
            if (currentPairingId === targetInfo.id) {
                currentPairingId = null;
            }
        });
    };

    const getTargets = function () {
        const promises = players.filter(displayPlayerIndividually).map(getPlayerTargets);

        return Promise.all(promises)
            .then(responses => responses.flat().sort(sortPlayerTargets));
    };

    function removeCurrentPlayer(player) {
        const previousPlayer = manager._currentPlayer;

        if (!previousPlayer || player.id === previousPlayer.id) {
            setCurrentPlayerInternal(null);
        }
    }

    function setCurrentPlayerInternal(player, targetInfo) {
        const previousPlayer = manager._currentPlayer;
        const previousTargetInfo = currentTargetInfo;

        if (player && !targetInfo && player.isLocalPlayer) {
            targetInfo = createTarget(player);
        }

        if (player && !targetInfo) {
            throw new PlaybackManagerError(PlaybackManagerErrorCode.MissingTargetInfo, 'targetInfo cannot be null');
        }

        currentPairingId = null;
        manager._currentPlayer = player;
        currentTargetInfo = targetInfo;

        if (targetInfo) {
            console.debug('Active player: ' + JSON.stringify(targetInfo));
        }

        if (previousPlayer) {
            manager.endPlayerUpdates(previousPlayer);
        }

        if (player) {
            manager.beginPlayerUpdates(player);
        }

        triggerPlayerChange(player, targetInfo, previousPlayer, previousTargetInfo);
    }

    const getPlayers = function () {
        return players;
    };

    const canPlay = function (item) {
        const itemType = item.Type;

        if (itemType === 'Book' || itemType === 'PhotoAlbum' || itemType === 'MusicGenre' || itemType === 'Season' || itemType === 'Series' || itemType === 'BoxSet' || itemType === 'MusicAlbum' || itemType === 'MusicArtist' || itemType === 'Playlist') {
            return true;
        }

        if (item.LocationType === 'Virtual' && itemType !== 'Program') {
            return false;
        }

        if (itemType === 'Program') {
            if (!item.EndDate || !item.StartDate) {
                return false;
            }

            if (currentTimeMs() > datetime.parseISO8601Date(item.EndDate).getTime() || currentTimeMs() < datetime.parseISO8601Date(item.StartDate).getTime()) {
                return false;
            }
        }

        return getPlayer(item, context.session.getDefaultPlayOptions()) != null;
    };

    function getPlayer(item, playOptions, forceLocalPlayers) {
        const serverItem = isServerItem(item);
        return getAutomaticPlayers(forceLocalPlayers).filter(function (p) {
            if (p.canPlayMediaType(item.MediaType)) {
                if (serverItem) {
                    if (p.canPlayItem) {
                        return p.canPlayItem(item, playOptions);
                    }
                    return true;
                } else if (item.Url && p.canPlayUrl) {
                    return p.canPlayUrl(item.Url);
                }
            }

            return false;
        })[0];
    }

    function registerPlayer(player) {
        players.push(player);
        players.sort(function (a, b) {
            return (a.priority || 0) - (b.priority || 0);
        });
    }

    return {
        getPlayerInfo,
        setActivePlayer,
        trySetActivePlayer,
        getTargets,
        getPlayers,
        canPlay,
        setCurrentPlayerInternal,
        removeCurrentPlayer,
        getPlayer,
        registerPlayer
    };
}
