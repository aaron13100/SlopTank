// SlopTank modification notice: added by SlopTank on 2026-10-01.
/**
 * Skip-button suppression vs. the media source actually playing (c296).
 *
 * Media segments belong to the media source being played, and an alternate
 * version of a multi-version item can have a different duration than the
 * primary item's RunTimeTicks. The "segment ends at the end of the media,
 * so the up-next dialog will cover it" check must therefore compare against
 * the playing source's duration (playbackManager.duration), the same value
 * the up-next dialog uses, and only fall back to the item runtime when that
 * is unknown.
 *
 * Driven through the real playbackManager singleton, which binds the real
 * SkipSegment subscriber in its constructor: a player object implementing
 * the player-plugin contract (currentItem / currentMediaSource / duration)
 * is made current, the real play queue holds a real next item, and the real
 * PromptSkip player event is triggered. Nothing is mocked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, vi, it } from 'vitest';

import Events from 'utils/events';
import * as userSettings from 'scripts/settings/userSettings';
import { playbackManager } from './playbackmanager';

const TICKS_PER_S = 10000000;
const PRIMARY_RUNTIME = 2700 * TICKS_PER_S;

interface TestPlayerOptions {
    /** RunTimeTicks of the media source being played; undefined = unknown. */
    sourceRuntimeTicks?: number
}

/** Local-playback player-plugin contract: reports its own item and source. */
function createPlayer({ sourceRuntimeTicks }: TestPlayerOptions) {
    const item = { Id: 'primary', Type: 'Episode', MediaType: 'Video', RunTimeTicks: PRIMARY_RUNTIME };
    const mediaSource = { Id: 'playing-source', RunTimeTicks: sourceRuntimeTicks };
    return {
        id: 'test-player',
        isLocalPlayer: true,
        currentItem: () => item,
        currentMediaSource: () => mediaSource,
        duration: () => 0
    };
}

type TestPlayer = ReturnType<typeof createPlayer>;

function makeCurrent(player: TestPlayer, withNextItem: boolean) {
    const manager = playbackManager as unknown as {
        _currentPlayer: TestPlayer | null
        _playQueueManager: {
            setPlaylist(items: unknown[]): void
            setPlaylistIndex(index: number): void
            reset(): void
        }
    };
    manager._currentPlayer = player;
    const queue = [{ Id: 'primary', Type: 'Episode' }];
    if (withNextItem) queue.push({ Id: 'next', Type: 'Episode' });
    manager._playQueueManager.setPlaylist(queue);
    manager._playQueueManager.setPlaylistIndex(0);
    // Real playerchange event: SkipSegment rebinds its player events.
    Events.trigger(playbackManager, 'playerchange', [player, {}, null]);
}

function promptSkip(player: TestPlayer, endTicks: number) {
    Events.trigger(player, 'promptskip', [{ Type: 'Outro', StartTicks: endTicks - 60 * TICKS_PER_S, EndTicks: endTicks }]);
}

/** The skip button counts as shown once SkipSegment has removed its `hide` class. */
function skipButtonShown() {
    const button = document.body.querySelector('.skip-button');
    return button !== null && !button.classList.contains('hide');
}

/** Returns SkipSegment to its idle state between prompts (no segment, button hidden). */
function resetSkipSegment() {
    Events.trigger(playbackManager, 'playbackstop', [{}]);
    document.body.querySelector('.skip-button')?.classList.add('hide');
}

describe('SkipSegment onPromptSkip suppression', () => {
    beforeAll(async () => {
        // playbackManager's constructor starts dynamic imports (server
        // notifications); let them settle before jsdom can be torn down.
        await vi.dynamicImportSettled();
    });

    beforeEach(() => {
        userSettings.enableNextVideoInfoOverlay(true);
        resetSkipSegment();
    });

    afterEach(() => {
        const manager = playbackManager as unknown as { _currentPlayer: unknown, _playQueueManager: { reset(): void } };
        resetSkipSegment();
        manager._currentPlayer = null;
        manager._playQueueManager.reset();
        Events.trigger(playbackManager, 'playerchange', [null, {}, null]);
    });

    it('suppresses the button when the playing (shorter) source ends with the segment', () => {
        const sourceEnd = 2684.32 * TICKS_PER_S;
        expect(sourceEnd).toBeLessThan(PRIMARY_RUNTIME);
        const player = createPlayer({ sourceRuntimeTicks: sourceEnd });
        makeCurrent(player, true);
        promptSkip(player, sourceEnd);
        expect(skipButtonShown()).toBe(false);
    });

    it('shows the button when the playing (longer) source continues past the segment end', () => {
        const segmentEnd = 2750 * TICKS_PER_S;
        expect(segmentEnd).toBeGreaterThanOrEqual(PRIMARY_RUNTIME);
        const player = createPlayer({ sourceRuntimeTicks: 2800 * TICKS_PER_S });
        makeCurrent(player, true);
        promptSkip(player, segmentEnd);
        expect(skipButtonShown()).toBe(true);
    });

    it('single-source item: suppresses at the item end, shows before it', () => {
        const player = createPlayer({ sourceRuntimeTicks: PRIMARY_RUNTIME });
        makeCurrent(player, true);
        promptSkip(player, PRIMARY_RUNTIME - 120 * TICKS_PER_S);
        expect(skipButtonShown()).toBe(true);
        resetSkipSegment();
        makeCurrent(player, true);
        promptSkip(player, PRIMARY_RUNTIME);
        expect(skipButtonShown()).toBe(false);
    });

    it('falls back to the item runtime when the source duration is unknown', () => {
        const player = createPlayer({});
        makeCurrent(player, true);
        promptSkip(player, PRIMARY_RUNTIME);
        expect(skipButtonShown()).toBe(false);
    });

    it('shows the button at the end of the media when there is no next item', () => {
        const player = createPlayer({ sourceRuntimeTicks: PRIMARY_RUNTIME });
        makeCurrent(player, false);
        promptSkip(player, PRIMARY_RUNTIME);
        expect(skipButtonShown()).toBe(true);
    });
});
