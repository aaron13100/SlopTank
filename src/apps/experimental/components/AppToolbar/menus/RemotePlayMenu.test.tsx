import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { PlayTarget } from 'types/playTarget';

import RemotePlayMenu from './RemotePlayMenu';

/**
 * Renders the real menu component with its data supplied through props, so no
 * playback or plugin singleton is involved.
 */
const noop = () => undefined;

const renderMenu = (isCastPluginLoaded: boolean, targets: PlayTarget[]) => {
    const fetchTargets = () => Promise.resolve(targets);

    return render(
        <RemotePlayMenu
            open
            anchorEl={null}
            onMenuClose={noop}
            isCastPluginLoaded={isCastPluginLoaded}
            // Each test needs its own target list, so a per-render function is
            // intended here; re-render churn is irrelevant in a test.
            // eslint-disable-next-line react/jsx-no-bind
            fetchTargets={fetchTargets}
            onSelectTarget={noop}
        />
    );
};

const castTarget = {
    id: 'tv-1',
    name: 'Living Room TV',
    playerName: 'Chromecast'
} as PlayTarget;

describe('RemotePlayMenu', () => {
    // Vitest is not running with globals, so RTL's automatic cleanup hook is
    // never registered and rendered menus would otherwise accumulate in the
    // document across tests.
    afterEach(cleanup);

    // @covers remote_play_menu.plugin_unloaded.warns_unsupported
    it('warns that cast is unsupported when the plugin never loaded', async () => {
        renderMenu(false, []);

        expect(await screen.findByText(/GoogleCastUnsupported|Google Cast Unsupported/)).toBeDefined();
    });

    // @covers remote_play_menu.discovery_empty.tells_user_no_devices
    it('tells the user no devices were found when discovery returns nothing', async () => {
        // Regression guard: this case previously rendered a menu containing no
        // items whatsoever, which the user saw as an empty grey square.
        renderMenu(true, []);

        expect(
            await screen.findByText(/NoCastDevicesFound|No cast devices found/)
        ).toBeDefined();
    });

    // @covers remote_play_menu.discovery_in_progress.no_premature_empty_menu
    it('never renders an item-less menu once discovery has completed', async () => {
        const { baseElement } = renderMenu(true, []);

        await waitFor(() => {
            expect(baseElement.querySelectorAll('li').length).toBeGreaterThan(0);
        });
    });

    // @covers remote_play_menu.discovery.lists_available_targets
    it('lists the available play targets', async () => {
        renderMenu(true, [ castTarget ]);

        expect(await screen.findByText('Living Room TV')).toBeDefined();
        expect(screen.queryByText(/NoCastDevicesFound|No cast devices found/)).toBeNull();
    });
});
