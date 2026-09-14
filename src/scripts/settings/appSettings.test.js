// SlopTank modification notice: added or changed by SlopTank on 2026-09-14.
//
// The in-network Video streaming-bitrate cap is a direct-play guarantee.
//
// Every client of this server is a browser on the LAN, the library is
// pre-encoded for universal direct play, and the server cannot transcode in
// real time on 2 cores. A fresh user has no saved cap; if the fallback for
// that case is the generic 1.5 Mbps default, the first play requests a
// transcode this box cannot perform. The unset in-network Video default must
// therefore be a huge number (the same one the Audio path has always used),
// while an explicit user choice is still honored, and the remote path keeps
// the generic default.
import { beforeEach, describe, expect, it } from 'vitest';

import appSettings from './appSettings';

describe('maxStreamingBitrate defaults by network origin', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('unset in-network Video defaults to a huge direct-play cap', () => {
        expect(appSettings.maxStreamingBitrate(true, 'Video')).toBe(150000000);
    });

    it('an explicitly saved in-network Video cap is honored', () => {
        appSettings.maxStreamingBitrate(true, 'Video', 4000000);
        expect(appSettings.maxStreamingBitrate(true, 'Video')).toBe(4000000);
    });

    it('in-network Audio keeps its always-direct-play cap', () => {
        expect(appSettings.maxStreamingBitrate(true, 'Audio')).toBe(150000000);
    });

    it('remote Video keeps the generic 1.5 Mbps default when unset', () => {
        expect(appSettings.maxStreamingBitrate(false, 'Video')).toBe(1500000);
    });

    it('a saved remote Video cap is honored', () => {
        appSettings.maxStreamingBitrate(false, 'Video', 8000000);
        expect(appSettings.maxStreamingBitrate(false, 'Video')).toBe(8000000);
    });
});

describe('enableAutomaticBitrateDetection by network origin', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('in-network Video never runs detection, even when previously enabled', () => {
        appSettings.enableAutomaticBitrateDetection(true, 'Video', true);
        expect(appSettings.enableAutomaticBitrateDetection(true, 'Video')).toBe(false);
    });

    it('in-network Audio keeps detection forced on', () => {
        appSettings.enableAutomaticBitrateDetection(true, 'Audio', false);
        expect(appSettings.enableAutomaticBitrateDetection(true, 'Audio')).toBe(true);
    });

    it('remote Video keeps the upstream default (detection on)', () => {
        expect(appSettings.enableAutomaticBitrateDetection(false, 'Video')).toBe(true);
    });

    it('remote Video respects an explicit opt-out', () => {
        appSettings.enableAutomaticBitrateDetection(false, 'Video', false);
        expect(appSettings.enableAutomaticBitrateDetection(false, 'Video')).toBe(false);
    });
});
