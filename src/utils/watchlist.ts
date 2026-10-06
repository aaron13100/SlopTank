// SlopTank modification notice: added or changed by SlopTank on 2026-10-06.
/**
 * Client access to the per-user watchlist ("My List") API (c188).
 *
 * The endpoints are SlopTank additions, so they are not part of the generated
 * SDK: every call goes through the app's own ApiClient, exactly like the
 * per-user resume actions. All functions take the ApiClient explicitly, so a
 * second session in tests or multi-server setups can never touch another
 * server's list.
 */

import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

export interface WatchlistQuery {
    /** Zero-based index of the first entry to return. */
    startIndex?: number;
    /** Maximum number of entries to return. */
    limit?: number;
    /** Order of the addition timestamp; the server defaults to newest first. */
    sortOrder?: 'Ascending' | 'Descending';
}

export interface WatchlistResult {
    Items: BaseItemDto[];
    TotalRecordCount: number;
    StartIndex: number;
}

interface WatchlistContainsResponse {
    ItemId: string;
    IsInWatchlist: boolean;
}

/**
 * The slice of the app's ApiClient the watchlist module needs. The real
 * ApiClient satisfies this structurally, and tests substitute a real
 * in-memory client at this seam.
 */
export interface WatchlistApiClient {
    /** Builds an absolute API URL from a relative path. */
    getUrl(path: string, query?: Record<string, unknown>): string;
    /** Performs a non-JSON request. */
    ajax(options: { type: string; url: string }): Promise<unknown>;
    /** Performs a JSON GET. */
    getJSON(url: string): Promise<unknown>;
}

/**
 * The contains endpoint answered about a different item than the one asked
 * about, so its boolean cannot be trusted as the membership answer.
 */
export class WatchlistResponseMismatchError extends Error {
    /** Machine-readable failure code callers can branch on. */
    readonly code = 'WATCHLIST_RESPONSE_MISMATCH';
    /** What a consumer can do about it. */
    readonly hint: string;
    /** The response that did not match, never discarded. */
    readonly cause: unknown;

    constructor(options: { itemId: string; answeredItemId: string }) {
        super(`watchlist contains answered for ${options.answeredItemId}, asked for ${options.itemId}`);
        Object.setPrototypeOf(this, WatchlistResponseMismatchError.prototype);
        this.name = 'WatchlistResponseMismatchError';
        this.hint = 'Retry the membership check; a mismatched answer must not toggle the button.';
        this.cause = { answeredItemId: options.answeredItemId };
    }
}

/**
 * Builds the item-membership URL: /Users/{userId}/Items/{itemId}/Watchlist.
 *
 * @param apiClient - The server's API client.
 * @param userId - The owning user's id.
 * @param itemId - The item being added or removed.
 * @returns The absolute API URL.
 */
function membershipUrl(apiClient: WatchlistApiClient, userId: string, itemId: string): string {
    return apiClient.getUrl(`Users/${userId}/Items/${itemId}/Watchlist`);
}

/**
 * Builds a URL on the user's list itself: /Users/{userId}/Items/Watchlist.
 *
 * @param apiClient - The server's API client.
 * @param userId - The owning user's id.
 * @param path - Path below the list root, if any.
 * @param query - Query parameters.
 * @returns The absolute API URL.
 */
function listUrl(
    apiClient: WatchlistApiClient,
    userId: string,
    path?: string,
    query?: Record<string, unknown>
): string {
    const base = `Users/${userId}/Items/Watchlist`;
    return apiClient.getUrl(path ? `${base}/${path}` : base, query);
}

/**
 * Adds an item to the user's watchlist. Idempotent on the server: adding an
 * item that is already listed keeps the original entry.
 *
 * @param apiClient - The server's API client.
 * @param userId - The owning user's id.
 * @param itemId - The item to add.
 * @returns A promise that resolves once the item is on the list.
 */
export function addToWatchlist(
    apiClient: WatchlistApiClient,
    userId: string,
    itemId: string
): Promise<void> {
    return Promise.resolve(apiClient.ajax({
        url: membershipUrl(apiClient, userId, itemId),
        type: 'POST'
    })).then(() => undefined);
}

/**
 * Removes an item from the user's watchlist. Idempotent on the server:
 * removing an item that is not listed changes nothing.
 *
 * @param apiClient - The server's API client.
 * @param userId - The owning user's id.
 * @param itemId - The item to remove.
 * @returns A promise that resolves once the item is off the list.
 */
export function removeFromWatchlist(
    apiClient: WatchlistApiClient,
    userId: string,
    itemId: string
): Promise<void> {
    return Promise.resolve(apiClient.ajax({
        url: membershipUrl(apiClient, userId, itemId),
        type: 'DELETE'
    })).then(() => undefined);
}

/**
 * Checks whether an item is currently on the user's watchlist.
 *
 * @param apiClient - The server's API client.
 * @param userId - The owning user's id.
 * @param itemId - The item to check.
 * @returns True when the item is on the list.
 */
export async function isInWatchlist(
    apiClient: WatchlistApiClient,
    userId: string,
    itemId: string
): Promise<boolean> {
    const response = await apiClient.getJSON(
        listUrl(apiClient, userId, 'Contains', { itemId })
    ) as WatchlistContainsResponse;
    if (response.ItemId !== itemId) {
        throw new WatchlistResponseMismatchError({ itemId, answeredItemId: response.ItemId });
    }

    return response.IsInWatchlist;
}

/**
 * Fetches a page of the user's watchlist, newest-added first unless another
 * order is requested. Entries whose item has left the library are omitted by
 * the server but preserved.
 *
 * @param apiClient - The server's API client.
 * @param userId - The owning user's id.
 * @param query - Paging and ordering options.
 * @returns The paged result with item dtos and the total record count.
 */
export async function getWatchlist(
    apiClient: WatchlistApiClient,
    userId: string,
    query: WatchlistQuery = {}
): Promise<WatchlistResult> {
    const response = await apiClient.getJSON(
        listUrl(apiClient, userId, undefined, { ...query })
    ) as Partial<WatchlistResult>;

    return {
        Items: response.Items ?? [],
        TotalRecordCount: response.TotalRecordCount ?? 0,
        StartIndex: response.StartIndex ?? 0
    };
}
