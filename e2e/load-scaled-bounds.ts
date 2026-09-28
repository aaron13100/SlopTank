// SlopTank modification notice: added or changed by SlopTank on 2026-09-28.

// Hang bounds in e2e specs are scaled by measured load because this host has
// no quiet period: the live Jellyfin server, nightly encodes and queue work
// share its cores, so a fixed wall-clock bound reports contention as breakage.
// A bound passed through loadScaledMs is a hang bound and may stretch with the
// machine. Product latency budgets are never scaled -- they measure the
// product against a stated budget, and stretching them would hide the very
// regression they exist to catch.

import os from 'node:os';

/**
 * Scale a quiet-host wall-clock bound by measured machine contention.
 *
 * This suite runs on the live 2-core host next to Jellyfin, nightly encodes
 * and queue work, where a 1-minute load average far above the core count is
 * the normal operating condition, not an anomaly to wait out. A fixed 30s
 * test timeout failed every spec in its login beforeEach at load ~70
 * (2026-09-24). Same formula as the queue runner's
 * qr_resolve_load_scaled_deadline and tests/test_encode_entry_point.py
 * _load_scaled_timeout: base x clamp(load1 / ncpu, 1x, scaleMax).
 * @param baseMs The bound that holds on an idle host.
 * @param scaleMax Upper limit on the multiplier.
 * @returns The scaled bound in milliseconds (the base where load is not reported, e.g. Windows).
 */
export function loadScaledMs(baseMs: number, scaleMax = 20): number {
    const [ load1 ] = os.loadavg();
    const perCore = load1 / (os.cpus().length || 1);
    return Math.round(baseMs * Math.max(1, Math.min(perCore, scaleMax)));
}
