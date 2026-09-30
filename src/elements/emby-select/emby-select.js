// SlopTank modification notice: added or changed by SlopTank on 2026-09-30.
import layoutManager from '../../components/layoutManager';
import browser from '../../scripts/browser';
import actionsheet from '../../components/actionSheet/actionSheet';
import './emby-select.scss';
import 'webcomponents.js/webcomponents-lite';

const EmbySelectPrototype = Object.create(HTMLSelectElement.prototype);

function enableNativeMenu() {
    // WebView 2 creates dropdown that doesn't work with controller.
    if (browser.edgeUwp || browser.xboxOne) {
        return false;
    }

    // Doesn't seem to work at all
    if (browser.tizen || browser.orsay || browser.web0s) {
        return false;
    }

    // Take advantage of the native input methods
    if (browser.tv) {
        return true;
    }

    return !layoutManager.tv;
}

function triggerChange(select) {
    const evt = new Event('change', { bubbles: false, cancelable: true });
    select.dispatchEvent(evt);
}

function setValue(select, value) {
    select.value = value;
}

function showActionSheet(select) {
    const labelElem = getLabel(select);
    const title = labelElem ? (labelElem.textContent || labelElem.innerText) : null;

    actionsheet.show({
        items: select.options,
        positionTo: select,
        title: title

    }).then(function (value) {
        setValue(select, value);
        triggerChange(select);
    });
}

function getLabel(select) {
    let elem = select.previousSibling;
    while (elem && elem.tagName !== 'LABEL') {
        elem = elem.previousSibling;
    }
    return elem;
}

function onFocus() {
    const label = getLabel(this);
    if (label) {
        label.classList.add('selectLabelFocused');
    }
}

function onBlur() {
    const label = getLabel(this);
    if (label) {
        label.classList.remove('selectLabelFocused');
    }
}

function onMouseDown(e) {
    // e.button=0 for primary (left) mouse button click
    if (!e.button && !enableNativeMenu()) {
        e.preventDefault();
        showActionSheet(this);
    }
}

function onKeyDown(e) {
    // Xbox controller for UWP WebView2 uses keycode 195 to select.
    if ((e.keyCode === 13 || e.keyCode === 195) && !enableNativeMenu()) {
        e.preventDefault();
        showActionSheet(this);
    }
}

let inputId = 0;

const createdCallback = function () {
    if (!this.id) {
        this.id = 'embyselect' + inputId;
        inputId++;
    }

    this.classList.add('emby-select-withcolor');

    if (layoutManager.tv) {
        this.classList.add('emby-select-focusscale');
    }

    this.addEventListener('mousedown', onMouseDown);
    this.addEventListener('keydown', onKeyDown);

    this.addEventListener('focus', onFocus);
    this.addEventListener('blur', onBlur);
};

const attachedCallback = function () {
    if (this.classList.contains('emby-select')) {
        return;
    }

    this.classList.add('emby-select');

    const label = this.ownerDocument.createElement('label');
    label.innerText = this.getAttribute('label') || '';
    label.classList.add('selectLabel');
    label.htmlFor = this.id;
    this.parentNode?.insertBefore(label, this);

    if (this.classList.contains('emby-select-withcolor')) {
        this.parentNode?.insertAdjacentHTML('beforeend', '<div class="selectArrowContainer"><div style="visibility:hidden;display:none;">0</div><span class="selectArrow material-icons keyboard_arrow_down" aria-hidden="true"></span></div>');
    }
};

EmbySelectPrototype.createdCallback = createdCallback;
EmbySelectPrototype.attachedCallback = attachedCallback;

EmbySelectPrototype.setLabel = function (text) {
    const label = this.parentNode?.querySelector('label');

    label.innerText = text;
};

document.registerElement('emby-select', {
    prototype: EmbySelectPrototype,
    extends: 'select'
});

/**
 * Upgrade an `is="emby-select"` element outside the main document's custom
 * element registry.
 *
 * The v0 registry `document.registerElement` created at module scope only
 * upgrades elements in the document this module loaded into. A template
 * instantiated into a foreign document (e.g. the Document Picture-in-Picture
 * popup) never runs the callbacks, so the select keeps neither its styling
 * classes nor its label and arrow markup. This export runs the exact
 * created- and attached-callback upgrade for such an element; the
 * `emby-select` class guard keeps it a no-op for elements the registry
 * already upgraded.
 *
 * @param {HTMLSelectElement} select - The `is="emby-select"` element to upgrade.
 * @returns {void}
 */
export function upgradeSelect(select) {
    if (select.classList.contains('emby-select')) {
        return;
    }

    createdCallback.call(select);
    attachedCallback.call(select);
}

