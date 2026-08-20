//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { extensionConfigGet, extensionConfigSet } from '../../services/ops-api.js';
import { showConfirm } from '../modal-dialog.js';

/** @typedef {import('../../services/extensions.js').ExtensionSetting} ExtensionSetting */

/**
 * Validate and decode one setting control's raw value for extensionConfigSet.
 * Optional blank URL, number, and enum controls clear the stored value.
 * @param {ExtensionSetting} setting
 * @param {string|boolean} rawValue
 * @returns {string|number|boolean|null} Decoded value suitable for the config operation
 */
export function decodeExtensionSettingValue(setting, rawValue) {
  if (setting.type === 'boolean') return !!rawValue;
  const value = String(rawValue);
  if (setting.required && value.trim() === '') {
    throw new Error(`${setting.label} is required.`);
  }
  if (setting.type === 'number') {
    if (value.trim() === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${setting.label} must be a finite number.`);
    return number;
  }
  if (setting.type === 'url') {
    if (value.trim() === '') return null;
    try {
      const url = new URL(value);
      if (!url.protocol || !url.host) throw new Error();
    } catch {
      throw new Error(`${setting.label} must be an absolute URL.`);
    }
  }
  if (setting.type === 'enum') {
    if (value === '') return null;
    if (!setting.options?.includes(value)) {
      throw new Error(`${setting.label} must be one of the available options.`);
    }
  }
  return value;
}

/**
 * Generic manifest-driven settings editor embedded in an extension's catalog
 * detail. The injected operations keep the DOM behavior unit-testable without
 * writing the user's real configuration.
 */
export class ExtensionSettingsEditor {
  /**
   * @param {import('../../services/extensions.js').ExtensionManifest} manifest
   * @param {{get?: typeof extensionConfigGet, set?: typeof extensionConfigSet}} [operations]
   */
  constructor(manifest, operations = {}) {
    this.manifest = manifest;
    this.getConfig = operations.get || extensionConfigGet;
    this.setConfig = operations.set || extensionConfigSet;
    /** @type {HTMLElement|null} */
    this.root = null;
    /** @type {Record<string, HTMLInputElement|HTMLSelectElement>} */
    this.controls = {};
    /** @type {Record<string, boolean>} */
    this.secretPresence = {};
  }

  /**
   * @returns {HTMLElement} The settings section
   */
  render() {
    const section = document.createElement('section');
    section.className = 'plugin-section extension-settings';
    this.root = section;

    const header = document.createElement('header');
    header.className = 'plugin-section-header';
    const title = document.createElement('h5');
    title.className = 'plugin-section-title';
    title.textContent = 'Settings';
    const explanation = document.createElement('div');
    explanation.className = 'plugin-section-explanation';
    explanation.textContent = 'Global settings for this extension. Non-secret values are stored under ~/.juggler/extension-config; secrets are stored masked in ~/.juggler/credentials.json and are never shown here.';
    header.append(title, explanation);
    section.appendChild(header);

    const form = document.createElement('form');
    form.className = 'extension-settings-form';
    form.noValidate = true;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this._saveNonSecrets();
    });
    for (const setting of this.manifest.settings || []) {
      form.appendChild(this._renderField(setting));
    }

    const actions = document.createElement('div');
    actions.className = 'extension-settings-actions';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'settings-btn primary small extension-settings-save';
    save.textContent = 'Save settings';
    actions.appendChild(save);
    form.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'extension-settings-message';
    status.setAttribute('role', 'status');
    form.appendChild(status);
    section.appendChild(form);
    this._setBusy(true);
    this._load();
    return section;
  }

  /**
   * @param {ExtensionSetting} setting - Field descriptor
   * @returns {HTMLElement} Rendered field row
   */
  _renderField(setting) {
    const row = document.createElement('div');
    row.className = `extension-setting-field extension-setting-${setting.type}`;
    row.dataset.settingKey = setting.key;

    const info = document.createElement('div');
    info.className = 'extension-setting-info';
    const label = document.createElement('label');
    label.className = 'extension-setting-label';
    label.htmlFor = this._inputId(setting.key);
    label.textContent = setting.label;
    if (setting.required) {
      const required = document.createElement('span');
      required.className = 'extension-setting-required';
      required.textContent = 'required';
      label.appendChild(required);
    }
    info.appendChild(label);
    if (setting.help) {
      const help = document.createElement('div');
      help.className = 'extension-setting-help';
      help.textContent = setting.help;
      info.appendChild(help);
    }
    if (Object.hasOwn(setting, 'default')) {
      const defaultText = document.createElement('div');
      defaultText.className = 'extension-setting-default';
      defaultText.textContent = `Default: ${String(setting.default)}`;
      info.appendChild(defaultText);
    }
    row.appendChild(info);

    const controlWrap = document.createElement('div');
    controlWrap.className = 'extension-setting-control';
    const control = this._createControl(setting);
    this.controls[setting.key] = control;
    controlWrap.appendChild(control);
    if (setting.type === 'secret') this._appendSecretControls(setting, controlWrap, control);
    row.appendChild(controlWrap);
    return row;
  }

  /**
   * @param {ExtensionSetting} setting - Field descriptor
   * @returns {HTMLInputElement|HTMLSelectElement} Input for the field type
   */
  _createControl(setting) {
    if (setting.type === 'enum') {
      const select = document.createElement('select');
      select.className = 'settings-select extension-setting-input';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = setting.required ? 'Choose an option' : 'Use default';
      select.appendChild(blank);
      for (const option of setting.options || []) {
        const el = document.createElement('option');
        el.value = option;
        el.textContent = option;
        select.appendChild(el);
      }
      select.id = this._inputId(setting.key);
      select.required = !!setting.required;
      return select;
    }

    const input = document.createElement('input');
    input.id = this._inputId(setting.key);
    input.className = 'settings-input extension-setting-input';
    input.required = !!setting.required;
    input.autocomplete = 'off';
    if (setting.type === 'boolean') {
      input.type = 'checkbox';
      input.className = 'extension-setting-checkbox';
    } else if (setting.type === 'number') {
      input.type = 'number';
      input.step = 'any';
    } else if (setting.type === 'url') {
      input.type = 'url';
      input.placeholder = 'https://example.com';
      input.spellcheck = false;
    } else if (setting.type === 'secret') {
      input.type = 'password';
      input.placeholder = 'Enter a new value';
      input.autocomplete = 'new-password';
      input.spellcheck = false;
    } else {
      input.type = 'text';
    }
    return input;
  }

  /**
   * @param {ExtensionSetting} setting
   * @param {HTMLElement} wrap
   * @param {HTMLInputElement|HTMLSelectElement} control
   */
  _appendSecretControls(setting, wrap, control) {
    const status = document.createElement('span');
    status.className = 'extension-secret-status';
    status.textContent = 'Not set';
    wrap.appendChild(status);

    const buttons = document.createElement('div');
    buttons.className = 'extension-secret-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'settings-btn primary small';
    save.textContent = 'Save';
    save.addEventListener('click', () => this._saveSecret(setting, String(control.value)));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'settings-btn danger small extension-secret-clear';
    clear.textContent = 'Clear';
    clear.disabled = !!setting.required;
    if (setting.required) clear.title = 'Required settings cannot be cleared';
    clear.addEventListener('click', () => this._saveSecret(setting, ''));
    buttons.append(save, clear);
    wrap.appendChild(buttons);
  }

  async _load() {
    try {
      const values = await this.getConfig({ extId: this.manifest.id });
      this._applyValues(values || {});
      this._message('');
    } catch (error) {
      this._message(this._errorMessage(error, 'Failed to load extension settings.'), true);
    } finally {
      this._setBusy(false);
    }
  }

  /** @param {Record<string, any>} values */
  _applyValues(values) {
    for (const setting of this.manifest.settings || []) {
      const control = this.controls[setting.key];
      if (!control) continue;
      const value = values[setting.key];
      if (setting.type === 'secret') {
        const present = !!value?.__present;
        this.secretPresence[setting.key] = present;
        control.value = '';
        const row = control.closest('.extension-setting-field');
        const status = row?.querySelector('.extension-secret-status');
        if (status) status.textContent = present ? 'Set' : 'Not set';
        const clear = /** @type {HTMLButtonElement|null} */ (row?.querySelector('.extension-secret-clear'));
        if (clear && !setting.required) clear.disabled = !present;
      } else if (setting.type === 'boolean') {
        /** @type {HTMLInputElement} */ (control).checked = value === true;
      } else {
        control.value = value === undefined || value === null ? '' : String(value);
      }
    }
  }

  async _saveNonSecrets() {
    /** @type {Record<string, string|number|boolean|null|{__present: true}>} */
    const values = {};
    try {
      for (const setting of this.manifest.settings || []) {
        const control = this.controls[setting.key];
        if (!control) continue;
        if (setting.type === 'secret') {
          values[setting.key] = this.secretPresence[setting.key] ? { __present: true } : '';
          continue;
        }
        const raw = setting.type === 'boolean'
          ? /** @type {HTMLInputElement} */ (control).checked
          : control.value;
        values[setting.key] = decodeExtensionSettingValue(setting, raw);
      }
    } catch (error) {
      this._message(this._errorMessage(error, 'Check the highlighted settings.'), true);
      return;
    }
    await this._save(values, 'Settings saved.');
  }

  /**
   * @param {ExtensionSetting} setting - Secret field descriptor
   * @param {string} value - New secret, or blank to clear it
   */
  async _saveSecret(setting, value) {
    if (value === '' && !this.secretPresence[setting.key]) {
      this._message(`${setting.label} is not set.`, true);
      return;
    }
    if (value === '' && setting.required) {
      this._message(`${setting.label} is required and cannot be cleared.`, true);
      return;
    }
    if (value === '') {
      const confirmed = await showConfirm(`Clear ${setting.label}?`, 'Clear extension secret', { danger: true });
      if (!confirmed) return;
    }
    await this._save({ [setting.key]: value }, value ? `${setting.label} saved.` : `${setting.label} cleared.`);
  }

  /**
   * @param {Record<string, any>} values - Partial values to update
   * @param {string} successMessage - Feedback shown after the update
   */
  async _save(values, successMessage) {
    this._setBusy(true);
    this._message('Saving…');
    try {
      const result = await this.setConfig({ extId: this.manifest.id, values, scope: 'global' });
      this._applyValues(result || {});
      this._message(successMessage);
    } catch (error) {
      this._message(this._errorMessage(error, 'Failed to save extension settings.'), true);
    } finally {
      this._setBusy(false);
    }
  }

  /** @param {boolean} busy */
  _setBusy(busy) {
    this.root?.querySelectorAll('input, select, button').forEach((element) => {
      /** @type {HTMLInputElement|HTMLSelectElement|HTMLButtonElement} */ (element).disabled = busy;
    });
    if (!busy) {
      for (const setting of this.manifest.settings || []) {
        if (setting.type !== 'secret' || setting.required) continue;
        const control = this.controls[setting.key];
        const clear = /** @type {HTMLButtonElement|null} */ (control?.closest('.extension-setting-field')?.querySelector('.extension-secret-clear'));
        if (clear) clear.disabled = !this.secretPresence[setting.key];
      }
    }
  }

  /**
   * @param {string} message - Status text
   * @param {boolean} [error] - Whether to use error styling
   */
  _message(message, error = false) {
    const el = this.root?.querySelector('.extension-settings-message');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', error);
  }

  /**
   * @param {unknown} error - Caught operation error
   * @param {string} fallback - Message for non-Error failures
   * @returns {string} Useful user-facing message
   */
  _errorMessage(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  /**
   * @param {string} key - Manifest setting key
   * @returns {string} DOM-safe input id
   */
  _inputId(key) {
    return `extension-setting-${this.manifest.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${key}`;
  }
}
