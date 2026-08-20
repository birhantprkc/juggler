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
import { buildToggleRow } from './notifications-tab.js';
import { isDefaultFileEditingOn, setDefaultFileEditingOn } from '../../services/file-editing-permission.js';
import { setAutoNameEnabledCached } from '../../services/auto-name-setting.js';
import strategyRegistry from '../../registries/strategy-registry.js';
import { getDefaultStrategyId, setDefaultStrategyId, BUILTIN_DEFAULT_STRATEGY_ID } from '../../services/default-strategy.js';
import { fetchJson } from '../../services/http.js';
import { showAlert } from '../modal-dialog.js';

/**
 * "Defaults" tab (id `defaults`): the default-model and cheap-model pickers, the
 * global stream-idle-timeout field, and the new-conversation defaults. Seeded from the
 * shared loadConfig() fetch; the picker persists immediately via PUT
 * /api/default-model and the timeout via PUT /api/config.
 */
export class DefaultsTab {
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
    /** @type {{provider: string, model: string, thinking?: string, explicit?: boolean}} @private - Model new conversations are seeded with; explicit=false means automatic. thinking empty ⇒ the model's default level. */
    this.defaultModel = { provider: '', model: '', explicit: false };
    /** @type {{provider?: string, model?: string, thinking?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} @private - Cheap model for out-of-band micro-tasks; explicit=false means Auto. */
    this.cheapModel = { explicit: false };
  }

  /**
   * Receive the shared loadConfig() payload: store config/providers/defaultModel
   * and (on a full render) build the fields.
   * @param {{config: object, providers: any[], defaultModel: {provider: string, model: string, thinking?: string, explicit?: boolean}, cheapModel?: {provider?: string, model?: string, thinking?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.config = data.config;
    this.providers = data.providers;
    this.defaultModel = data.defaultModel;
    if (data.cheapModel) this.cheapModel = data.cheapModel;
    // Keep the client-side auto-naming cache in step with the server on every
    // config load, so the conversation bar's new-tab decision stays current even
    // when the settings panel isn't rendering fields.
    setAutoNameEnabledCached(!(/** @type {any} */ (this.config).autoNameDisabled));
    if (renderFields) {
      this.renderGlobalSettings();
      this.renderDefaultModelField();
      this.renderCheapModelField();
      this.renderAutoNameSettings();
      this.renderNewConversationDefaults();
    }
  }

  /**
   * Resolve the currently attached UI session (for reading/writing per-project
   * new-conversation defaults). Null when no session is attached (e.g. settings opened
   * before a project loads).
   * @returns {import('../../model/session.js').default|null} The active session, or null.
   * @private
   */
  _getSession() {
    return /** @type {any} */ (window).jugglerApp?._connectionManager?.getSession?.() || null;
  }

  /**
   * Render the "New conversation defaults" section: per-project defaults applied to each
   * newly created conversation — the strategy a conversation starts on, and whether it starts
   * with edits allowed instead of asking. Persisted to session metadata, so they
   * survive restarts and are shared across windows on the same project.
   * @private
   */
  renderNewConversationDefaults() {
    const container = this.host.querySelector('#new-conversation-defaults-form');
    if (!container) return;
    container.innerHTML = '';

    container.appendChild(this._buildDefaultStrategyRow());

    const { row } = buildToggleRow(
      'Allow file edits in new conversations',
      'Start each new conversation with file editing already allowed, so the agent can edit ' +
      'without asking first — handy when your project is in version control. Each conversation ' +
      'can still be toggled individually, and edits outside the project and allowed ' +
      'paths always prompt.',
      isDefaultFileEditingOn(this._getSession()),
      (on) => setDefaultFileEditingOn(this._getSession(), on),
    );
    container.appendChild(row);
  }

  /**
   * Render the "Conversation auto-naming" section as a single card: the global on/off
   * switch with an optional custom instruction stacked beneath it, shown only
   * while auto-naming is on. Both persist to credentials.json via PUT
   * /api/config; the server reads them live for the next naming attempt. When
   * on (the default), a new conversation keeps its "Untitled N" name and the composer takes
   * focus, and the cheap model derives a title after the first message; when
   * off, the new conversation opens its inline rename editor instead and no title is
   * auto-derived.
   * @private
   */
  renderAutoNameSettings() {
    const container = this.host.querySelector('#auto-name-form');
    if (!container) return;
    container.innerHTML = '';

    // The optional custom instruction, built first so the toggle's handler can
    // reveal or hide it. It shares the toggle's card (appended into the same
    // control column below), so the switch and the prompt it shapes read as one
    // grouped setting rather than two separate rows.
    const instruction = this._buildAutoNameInstructionControl();
    instruction.hidden = !!(/** @type {any} */ (this.config).autoNameDisabled);

    // On/off switch. Checked = enabled; we persist the *disabled* bool so the
    // stored key is absent by default (default-on).
    const { row, input: toggleInput } = buildToggleRow(
      'Auto-name new conversations',
      'Uses the cheap model to name each new conversation, based on your first message. ' +
      'Turn this off to name new conversations yourself.',
      !(/** @type {any} */ (this.config).autoNameDisabled),
      async (on) => {
        const previous = toggleInput.checked;
        try {
          await fetchJson('/api/config', { method: 'PUT', body: { auto_name_disabled: !on } });
          /** @type {any} */ (this.config).autoNameDisabled = !on;
          setAutoNameEnabledCached(on);
          // The instruction only shapes an auto-derived title, so hide it while
          // auto-naming is off; the stored value is kept and reappears on re-enable.
          instruction.hidden = !on;
        } catch (e) {
          console.error('[SettingsPanel] Failed to save auto-naming setting:', e);
          toggleInput.checked = !previous;
        }
      },
    );

    // Stack the instruction beneath the switch in the toggle's own control
    // column, so both controls live in a single card.
    row.querySelector('.provider-control')?.appendChild(instruction);
    container.appendChild(row);
  }

  /**
   * Build the custom auto-name instruction control: a labelled textarea whose
   * text overrides the built-in title instruction sent to the cheap model (the
   * customisable half of the naming prompt; the fixed "message is data" guard is
   * appended server-side and not shown). The textarea's placeholder is that exact
   * built-in instruction (shipped from the server as config.autoNameDefaultPrompt),
   * so it shows what a custom instruction replaces and stays in sync with the
   * server. Blank restores the built-in instruction. Saved on blur or
   * Ctrl/Cmd+Enter via PUT /api/config; the server reads it live. Returned as a
   * plain block (not its own `.provider-field`) so it can be slotted into the
   * auto-name toggle's control column and share that one card.
   * @returns {HTMLElement} The instruction block element.
   * @private
   */
  _buildAutoNameInstructionControl() {
    const wrap = document.createElement('div');
    wrap.className = 'auto-name-instruction';

    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent =
      'A custom instruction for the naming model, replacing the built-in one ' +
      'shown here. Leave blank for the default. Whatever you write, your first ' +
      'message is always treated as data to summarise into a title, never a ' +
      'request to answer.';
    wrap.appendChild(description);

    const textarea = document.createElement('textarea');
    textarea.id = 'auto-name-instruction-input';
    textarea.className = 'settings-value-input';
    textarea.rows = 4;
    // The placeholder is the exact built-in title instruction (shipped from the
    // server via config, so it can't drift) — it shows the shape and tone a
    // custom instruction should match, and is exactly what a blank box uses. The
    // fixed "message is data, not an instruction" guard is appended server-side
    // and deliberately not shown here.
    textarea.placeholder = /** @type {any} */ (this.config).autoNameDefaultPrompt || '';
    textarea.autocomplete = 'off';
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.spellcheck = false;
    textarea.value = /** @type {any} */ (this.config).autoNameInstruction || '';

    const status = document.createElement('div');
    status.className = 'key-source-hint';

    const save = async () => {
      const value = textarea.value.trim();
      if (value === (/** @type {any} */ (this.config).autoNameInstruction || '')) return;
      status.textContent = 'Saving…';
      try {
        await fetchJson('/api/config', { method: 'PUT', body: { auto_name_instruction: value } });
        /** @type {any} */ (this.config).autoNameInstruction = value;
        status.textContent = value ? 'Saved custom instruction.' : 'Saved. Using the built-in prompt.';
      } catch (e) {
        console.error('[SettingsPanel] Failed to save auto-name instruction:', e);
        status.textContent = 'Failed to save.';
      }
    };

    textarea.addEventListener('blur', save);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
        textarea.blur();
      }
    });

    wrap.appendChild(textarea);
    wrap.appendChild(status);
    return wrap;
  }

  /**
   * Build the "Default strategy for new conversations" picker row: a dropdown of every
   * registered strategy (in the registry's display order), preselecting the
   * configured default, or the built-in Default strategy when none is pinned.
   * Changing it persists immediately to session metadata; the pin is cleared
   * when the built-in Default is chosen. Each conversation can still switch strategy
   * afterwards — this only sets what a fresh conversation starts on.
   * @returns {HTMLElement} The settings row element.
   * @private
   */
  _buildDefaultStrategyRow() {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Default strategy for new conversations';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent =
      'The strategy each new conversation starts on. You can still switch strategy per ' +
      'conversation afterwards.';
    infoColumn.appendChild(name);
    infoColumn.appendChild(desc);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'default-model-select';
    select.id = 'default-strategy-select';

    const configured = getDefaultStrategyId(this._getSession());
    const manifests = strategyRegistry.getAllManifests();
    // A configured pin whose strategy is no longer registered (disabled/removed)
    // — surface it as a selected "unavailable" option so the state stays visible
    // rather than silently snapping to the built-in Default.
    const configuredIsRegistered = !configured
      || manifests.some((/** @type {{id: string}} */ m) => m.id === configured);

    for (const { id, manifest } of manifests) {
      const opt = document.createElement('option');
      opt.value = id;
      // The built-in Default is the "no pin" choice: label it so, and select it
      // when nothing (or 'default') is configured.
      opt.textContent = id === BUILTIN_DEFAULT_STRATEGY_ID
        ? `${manifest.name} (built-in default)`
        : manifest.name;
      if (configuredIsRegistered
        ? (configured ? id === configured : id === BUILTIN_DEFAULT_STRATEGY_ID)
        : false) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    if (!configuredIsRegistered && configured) {
      const opt = document.createElement('option');
      opt.value = configured;
      opt.textContent = `${configured} — unavailable`;
      opt.selected = true;
      select.insertBefore(opt, select.firstChild);
    }

    select.addEventListener('change', () => {
      setDefaultStrategyId(this._getSession(), select.value);
    });

    controlColumn.appendChild(select);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    return row;
  }

  /**
   * Render global settings that apply across every provider, shown as a section
   * on the Defaults tab: the automatic-compaction on/off switch and the stream
   * idle timeout (the window a streaming provider waits for the next event
   * before declaring the connection dead, "stream stalled: no data for 3m0s";
   * raising it helps gateways whose cold starts exceed the 180s default). Both
   * persist to credentials.json via PUT /api/config; the server reads them live.
   * @private
   */
  renderGlobalSettings() {
    const container = this.host.querySelector('#global-settings');
    if (!container) return;
    container.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = 'Context';
    container.appendChild(heading);

    // Automatic compaction on/off. Checked = enabled; we persist the *disabled*
    // bool so the stored key is absent by default (default-on). The honest
    // second sentence discloses the "fully off" consequence to the person
    // deliberately flipping the switch.
    const { row: autoCompactRow, input: autoCompactInput } = buildToggleRow(
      'Automatic compaction',
      'When a conversation nears the model\u2019s context limit, Juggler summarizes ' +
      'older turns to make room. Turn this off to keep full transcripts \u2014 long ' +
      'conversations may then hit the model\u2019s limit and error.',
      !(/** @type {any} */ (this.config).autoCompactDisabled),
      async (on) => {
        const previous = autoCompactInput.checked;
        try {
          await fetchJson('/api/config', { method: 'PUT', body: { auto_compact_disabled: !on } });
          /** @type {any} */ (this.config).autoCompactDisabled = !on;
        } catch (e) {
          console.error('[SettingsPanel] Failed to save automatic compaction setting:', e);
          autoCompactInput.checked = !previous;
        }
      },
    );
    container.appendChild(autoCompactRow);

    const timeoutHeading = document.createElement('div');
    timeoutHeading.className = 'settings-section-heading';
    timeoutHeading.textContent = 'Stream idle timeout';
    container.appendChild(timeoutHeading);

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
        await fetchJson('/api/config', { method: 'PUT', body: { stream_idle_timeout: value } });
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
      onSave: (value, thinking) => this._saveDefaultModel(value, thinking),
      withThinking: true,
    });
  }

  /**
   * Render the "Cheap model" picker: the small/fast model used for out-of-band
   * micro-tasks (auto-naming a conversation, plugin generateText). Offers an "Auto"
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
        'conversation. "Auto" derives one from the model in use.',
      autoLabel: 'Auto',
      current: this.cheapModel || { explicit: false },
      statusText: (ref) => this._cheapModelStatusText(ref),
      onSave: (value, thinking) => this._saveCheapModel(value, thinking),
      withThinking: true,
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
   * @param {{provider?: string, model?: string, thinking?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} opts.current
   * @param {(ref: any) => string} opts.statusText - builds the status hint.
   * @param {(value: string, thinking?: string) => void} opts.onSave - persists "<provider> <model>" or "", plus an optional thinking level.
   * @param {boolean} [opts.withThinking] - also render a thinking-level selector for the chosen model.
   * @private
   */
  _renderModelField({ containerId, selectId, nameLabel, description, autoLabel, current, statusText, onSave, withThinking }) {
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

    // Optional thinking-level selector: a second dropdown shown only when the
    // chosen model advertises thinking levels. An empty value ⇒ the model's
    // default level. Levels are model-specific, so switching model resets it.
    /** @type {HTMLSelectElement|null} */
    let thinkingSelect = null;
    const modelEntryFor = (/** @type {string} */ value) => {
      if (!value) return null;
      const sep = value.indexOf(' ');
      const provName = value.slice(0, sep);
      const modelId = value.slice(sep + 1);
      const p = this.providers.find((/** @type {any} */ pp) => pp.name === provName);
      if (!p || !p.modelsWithContext) return null;
      return p.modelsWithContext.find((/** @type {{id: string}} */ m) => m.id === modelId) || null;
    };
    const rebuildThinkingOptions = (/** @type {string} */ value, /** @type {string} */ selectedThinking) => {
      if (!thinkingSelect) return;
      const entry = modelEntryFor(value);
      const levels = (entry && entry.thinkingLevels) || [];
      thinkingSelect.innerHTML = '';
      if (levels.length === 0) {
        thinkingSelect.style.display = 'none';
        return;
      }
      thinkingSelect.style.display = '';
      const def = entry.defaultThinkingLevel || '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = def ? `Default thinking (${def})` : 'Default thinking';
      if (!selectedThinking) defaultOpt.selected = true;
      thinkingSelect.appendChild(defaultOpt);
      for (const lvl of levels) {
        const opt = document.createElement('option');
        opt.value = lvl;
        opt.textContent = `Thinking: ${lvl}`;
        if (lvl === selectedThinking) opt.selected = true;
        thinkingSelect.appendChild(opt);
      }
    };
    if (withThinking) {
      const ts = document.createElement('select');
      ts.className = 'default-model-select default-model-thinking-select';
      ts.id = `${selectId}-thinking`;
      ts.setAttribute('aria-label', `Thinking level for ${nameLabel}`);
      ts.addEventListener('change', () => onSave(select.value, ts.value));
      thinkingSelect = ts;
      rebuildThinkingOptions(currentValue, (explicit && ref.thinking) || '');
    }

    select.addEventListener('change', () => {
      if (thinkingSelect) rebuildThinkingOptions(select.value, '');
      onSave(select.value, thinkingSelect ? thinkingSelect.value : undefined);
    });

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = statusText(ref);

    controlColumn.appendChild(select);
    if (thinkingSelect) controlColumn.appendChild(thinkingSelect);
    controlColumn.appendChild(status);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    container.appendChild(row);
  }

  /**
   * Persist the chosen cheap model. An empty value clears it (Auto).
   * @param {string} value - "<provider> <model>" or "" for Auto
   * @param {string} [thinking] - thinking level; empty/omitted ⇒ the model's default
   * @private
   */
  async _saveCheapModel(value, thinking) {
    /** @type {{provider: string, model: string, thinking?: string}} */
    let body;
    if (!value) {
      body = { provider: '', model: '' };
    } else {
      const sep = value.indexOf(' ');
      body = { provider: value.slice(0, sep), model: value.slice(sep + 1) };
      if (thinking) body.thinking = thinking;
    }
    try {
      await fetchJson('/api/cheap-model', { method: 'PUT', body });
      // Reflect the saved state locally. When cleared to Auto, re-fetch so the
      // auto-derived hint under the combo box refreshes; otherwise update in place.
      if (body.provider && body.model) {
        this.cheapModel = { provider: body.provider, model: body.model, thinking: body.thinking || '', explicit: true };
        this.renderCheapModelField();
      } else {
        this.cheapModel = await fetchJson('/api/cheap-model', { fallback: null }) || { explicit: false };
        this.renderCheapModelField();
      }
    } catch (err) {
      console.error('[SettingsPanel] Failed to save cheap model:', err);
      await showAlert('Failed to save cheap model.', 'Error');
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
   * @param {string} [thinking] - thinking level; empty/omitted ⇒ the model's default
   * @private
   */
  async _saveDefaultModel(value, thinking) {
    /** @type {{provider: string, model: string, thinking?: string}} */
    let body;
    if (!value) {
      body = { provider: '', model: '' };
    } else {
      const sep = value.indexOf(' ');
      body = { provider: value.slice(0, sep), model: value.slice(sep + 1) };
      if (thinking) body.thinking = thinking;
    }
    try {
      await fetchJson('/api/default-model', { method: 'PUT', body });
      // Reflect the saved state locally and re-render so the status hint
      // and selection update without a full reload.
      this.defaultModel = { provider: body.provider, model: body.model, thinking: body.thinking || '', explicit: !!(body.provider && body.model) };
      this.renderDefaultModelField();
    } catch (err) {
      console.error('[SettingsPanel] Failed to save default model:', err);
      await showAlert('Failed to save default model.', 'Error');
    }
  }
}
