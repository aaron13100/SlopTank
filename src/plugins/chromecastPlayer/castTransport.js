const DEFAULT_API_WAIT = Object.freeze({ attempts: 15, intervalMs: 1000 });

/**
 * Minimal adapter around the documented Google Cast Web Sender Base API.
 *
 * This transport owns only SDK/session lifecycle. SlopTank's receiver protocol,
 * player state, and UI behavior stay in plugin.js so this boundary can be
 * audited and tested without borrowing a sample application's player design.
 */
class CastTransport {
    constructor(callbacks, apiWait = DEFAULT_API_WAIT) {
        this.callbacks = callbacks;
        this.apiWait = apiWait;
        this.isInitialized = false;
        this.hasReceivers = false;
        this.session = null;
        this._startPromise = null;
        this._attachedSession = null;

        this._receiveSession = this._receiveSession.bind(this);
        this._receiveAvailability = this._receiveAvailability.bind(this);
        this._receiveSessionUpdate = this._receiveSessionUpdate.bind(this);
        this._receiveMessage = this._receiveMessage.bind(this);
        this._receiveMedia = this._receiveMedia.bind(this);
    }

    get isConnected() {
        return this.session !== null;
    }

    start() {
        if (!this._startPromise) {
            this._startPromise = this._initialize().catch(error => {
                this._startPromise = null;
                this.callbacks.onError(error);
                throw error;
            });
        }
        return this._startPromise;
    }

    async _initialize() {
        const castApi = await this._waitForApi();
        const applicationId = await this.callbacks.getApplicationId();
        if (!applicationId) {
            throw new Error('The server did not provide a Cast receiver application id.');
        }

        const request = new castApi.SessionRequest(applicationId);
        const config = new castApi.ApiConfig(
            request,
            this._receiveSession,
            this._receiveAvailability
        );
        await new Promise((resolve, reject) => {
            castApi.initialize(config, resolve, reject);
        });
        this.isInitialized = true;
    }

    _waitForApi(attempt = 1) {
        const castApi = window.chrome?.cast;
        if (castApi?.isAvailable) {
            return Promise.resolve(castApi);
        }
        if (attempt >= this.apiWait.attempts) {
            return Promise.reject(new Error(
                `Google Cast API was not available after ${attempt} checks.`
            ));
        }
        return new Promise(resolve => {
            setTimeout(resolve, this.apiWait.intervalMs);
        }).then(() => this._waitForApi(attempt + 1));
    }

    requestConnection() {
        if (!this.isInitialized) {
            return Promise.reject(new Error('Google Cast API is not initialized.'));
        }
        return new Promise((resolve, reject) => {
            window.chrome.cast.requestSession(session => {
                this._attachSession(session);
                resolve(session);
            }, reject);
        });
    }

    stop() {
        const session = this.session;
        if (!session) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            session.stop(() => {
                if (this._clearSession()) {
                    this.callbacks.onSessionEnded();
                }
                resolve();
            }, reject);
        });
    }

    send(namespace, payload) {
        if (!this.session) {
            return Promise.reject(new Error('No Google Cast session is connected.'));
        }
        const message = JSON.stringify(payload);
        return new Promise((resolve, reject) => {
            this.session.sendMessage(namespace, message, resolve, reject);
        });
    }

    _receiveSession(session) {
        this._attachSession(session);
    }

    _attachSession(session) {
        if (!session || session === this._attachedSession) {
            return;
        }
        this.session = session;
        this._attachedSession = session;
        session.addMessageListener(this.callbacks.namespace, this._receiveMessage);
        session.addMediaListener(this._receiveMedia);
        session.addUpdateListener(this._receiveSessionUpdate);
        this.callbacks.onSession(session);
    }

    _receiveAvailability(value) {
        this.hasReceivers = value === 'available';
        this.callbacks.onReceiverAvailability(this.hasReceivers);
    }

    _receiveSessionUpdate(isAlive) {
        if (!isAlive && this._clearSession()) {
            this.callbacks.onSessionEnded();
        }
    }

    _receiveMessage(namespace, message) {
        this.callbacks.onMessage(namespace, message);
    }

    _receiveMedia(media) {
        this.callbacks.onMedia(media);
    }

    _clearSession() {
        if (!this.session && !this._attachedSession) {
            return false;
        }
        this.session = null;
        this._attachedSession = null;
        return true;
    }
}

export default CastTransport;
