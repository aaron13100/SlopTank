// SlopTank modification notice: added by SlopTank on 2026-10-09.
import { ApiClient, Events } from 'jellyfin-apiclient';

/**
 * Legacy API client with a second, tokenless browser authentication mode.
 * A successful external login leaves only an HttpOnly opaque cookie in the
 * browser. The user id is display state, never a credential; every request
 * still passes the server's live cookie/session authorization check.
 */
export default class CookieSessionApiClient extends ApiClient {
    /** Mark the current server user as authenticated by its browser cookie. */
    enableExternalCookieSession(userId) {
        this.setAuthenticationInfo(null, userId);
        this._externalCookieSession = true;
        this._loggedIn = true;
    }

    /** Whether this client is in tokenless browser-cookie mode. */
    isExternalCookieSession() {
        return this._externalCookieSession === true;
    }

    /** Local token authentication always replaces cookie mode. */
    setAuthenticationInfo(accessToken, userId) {
        this._externalCookieSession = false;
        super.setAuthenticationInfo(accessToken, userId);
    }

    /**
     * The legacy SDK emits a MediaBrowser metadata-only Authorization
     * header without a token. The server correctly treats any explicit
     * Authorization header as taking precedence over a cookie, so omit
     * SDK-added metadata only in cookie mode. An explicit header supplied
     * by a caller remains intact and retains normal precedence.
     */
    setRequestHeaders(headers) {
        if (!this.isExternalCookieSession()) {
            super.setRequestHeaders(headers);
        }
    }

    /** Open the legacy message channel with the ambient browser cookie. */
    openWebSocket() {
        if (!this.isExternalCookieSession()) {
            return super.openWebSocket();
        }

        // The external-cookie flow is supported by the modern web runtime.
        // eslint-disable-next-line compat/compat
        const url = new URL(this.getUrl('socket'));
        if (url.origin !== window.location.origin) {
            throw new CookieSessionTransportError(url.origin);
        }
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('deviceId', this.deviceId());
        const socket = new WebSocket(url.href);
        this._webSocket = socket;
        socket.onopen = () => Events.trigger(this, 'websocketopen');
        socket.onmessage = event => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (cause) {
                console.error('[CookieSessionApiClient] server WebSocket message is not JSON', cause);
                socket.close();
                return;
            }

            if (message.MessageType === 'UserDeleted'
                || ((message.MessageType === 'UserUpdated' || message.MessageType === 'UserConfigurationUpdated')
                    && message.Data?.Id === this.getCurrentUserId())) {
                this._currentUser = null;
            }
            if (message.MessageType === 'ForceKeepAlive') {
                clearInterval(this.keepAliveInterval);
                this.sendWebSocketMessage('KeepAlive');
                this.keepAliveInterval = setInterval(() => this.sendWebSocketMessage('KeepAlive'),
                    Math.max(1000, Number(message.Data) * 500));
            }
            Events.trigger(this, 'message', [message]);
        };
        socket.onerror = event => {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            Events.trigger(this, 'websocketerror', [event]);
        };
        socket.onclose = () => {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            if (this._webSocket === socket) {
                this._webSocket = null;
            }
            Events.trigger(this, 'websocketclose');
        };
    }

    /**
     * Local logout must invalidate the server session even though this
     * client holds no token. A same-origin POST carries the opaque cookie,
     * and the server's Origin check protects the unsafe operation.
     */
    async logout() {
        if (!this.isExternalCookieSession()) {
            return super.logout();
        }

        try {
            await this.ajax({
                type: 'POST',
                url: this.getUrl('Sessions/Logout')
            });
        } catch (cause) {
            throw new CookieSessionLogoutError(cause?.status, { cause });
        }

        this.closeWebSocket();
        this.setAuthenticationInfo(null, null);
    }
}

/** Preserves the server's real status when local session revocation fails. */
class CookieSessionLogoutError extends Error {
    code = 'EXTERNAL_COOKIE_LOGOUT_FAILED';
    hint = 'Check the server session and retry local sign-out.';

    constructor(status, options) {
        super(`The server refused local sign-out (HTTP ${status ?? 'unavailable'}).`, options);
        this.name = 'CookieSessionLogoutError';
        this.status = status;
    }
}

/** Refuses ambient cookie authentication on another server origin. */
class CookieSessionTransportError extends Error {
    code = 'EXTERNAL_COOKIE_ORIGIN_MISMATCH';
    hint = 'Use the same server origin that completed external login.';

    constructor(origin) {
        super(`External cookie session cannot open a channel to ${origin}.`);
        this.name = 'CookieSessionTransportError';
    }
}
