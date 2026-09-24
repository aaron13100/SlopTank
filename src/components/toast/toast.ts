// SlopTank modification notice: added or changed by SlopTank on 2026-09-24.
import './toast.scss';

interface Toast {
    text: string
    /**
     * Skip the normal 300ms fade-in delay and become visible immediately.
     * Used by callers where the owner expects instant feedback (queue task
     * c180's subtitle-cycle hotkey toast); every other caller keeps the
     * default delayed fade-in.
     */
    immediate?: boolean
}

/** Time (ms) a normal toast waits before becoming visible. */
const VISIBLE_DELAY_MS = 300;
/** Time (ms) a visible toast stays up before it starts fading out. */
const VISIBLE_DURATION_MS = 3000;
/** Time (ms) the fade-out transition takes before DOM removal. */
const HIDE_TRANSITION_MS = 300;

let toastContainer: HTMLDivElement;

function getToastContainer() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.classList.add('toastContainer');
        document.body.appendChild(toastContainer);
    }

    return toastContainer;
}

function remove(elem: HTMLElement) {
    setTimeout(function () {
        elem.parentNode?.removeChild(elem);
    }, HIDE_TRANSITION_MS);
}

function animateRemove(elem: HTMLElement) {
    setTimeout(function () {
        elem.classList.add('toastHide');
        remove(elem);
    }, VISIBLE_DURATION_MS);
}

function makeVisible(elem: HTMLElement) {
    elem.classList.add('toastVisible');
    animateRemove(elem);
}

/**
 * Show a transient message in the shared toast container on `document.body`
 * (or `document.documentElement` while fullscreen, per apphost.js).
 * @param {string | Toast} options - Message text, or a Toast options object.
 * @returns {void}
 */
export default function (options: string | Toast) {
    if (typeof options === 'string') {
        options = {
            text: options
        } as Toast;
    }

    const elem = document.createElement('div');
    elem.classList.add('toast');
    elem.textContent = options.text;

    getToastContainer().appendChild(elem);

    if (options.immediate) {
        makeVisible(elem);
    } else {
        setTimeout(() => makeVisible(elem), VISIBLE_DELAY_MS);
    }
}
