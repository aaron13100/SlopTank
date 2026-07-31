/**
 * The single place in the client that reaches for platform randomness.
 *
 * Call sites ask this module for an opaque identifier instead of touching
 * `crypto` directly, so there is exactly one implementation choice to audit
 * and exactly one seam to replace in a test.
 *
 * `crypto.getRandomValues` is used rather than `crypto.randomUUID` on purpose:
 * `randomUUID` is restricted to secure contexts, and this app is routinely
 * served over plain HTTP on a LAN, where it is simply `undefined`.
 */

const ID_BYTE_LENGTH = 16;

/** Reads platform randomness, or null on the old TV browsers this app still targets. */
function platformRandomBytes(length: number): Uint8Array | null {
    // Read through `typeof` rather than touching the global directly: this
    // app's browserslist still carries Chrome 27-era TV browsers, where the
    // Crypto API can be absent outright and a bare reference would throw.
    const source = typeof crypto === 'undefined' ? undefined : crypto;
    if (typeof source?.getRandomValues !== 'function') {
        return null;
    }

    return source.getRandomValues(new Uint8Array(length));
}

/**
 * Returns a fresh opaque identifier for correlating one client-side operation
 * with a server-side session.
 *
 * Falls back to `Math.random` where the Crypto API is missing. That is
 * deliberate and safe here: this value only distinguishes one client session
 * from another in a request the server has already authenticated and bound to
 * a user, so it needs to be unique, not unguessable. It is never a credential.
 *
 * @returns 32 lowercase hex characters carrying 128 bits of identifier.
 */
export function randomId(): string {
    const bytes = platformRandomBytes(ID_BYTE_LENGTH)
        ?? Uint8Array.from({ length: ID_BYTE_LENGTH }, () => Math.floor(Math.random() * 256));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
