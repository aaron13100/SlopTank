import type { Api } from '@jellyfin/sdk/lib/api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

/**
 * Data-access boundary for the server's permalink endpoints
 * (docs/internal/permalink-url-design.md sections 3.6.8, 4.1 and 5).
 *
 * This module is the only place in the client that knows the permalink wire
 * format. It makes no resolution decisions and renders nothing: it issues the
 * request, shapes the response into a client type, and converts every failure
 * into a `PermalinkRequestError` carrying the server's own diagnostic code and
 * message so no caller has to string-match an HTTP body.
 *
 * The endpoints are fork-only, so there is no generated SDK class for them;
 * requests go through the SDK `Api`'s own axios instance with the same base
 * path and authorization header the generated classes use.
 */

/** Redemption purpose accepted by the server's discovery endpoint. */
export type PermalinkRedemptionPurpose = 'details' | 'playback';

/** How a permalink request failed, once the HTTP status has been classified. */
export type PermalinkFailureKind =
    | 'conflict'
    | 'unavailable'
    | 'unauthorized'
    | 'ineligible'
    | 'not-found'
    | 'transport'
    | 'aborted';

/** One metadata-free candidate returned by discovery. Handle and lease are opaque. */
export interface PermalinkCandidateEnvelope {
    rank: number
    namespace: string
    handle: string
    lease: string
}

/** The ordered active aliases the server persisted for an item. */
export interface PermalinkAliasSet {
    version: number
    ids: string[]
    canonicalId: string
}

/** The immutable playback plan the server froze when a playback lease was consumed. */
export interface PermalinkPlaybackSnapshot {
    itemId: string
    queueCount: number
    playbackSessionId: string
}

/**
 * A permalink request that did not succeed, carrying the server's stable
 * diagnostic code (`EvidenceRequired`, `alias-detached`,
 * `identity-mutation-pending`, ...) alongside the HTTP status, so callers can
 * branch on the failure instead of on prose.
 */
export class PermalinkRequestError extends Error {
    /**
     * Own-property brand every consumer discriminates on. See
     * {@link isPermalinkRequestError} for why `instanceof` is not used.
     */
    readonly isPermalinkRequestError = true as const;

    readonly kind: PermalinkFailureKind;
    readonly code: string;
    readonly status: number | null;
    readonly hint: string;
    /** The original transport or HTTP failure, never discarded. Declared here because this project's TS lib target predates `Error.cause`. */
    readonly cause: unknown;

    constructor(options: {
        kind: PermalinkFailureKind
        code: string
        message: string
        hint: string
        status?: number | null
        cause?: unknown
    }) {
        super(options.message);
        // Restore the prototype the ES5 downlevel of `extends Error` drops, so
        // `instanceof` behaves for any consumer outside this module.
        Object.setPrototypeOf(this, PermalinkRequestError.prototype);
        this.name = 'PermalinkRequestError';
        this.kind = options.kind;
        this.code = options.code;
        this.status = options.status ?? null;
        this.hint = options.hint;
        this.cause = options.cause;
    }
}

/**
 * Whether a caught value is a typed permalink failure.
 *
 * Tests an own property rather than the prototype chain on purpose. This app
 * compiles to ES5 (tsconfig `target`, and a browserslist that still names
 * Chrome 27), where `class ... extends Error` is downlevelled to a form whose
 * instances do not carry the subclass on their prototype chain -- and a
 * code-split bundle can hold two copies of a module, giving two class
 * identities for the same error. Both make `instanceof` report false in the
 * shipped build while passing in tests, which silently collapses every typed
 * server refusal (`EvidenceRequired`, 409, 503) into one generic error state.
 * A brand cannot be lost either way.
 *
 * @param error The caught value.
 * @returns True when it is a permalink failure carrying a server code.
 */
export function isPermalinkRequestError(error: unknown): error is PermalinkRequestError {
    return (error as PermalinkRequestError | null | undefined)?.isPermalinkRequestError === true;
}

/** The `ProblemDetails` body ASP.NET returns for a typed permalink failure. */
interface ProblemDetailsBody {
    title?: string
    detail?: string
    status?: number
}

/** The `QueryResult<T>` envelope the discovery endpoint returns. */
interface QueryResultBody<T> {
    Items?: T[]
    TotalRecordCount?: number
}

interface CandidateEnvelopeBody {
    Rank?: number
    Namespace?: string
    Handle?: string
    Lease?: string
}

interface AliasSetBody {
    Version?: number
    Ids?: string[]
    CanonicalId?: string
}

interface PlaybackSnapshotBody {
    ItemId?: string
    QueueCount?: number
    PlaybackSessionId?: string
}

function toPlaybackSnapshot(
    body: PlaybackSnapshotBody,
    url: string,
    playbackSessionId: string
): PermalinkPlaybackSnapshot {
    if (!body.ItemId) {
        throw new PermalinkRequestError({
            kind: 'conflict',
            code: 'playback-snapshot-incomplete',
            message: 'The server returned a playback snapshot without an item id.',
            hint: `Response from ${url} does not satisfy the snapshot contract; playback was not started.`
        });
    }

    return {
        itemId: body.ItemId,
        queueCount: body.QueueCount ?? 1,
        playbackSessionId: body.PlaybackSessionId ?? playbackSessionId
    };
}

interface PermalinkRequest {
    api: Api
    method: 'GET' | 'POST'
    url: string
    params?: Record<string, string>
    body?: unknown
    signal?: AbortSignal
}

function isAbort(error: unknown): boolean {
    const candidate = error as { code?: string, name?: string } | null;
    return candidate?.code === 'ERR_CANCELED' || candidate?.name === 'CanceledError' || candidate?.name === 'AbortError';
}

/** Maps an HTTP status onto the failure classes the server's own error kinds produce. */
function kindForStatus(status: number): PermalinkFailureKind {
    if (status === 503) return 'unavailable';
    if (status === 409) return 'conflict';
    if (status === 400) return 'ineligible';
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 404) return 'not-found';
    return 'transport';
}

/**
 * Converts a rejected request into a typed error. Never discards the original
 * failure: the underlying error is kept as `cause`, and the server's own
 * `title`/`detail` become the code and message when it sent a problem body.
 */
function toPermalinkError(error: unknown, url: string): PermalinkRequestError {
    if (isAbort(error)) {
        return new PermalinkRequestError({
            kind: 'aborted',
            code: 'request-aborted',
            message: `Permalink request to ${url} was aborted.`,
            hint: 'The route changed before the response arrived; nothing was decided from it.',
            cause: error
        });
    }

    const response = (error as { response?: { status?: number, data?: ProblemDetailsBody } } | null)?.response;
    if (typeof response?.status === 'number') {
        const problem = response.data;
        return new PermalinkRequestError({
            kind: kindForStatus(response.status),
            code: problem?.title ?? `http-${response.status}`,
            message: problem?.detail ?? `${url} returned HTTP ${response.status}.`,
            hint: 'The server refused this permalink; its code and message say why.',
            status: response.status,
            cause: error
        });
    }

    return new PermalinkRequestError({
        kind: 'transport',
        code: 'transport-failure',
        message: error instanceof Error ? error.message : String(error),
        hint: `The request to ${url} never produced an HTTP response.`,
        cause: error
    });
}

async function request<T>({ api, method, url, params, body, signal }: PermalinkRequest): Promise<T> {
    try {
        const response = await api.axiosInstance.request<T>({
            method,
            url,
            baseURL: api.basePath,
            params,
            data: body,
            signal,
            headers: { Authorization: api.authorizationHeader }
        });
        return response.data;
    } catch (error) {
        throw toPermalinkError(error, url);
    }
}

function toCandidate(body: CandidateEnvelopeBody, url: string): PermalinkCandidateEnvelope {
    if (!body.Handle || !body.Lease) {
        throw new PermalinkRequestError({
            kind: 'conflict',
            code: 'candidate-envelope-incomplete',
            message: 'The server returned a permalink candidate without a handle or lease.',
            hint: `Response from ${url} does not satisfy the candidate contract; nothing was resolved from it.`
        });
    }

    return {
        rank: body.Rank ?? 0,
        namespace: body.Namespace ?? 'external',
        handle: body.Handle,
        lease: body.Lease
    };
}

/**
 * Discovers the verified candidates for one alias.
 *
 * @param options.api The SDK Api for the server being asked.
 * @param options.permalinkId The opaque permalink id, exactly as it appeared in the URL.
 * @param options.purpose The redemption purpose the returned leases are bound to.
 * @param options.signal Aborts the request when the route changes.
 * @returns Every candidate the server verified, never a truncated subset.
 * @throws PermalinkRequestError When the server fails the request or reports fewer rows than it counted.
 */
export async function discoverPermalinkCandidates({ api, permalinkId, purpose, signal }: {
    api: Api
    permalinkId: string
    purpose: PermalinkRedemptionPurpose
    signal?: AbortSignal
}): Promise<PermalinkCandidateEnvelope[]> {
    const url = `/Permalinks/${encodeURIComponent(permalinkId)}/Items`;
    const result = await request<QueryResultBody<CandidateEnvelopeBody>>({
        api,
        method: 'GET',
        url,
        params: { purpose },
        signal
    });

    const rows = result.Items ?? [];
    const total = result.TotalRecordCount ?? rows.length;
    // Design section 4.2 rule 3: never decide from a truncated result set. The
    // endpoint returns every candidate in one response today, so a shortfall
    // means the contract changed underneath us, not that paging is needed.
    if (total > rows.length) {
        throw new PermalinkRequestError({
            kind: 'conflict',
            code: 'candidate-set-truncated',
            message: `The server counted ${total} permalink candidates but returned ${rows.length}.`,
            hint: 'Resolution stops rather than deciding from an incomplete candidate set.'
        });
    }

    return rows.map(row => toCandidate(row, url));
}

/**
 * Consumes a details lease and returns the revalidated item.
 *
 * @param options.api The SDK Api for the server being asked.
 * @param options.candidate The candidate whose details lease is being spent.
 * @param options.signal Aborts the request when the route changes.
 * @returns The item DTO the server re-verified at redemption time.
 * @throws PermalinkRequestError When the lease is spent, replayed, or its evidence no longer holds.
 */
export async function redeemPermalinkDetails({ api, candidate, signal }: {
    api: Api
    candidate: PermalinkCandidateEnvelope
    signal?: AbortSignal
}): Promise<BaseItemDto> {
    return request<BaseItemDto>({
        api,
        method: 'POST',
        url: `/Permalinks/Candidates/${encodeURIComponent(candidate.handle)}/Details`,
        body: { Lease: candidate.lease },
        signal
    });
}

/**
 * Exchanges a details lease for a freshly re-checked playback lease.
 *
 * @param options.api The SDK Api for the server being asked.
 * @param options.candidate The candidate whose details lease is being exchanged.
 * @param options.signal Aborts the request when the route changes.
 * @returns A replacement candidate envelope bound to the playback purpose.
 * @throws PermalinkRequestError When the details lease is spent or its evidence changed.
 */
export async function exchangePermalinkPlaybackLease({ api, candidate, signal }: {
    api: Api
    candidate: PermalinkCandidateEnvelope
    signal?: AbortSignal
}): Promise<PermalinkCandidateEnvelope> {
    const url = `/Permalinks/Candidates/${encodeURIComponent(candidate.handle)}/PlaybackLease`;
    const body = await request<CandidateEnvelopeBody>({
        api,
        method: 'POST',
        url,
        body: { Lease: candidate.lease },
        signal
    });
    return toCandidate(body, url);
}

/**
 * Runs the established details-to-playback exchange and redemption inside one
 * versioned server request, returning the same immutable playback snapshot.
 */
export async function redeemPermalinkPlaybackReadyV1({ api, candidate, playbackSessionId, signal }: {
    api: Api
    candidate: PermalinkCandidateEnvelope
    playbackSessionId: string
    signal?: AbortSignal
}): Promise<PermalinkPlaybackSnapshot> {
    const url = `/Permalinks/Candidates/${encodeURIComponent(candidate.handle)}/PlaybackReadyV1`;
    const body = await request<PlaybackSnapshotBody>({
        api,
        method: 'POST',
        url,
        body: { Lease: candidate.lease, PlaybackSessionId: playbackSessionId },
        signal
    });
    return toPlaybackSnapshot(body, url, playbackSessionId);
}

/**
 * Consumes a playback lease and returns the immutable plan the server froze.
 *
 * @param options.api The SDK Api for the server being asked.
 * @param options.candidate The playback-purpose candidate being redeemed.
 * @param options.playbackSessionId The client-minted id binding this redemption to one session.
 * @param options.signal Aborts the request when the route changes.
 * @returns The frozen snapshot, whose item id is the only identity the client acts on.
 * @throws PermalinkRequestError When the lease is spent, replayed, or the item was replaced.
 */
export async function redeemPermalinkPlayback({ api, candidate, playbackSessionId, signal }: {
    api: Api
    candidate: PermalinkCandidateEnvelope
    playbackSessionId: string
    signal?: AbortSignal
}): Promise<PermalinkPlaybackSnapshot> {
    const url = `/Permalinks/Candidates/${encodeURIComponent(candidate.handle)}/Playback`;
    const body = await request<PlaybackSnapshotBody>({
        api,
        method: 'POST',
        url,
        body: { Lease: candidate.lease, PlaybackSessionId: playbackSessionId },
        signal
    });

    return toPlaybackSnapshot(body, url, playbackSessionId);
}

/**
 * Ensures the item's durable permalink aliases exist and returns them ordered.
 *
 * Every share and copy action calls this before it constructs a URL (design
 * section 5): the alias the client publishes is the one the server persisted
 * evidence for, never a value guessed from an item DTO.
 *
 * @param options.api The SDK Api for the server that owns the item.
 * @param options.itemId The visible item id being shared.
 * @returns The versioned alias set whose canonical id leads the ordering.
 * @throws PermalinkRequestError When the item is ineligible or its evidence cannot be persisted.
 */
export async function ensurePermalinkIds({ api, itemId }: {
    api: Api
    itemId: string
}): Promise<PermalinkAliasSet> {
    const url = `/Items/${encodeURIComponent(itemId)}/Permalink`;
    const body = await request<AliasSetBody>({ api, method: 'POST', url });

    const canonicalId = body.CanonicalId ?? body.Ids?.[0];
    if (!canonicalId) {
        throw new PermalinkRequestError({
            kind: 'conflict',
            code: 'alias-set-empty',
            message: 'The server persisted no permalink alias for this item.',
            hint: `Response from ${url} carried no canonical id, so no permanent URL can be built.`
        });
    }

    return {
        version: body.Version ?? 1,
        ids: body.Ids ?? [ canonicalId ],
        canonicalId
    };
}
