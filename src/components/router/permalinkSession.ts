const aliases = new Map<string, string>();

function key(serverId: string | null | undefined, itemId: string): string {
    return `${serverId ?? ''}:${itemId}`;
}

/** Remembers only aliases returned or redeemed by the server in this session. */
export function rememberPermalinkAlias(serverId: string | null | undefined, itemId: string, alias: string) {
    aliases.set(key(serverId, itemId), alias);
}

export function getRememberedPermalinkAlias(serverId: string | null | undefined, itemId: string): string | undefined {
    return aliases.get(key(serverId, itemId));
}

export function clearRememberedPermalinkAliases() {
    aliases.clear();
}
