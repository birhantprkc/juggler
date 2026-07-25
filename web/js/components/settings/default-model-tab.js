//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { modelLabel, modelLabelFromList } from '../../model/model-display.js';

/**
 * "Provider settings" tab (id `default-model`): the single default-model picker
 * plus the global stream-idle-timeout field. Seeded from the shared loadConfig()
 * fetch; the picker persists immediately via PUT /api/default-model and the
 * timeout via PUT /api/config.
 */
export class DefaultModelTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {object} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
    /** @type {{provider: string, model: string, explicit?: boolean}} @private - Model new conversations are seeded with; explicit=false means automatic. */
    this.defaultModel = { provider: '', model: '', explicit: false };
    /** @type {{provider?: string, model?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} @private - Cheap model for out-of-band micro-tasks; explicit=false means Auto. */
    this.cheapModel = { explicit: false };
  }

  /**
   * Receive the shared loadConfig() payload: store config/providers/defaultModel
   * and (on a full render) build the fields.
   * @param {{config: object, providers: any[], defaultModel: {provider: string, model: string, explicit?: boolean}, cheapModel?: {provider?: string, model?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.config = data.config;
    this.providers = data.providers;
    this.defaultModel = data.defaultModel;
    if (data.cheapModel) this.cheapModel = data.cheapModel;
    if (renderFields) {
      this.renderGlobalProviderSettings();
      this.renderDefaultModelField();
      this.renderCheapModelField();
    }
  }

  /**
   * Render global provider settings that apply across every provider, shown
   * as a section on the Provider settings tab. Currently just the stream idle
   * timeout: the
   * window a streaming provider waits for the next event before declaring the
   * connection dead ("stream stalled: no data for 3m0s"). Raising it helps
   * gateways whose cold starts exceed the 180s default. Persists to
   * credentials.json via PUT /api/config; the server reads it live.
   * @private
   */
  renderGlobalProviderSettings() {
    const container = this.host.querySelector('#global-provider-settings');
    if (!container) return;
    container.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = 'Stream idle timeout';
    container.appendChild(heading);

    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = 'Seconds to wait';
    infoColumn.appendChild(nameLabel);
    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent =
      'Seconds to wait for the next stream event before treating the connection ' +
      'as dropped ("stream stalled"). Raise it for gateways with slow cold ' +
      'starts. Leave blank for the default (180).';
    infoColumn.appendChild(description);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const row = document.createElement('div');
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'stream-idle-timeout-input';
    // Non-secret persisted value: keep visible across close/reopen (see close()).
    input.className = 'settings-value-input';
    input.inputMode = 'numeric';
    input.placeholder = '180';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config).streamIdleTimeout || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config).streamIdleTimeout || '')) return;
      if (value !== '' && !/^\d+$/.test(value)) {
        status.textContent = 'Enter a whole number of seconds.';
        return;
      }
      if (value !== '' && parseInt(value, 10) <= 0) {
        status.textContent = 'Must be greater than zero.';
        return;
      }
      status.textContent = 'Saving…';
      try {
        const response = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stream_idle_timeout: value }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        /** @type {any} */ (this.config).streamIdleTimeout = value;
        status.textContent = value ? `Saved. Waiting up to ${value}s.` : 'Saved. Using default (180s).';
      } catch (e) {
        console.error('[SettingsPanel] Failed to save stream idle timeout:', e);
        status.textContent = 'Failed to save.';
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        input.blur();
      }
    });

    controlColumn.appendChild(row);
    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Render the single "Default model" picker. The dropdown offers an
   * "Automatic" option (server picks a preferred available model) plus every
   * model grouped by provider. The current default is preselected; changing
   * it persists immediately via PUT /api/default-model. The auto-resolved
   * choice is shown as a hint under the combo box.
   * @private
   */
  renderDefaultModelField() {
    this._renderModelField({
      containerId: '#default-model-field-container',
      selectId: 'default-model-select',
      nameLabel: 'Default model for new conversations',
      autoLabel: 'Automatic',
      current: this.defaultModel || { provider: '', model: '', explicit: false },
      statusText: (ref) => this._defaultModelStatusText(ref),
      onSave: (value) => this._saveDefaultModel(value),
    });
  }

  /**
   * Render the "Cheap model" picker: the small/fast model used for out-of-band
   * micro-tasks (auto-naming a tab, plugin generateText). Offers an "Auto"
   * option plus every model grouped by provider. Changing it persists
   * immediately via PUT /api/cheap-model; "Auto" clears the stored value and
   * the auto-derived choice is shown as a hint under the combo box.
   * @private
   */
  renderCheapModelField() {
    this._renderModelField({
      containerId: '#cheap-model-field-container',
      selectId: 'cheap-model-select',
      nameLabel: 'Cheap model for background tasks',
      description:
        'A small, fast model used out-of-band for micro-tasks like auto-naming a ' +
        'tab. "Auto" derives one from the model in use.',
      autoLabel: 'Auto',
      current: this.cheapModel || { explicit: false },
      statusText: (ref) => this._cheapModelStatusText(ref),
      onSave: (value) => this._saveCheapModel(value),
    });
  }

  /**
   * Shared renderer for the Default/Cheap model pickers. Both offer an
   * auto-option (clearing the stored value) plus every model grouped by
   * provider, an "unavailable" fallback for a pinned-but-missing model, and a
   * status hint under the combo box describing the current (or auto-resolved)
   * choice.
   * @param {object} opts
   * @param {string} opts.containerId - CSS selector for the field container.
   * @param {string} opts.selectId - id to assign the <select>.
   * @param {string} opts.nameLabel - field label text.
   * @param {string} [opts.description] - optional description under the label.
   * @param {string} opts.autoLabel - text for the auto-option (e.g. "Automatic").
   * @param {{provider?: string, model?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} opts.current
   * @param {(ref: any) => string} opts.statusText - builds the status hint.
   * @param {(value: string) => void} opts.onSave - persists "<provider> <model>" or "".
   * @private
   */
  _renderModelField({ containerId, selectId, nameLabel, description, autoLabel, current, statusText, onSave }) {
    const container = this.host.querySelector(containerId);
    if (!container) return;
    container.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = nameLabel;
    infoColumn.appendChild(name);

    if (description) {
      const desc = document.createElement('div');
      desc.className = 'provider-description';
      desc.textContent = description;
      infoColumn.appendChild(desc);
    }

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'default-model-select';
    select.id = selectId;

    const ref = current || { explicit: false };
    const explicit = !!ref.explicit;
    const currentValue = explicit && ref.provider && ref.model
      ? `${ref.provider} ${ref.model}`
      : '';
    let currentValueIsValid = false;

    // Auto-option — clears the stored value; the server then derives/picks a
    // model. The resolved choice is surfaced in the status hint below.
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = autoLabel;
    if (!explicit) autoOpt.selected = true;
    select.appendChild(autoOpt);

    for (const provider of this.providers) {
      if (!provider.modelsWithContext || provider.modelsWithContext.length === 0) continue;
      const group = document.createElement('optgroup');
      group.label = provider.available
        ? provider.displayName
        : `${provider.displayName} (no API key)`;
      for (const m of /** @type {Array<{id: string, displayName?: string}>} */ (provider.modelsWithContext)) {
        const opt = document.createElement('option');
        const val = `${provider.name} ${m.id}`;
        opt.value = val;
        opt.textContent = modelLabel(m.displayName, m.id);
        if (val === currentValue) {
          opt.selected = true;
          currentValueIsValid = true;
        }
        group.appendChild(opt);
      }
      select.appendChild(group);
    }

    // An explicitly-set model that is no longer in the provider list: surface
    // it as a selected "unavailable" option so the state stays visible.
    if (currentValue && !currentValueIsValid) {
      const orphanGroup = document.createElement('optgroup');
      orphanGroup.label = 'Currently set (unavailable)';
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.selected = true;
      const refProvider = this.providers.find((/** @type {any} */ p) => p.name === ref.provider);
      const modelId = ref.model || '';
      opt.textContent = `${refProvider ? modelLabelFromList(this.providers, refProvider.name, modelId) : `${ref.provider} / ${modelId}`} — unavailable`;
      orphanGroup.appendChild(opt);
      select.insertBefore(orphanGroup, select.firstChild ? select.firstChild.nextSibling : null);
    }

    select.addEventListener('change', () => onSave(select.value));

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = statusText(ref);

    controlColumn.appendChild(select);
    controlColumn.appendChild(status);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    container.appendChild(row);
  }

  /**
   * Persist the chosen cheap model. An empty value clears it (Auto).
   * @param {string} value - "<provider> <model>" or "" for Auto
   * @private
   */
  async _saveCheapModel(value) {
    let body;
    if (!value) {
      body = { provider: '', model: '' };
    } else {
      const sep = value.indexOf(' ');
      body = { provider: value.slice(0, sep), model: value.slice(sep + 1) };
    }
    try {
      const response = await fetch('/api/cheap-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      // Reflect the saved state locally. When cleared to Auto, re-fetch so the
      // auto-derived hint under the combo box refreshes; otherwise update in place.
      if (body.provider && body.model) {
        this.cheapModel = { provider: body.provider, model: body.model, explicit: true };
        this.renderCheapModelField();
      } else {
        try {
          const refreshed = await fetch('/api/cheap-model');
          this.cheapModel = refreshed.ok ? await refreshed.json() : { explicit: false };
        } catch {
          this.cheapModel = { explicit: false };
        }
        this.renderCheapModelField();
      }
    } catch (err) {
      console.error('[SettingsPanel] Failed to save cheap model:', err);
      if (window.showAlert) {
        await window.showAlert('Failed to save cheap model.', 'Error');
      }
    }
  }

  /**
   * @param {{provider: string, model: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} ref
   * @returns {string} short status describing the current default-model state
   * @private
   */
  _defaultModelStatusText(ref) {
    if (!ref || !ref.explicit) {
      if (ref && ref.provider && ref.model) {
        return `Auto — currently ${modelLabelFromList(this.providers, ref.provider, ref.model)}.`;
      }
      return 'Auto — no provider is configured yet.';
    }
    return this._explicitModelStatusText(ref);
  }

  /**
   * @param {{provider?: string, model?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} ref
   * @returns {string} short status describing the current cheap-model state
   * @private
   */
  _cheapModelStatusText(ref) {
    if (!ref || !ref.explicit) {
      const auto = ref && ref.autoResolved;
      if (auto && auto.provider && auto.model) {
        return `Auto — currently ${modelLabelFromList(this.providers, auto.provider, auto.model)}.`;
      }
      return 'Auto — derived from the model in use.';
    }
    return this._explicitModelStatusText(ref);
  }

  /**
   * Status hint shared by both pickers for an explicitly-pinned model: reports
   * whether its provider is registered/available and the model still listed.
   * @param {{provider?: string, model?: string}} ref
   * @returns {string} the status hint for the pinned model
   * @private
   */
  _explicitModelStatusText(ref) {
    const p = this.providers.find((/** @type {any} */ pp) => pp.name === ref.provider);
    if (!p) return 'Provider not registered.';
    if (!p.available) return p.authType === 'oauth_bearer'
      ? (p.authHint || 'Provider is unavailable. Sign in to continue.')
      : 'Provider is configured but has no API key.';
    const hasModel = p.modelsWithContext && p.modelsWithContext.some((/** @type {{id: string}} */ m) => m.id === ref.model);
    if (p.modelsWithContext && !hasModel) {
      return 'Model is not in the provider’s current model list.';
    }
    return 'Active.';
  }

  /**
   * Persist the chosen default model. An empty value clears it (Automatic).
   * @param {string} value - "<provider> <model>" or "" for Automatic
   * @private
   */
  async _saveDefaultModel(value) {
    let body;
    if (!value) {
      body = { provider: '', model: '' };
    } else {
      const sep = value.indexOf(' ');
      body = { provider: value.slice(0, sep), model: value.slice(sep + 1) };
    }
    try {
      const response = await fetch('/api/default-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      // Reflect the saved state locally and re-render so the status hint
      // and selection update without a full reload.
      this.defaultModel = { provider: body.provider, model: body.model, explicit: !!(body.provider && body.model) };
      this.renderDefaultModelField();
    } catch (err) {
      console.error('[SettingsPanel] Failed to save default model:', err);
      if (window.showAlert) {
        await window.showAlert('Failed to save default model.', 'Error');
      }
    }
  }
}
