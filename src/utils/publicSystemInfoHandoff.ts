// SlopTank modification notice: added or changed by SlopTank on 2026-09-08, 2026-09-09.
import type { PublicSystemInfo } from '@jellyfin/sdk/lib/generated-client';

const HANDOFF_TTL_MS = 60_000;

type PendingPublicInfo = {
    expiresAt: number
    info: PublicSystemInfo
};

const pendingInfo = new Map<string, PendingPublicInfo>();

const normalizeAddress = (address: string) => address.trim().replace(/\/+$/, '');

/** Keep discovery data only until the connection attempt consumes it. */
export const rememberPublicSystemInfo = (
    address: string,
    info: PublicSystemInfo,
    now = Date.now()
) => {
    pendingInfo.set(normalizeAddress(address), {
        expiresAt: now + HANDOFF_TTL_MS,
        info
    });
};

export const consumePublicSystemInfo = (address: string, now = Date.now()) => {
    const key = normalizeAddress(address);
    const pending = pendingInfo.get(key);
    pendingInfo.delete(key);
    return pending && pending.expiresAt >= now ? pending.info : undefined;
};

export const getPublicSystemInfoForConnection = (
    address: string,
    load: () => Promise<PublicSystemInfo>,
    now = Date.now()
) => {
    const remembered = consumePublicSystemInfo(address, now);
    return remembered ? Promise.resolve(remembered) : load();
};
