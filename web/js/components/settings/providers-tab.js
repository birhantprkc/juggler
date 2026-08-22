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

import { openExternalURL } from '../../../sdk/lib/window-control.js';
import wsService from '../../services/websocket.js';
import providersCache from '../../services/providers-cache.js';
import { fetchJson, httpErrorText } from '../../services/http.js';
import { showAlert, showConfirm } from '../modal-dialog.js';
import { sortModelsByVersion } from '../../utils/model-filter.js';

// Standard refresh glyph for the OAuth "re-check sign-in" button. Fill is left to
// CSS (currentColor) so it tracks the button's theme colour.
const OAUTH_REFRESH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true">' +
  '<path d="M482-160q-134 0-228-93t-94-227v-7l-64 64-56-56 160-160 160 160-56 56-64-64v7q0 100 70.5 170T482-240q26 0 51-6t49-18l60 60q-38 22-78 33t-82 11Zm278-161L600-481l56-56 64 64v-7q0-100-70.5-170T478-720q-26 0-51 6t-49 18l-60-60q38-22 78-33t82-11q134 0 228 93t94 227v7l64-64 56 56-160 160Z"/></svg>';

/**
 * "Provider API Keys" tab: one field per registered provider — OAuth (bearer),
 * keyless (toggle), or API-key (input + save/delete) — plus the OpenAI-compatible
 * gateway rows, the Ollama host, and the Claude Code binary path. Seeded from the
 * shared loadConfig() fetch; keys persist via PUT /api/config. `updateAllButtons`
 * is providers-only (despite the generic name) and is also invoked by the shell's
 * close() after its panel-wide secret-input sweep.
 */
export class ProvidersTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope and
   *   the owner of loadConfig(), which this tab calls to re-sync after a save).
   */
  constructor(host) {
    /** @type {any} @private */
    this.host = host;
    /** @type {object} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
  }

  /**
   * Receive the shared loadConfig() payload: store config/providers, (on a full
   * render) build the provider fields, and always refresh the buttons.
   * @param {{config: object, providers: any[]}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.config = data.config;
    this.providers = data.providers;
    // Generate provider form fields dynamically (only on initial load)
    if (renderFields) {
      this.renderProviderFields();
    }
    // Update all buttons and placeholders
    this.updateAllButtons();
  }

  /**
   * Render provider form fields dynamically based on available providers
   * @private
   */
  renderProviderFields() {
    const container = this.host.querySelector('#provider-fields-container');
    if (!container) return;

    // Clear existing fields
    container.innerHTML = '';

    // Generate a field for each provider
    for (const provider of this.providers) {
      if (provider.authType === 'oauth_bearer') {
        this._buildOAuthProviderField(provider, container);
        continue;
      }

      // Keyless provider (like Claude Code, Ollama) - show toggle instead of API key input
      if (provider.configKeyName === '') {
        this._buildKeylessProviderField(provider, container);
        continue;
      }

      // API key provider - show input field
      this._buildApiKeyProviderField(provider, container);
    }
  }

  /**
   * Build the field for an OAuth (bearer) provider: name, optional
   * description and a sign-in status line, with no API-key input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildOAuthProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.id = `${provider.name}-oauth-status`;
    status.style.display = 'block';
    status.textContent = provider.available
      ? (provider.authHint || 'Signed in')
      : (provider.authHint || 'Sign in to continue');
    controlColumn.appendChild(status);

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'provider-buttons';

    // Providers with an in-app sign-in (currently GitHub Copilot's device flow)
    // get Sign in / Sign out controls; others rely on the refresh button alone.
    if (provider.signInMethod === 'github_device') {
      if (provider.available) {
        const signOutBtn = document.createElement('button');
        signOutBtn.type = 'button';
        signOutBtn.className = 'settings-btn danger small';
        signOutBtn.textContent = 'Sign out';
        signOutBtn.title = 'Sign out of the GitHub login stored by Juggler';
        signOutBtn.addEventListener('click', () => this._copilotSignOut(provider, signOutBtn));
        buttonGroup.appendChild(signOutBtn);
      } else {
        const signInBtn = document.createElement('button');
        signInBtn.type = 'button';
        signInBtn.className = 'settings-btn primary small';
        signInBtn.textContent = 'Sign in with GitHub';
        signInBtn.addEventListener('click', () => this._copilotSignIn(provider, signInBtn));
        buttonGroup.appendChild(signInBtn);
      }
      // A host field lets Enterprise Cloud users point Copilot at their
      // <tenant>.ghe.com instead of the public github.com (for both editor-login
      // reuse and the in-app device sign-in).
      controlColumn.appendChild(this._buildCopilotHostField(provider));
    }

    // Every OAuth provider gets a refresh button: the login it depends on lives in
    // an external app/CLI (or another editor), so re-checking picks up a fresh or
    // expired sign-in without relaunching Juggler.
    buttonGroup.appendChild(this._buildOAuthRefreshButton(provider));
    controlColumn.appendChild(buttonGroup);

    // Which of this provider's models to offer in the model menu.
    const visibility = this._buildModelVisibilityRow(provider);
    if (visibility) controlColumn.appendChild(visibility);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the refresh (re-check sign-in) button shared by every OAuth provider.
   * @param {any} provider - Provider info object
   * @returns {HTMLButtonElement} The refresh button to append to the button group.
   * @private
   */
  _buildOAuthRefreshButton(provider) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-btn icon';
    btn.title = 'Re-check sign-in';
    btn.setAttribute('aria-label', `Re-check ${provider.displayName} sign-in`);
    btn.innerHTML = OAUTH_REFRESH_ICON;
    btn.addEventListener('click', () => this._refreshOAuthProvider(provider, btn));
    return btn;
  }

  /**
   * Re-check an OAuth provider's external login without relaunching. Asks the
   * server to recompute providers (which re-reads the CLI token file / re-probes
   * the editor login) and waits for the settled `providers-update`, then
   * re-renders this tab so the status line and Sign in/out controls reflect the
   * fresh availability. The same push reaches every model selector (they all
   * subscribe to `providers-update`), so newly-available models appear there
   * without this tab reaching across to poke them.
   * @param {any} provider
   * @param {HTMLButtonElement} button
   * @private
   */
  async _refreshOAuthProvider(provider, button) {
    const status = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-oauth-status`));
    const originalStatus = status ? status.textContent : '';
    button.disabled = true;
    button.classList.add('spinning');
    if (status) status.textContent = 'Checking sign-in\u2026';
    try {
      const fresh = await this._recheckOAuthProvider(provider.name);
      if (fresh) {
        const idx = this.providers.findIndex((p) => p.name === provider.name);
        if (idx !== -1) this.providers[idx] = fresh;
      }
      // Re-render rebuilds this button (dropping the spinning state) and the
      // status line, so no manual cleanup is needed on the success path.
      this.renderProviderFields();
      this.updateAllButtons();
    } catch (err) {
      button.disabled = false;
      button.classList.remove('spinning');
      if (status) status.textContent = originalStatus;
      await showAlert(err instanceof Error ? err.message : 'Refresh failed', provider.displayName);
    }
  }

  /**
   * Trigger a server provider refresh and resolve with the named provider's fresh
   * entry from the settled `providers-update`. Resolves with the current cached
   * list if no push arrives within the timeout, so the caller never hangs.
   * @param {string} providerName
   * @returns {Promise<any|undefined>} The provider's fresh entry, or undefined if absent.
   * @private
   */
  async _recheckOAuthProvider(providerName) {
    const next = new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout>|null} */
      let timer = null;
      /** @param {unknown} data */
      const handler = (data) => {
        if (timer) clearTimeout(timer);
        wsService.off('providers-update', handler);
        resolve(Array.isArray(data) ? data : this.providers);
      };
      wsService.on('providers-update', handler);
      timer = setTimeout(() => {
        wsService.off('providers-update', handler);
        resolve(this.providers);
      }, 4000);
    });
    await providersCache.refresh();
    const list = /** @type {any[]} */ (await next);
    return list.find((p) => p.name === providerName);
  }

  /**
   * Build the "GitHub host" field for a device-flow provider. Enterprise Cloud
   * users enter their `<tenant>.ghe.com`; everyone else leaves the default
   * `github.com`. Prefilled from the saved host and, on change, persisted (which
   * re-checks the provider so an editor login on that host is picked up).
   * @param {any} provider
   * @returns {HTMLElement} The host field wrapper.
   * @private
   */
  _buildCopilotHostField(provider) {
    const wrap = document.createElement('div');
    wrap.className = 'copilot-host-field';

    const inputId = `${provider.name}-host`;
    const label = document.createElement('label');
    label.className = 'copilot-host-label';
    label.setAttribute('for', inputId);
    label.textContent = 'GitHub host';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    input.className = 'settings-input small';
    input.value = 'github.com';
    input.placeholder = 'github.com or your-tenant.ghe.com';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;

    // Prefill with the saved host; the default above shows until this resolves.
    // Best-effort prefill — a failure just keeps the default host.
    fetchJson('/api/providers/copilot/host', { fallback: null })
      .then((d) => { if (d && d.success && d.host) input.value = d.host; });

    input.addEventListener('change', () => this._copilotSetHost(provider, input));

    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  /**
   * Persist the chosen GitHub host, then re-check the provider so an editor
   * Copilot login on that host is reused without relaunching.
   * @param {any} provider
   * @param {HTMLInputElement} input
   * @private
   */
  async _copilotSetHost(provider, input) {
    const host = input.value.trim() || 'github.com';
    try {
      const data = await fetchJson('/api/providers/copilot/host', { method: 'POST', body: { host } });
      if (!data?.success) throw new Error(data?.error || 'Failed to set host');
      // Re-check against the new host (rebuilds this field with the saved value).
      await this._refreshOAuthProvider(provider, this._buildOAuthRefreshButton(provider));
    } catch (err) {
      await showAlert(httpErrorText(err, 'Failed to set host'), 'GitHub Copilot');
    }
  }

  /**
   * Run the GitHub OAuth device flow: start it, open the verification page with
   * the user code (copied to the clipboard), then poll until GitHub authorizes.
   * On success re-syncs the settings panel and the model selector.
   * @param {any} provider
   * @param {HTMLButtonElement} button
   * @private
   */
  async _copilotSignIn(provider, button) {
    const status = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-oauth-status`));
    const setStatus = (/** @type {string} */ t) => { if (status) status.textContent = t; };
    const hostInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-host`));
    const host = (hostInput && hostInput.value.trim()) || 'github.com';
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Starting\u2026';
    try {
      const data = await fetchJson('/api/providers/copilot/device/start', { method: 'POST', body: { host } });
      if (!data?.success) throw new Error(data?.error || 'Failed to start sign-in');

      const { userCode, verificationUri, deviceCode, interval } = data;
      try { await navigator.clipboard.writeText(userCode); } catch { /* clipboard is best-effort */ }
      if (verificationUri) openExternalURL(verificationUri);
      button.textContent = 'Waiting\u2026';
      setStatus(`Enter code ${userCode} at ${verificationUri} (opened in your browser, copied to clipboard). Waiting for authorization\u2026`);

      await this._pollCopilotLogin(deviceCode, Number(interval) || 5, host);
      setStatus('Signed in with GitHub');
      await this._refreshAfterAuthChange(provider, true);
    } catch (err) {
      setStatus(provider.authHint || 'Sign in to continue');
      button.disabled = false;
      button.textContent = originalText;
      await showAlert(httpErrorText(err, 'Sign-in failed'), 'GitHub Copilot');
    }
  }

  /**
   * Poll the device-login endpoint until it resolves. Resolves on authorization;
   * throws on expiry, denial, error, or timeout.
   * @param {string} deviceCode
   * @param {number} interval - seconds between polls (GitHub-provided)
   * @param {string} host - GitHub host the flow was started against
   * @private
   */
  async _pollCopilotLogin(deviceCode, interval, host) {
    let delayMs = Math.max(2, interval) * 1000;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delayMs));
      const data = await fetchJson('/api/providers/copilot/device/poll', {
        method: 'POST',
        body: { deviceCode, host },
      });
      if (!data?.success) throw new Error(data?.error || 'Sign-in check failed');
      switch (data.status) {
        case 'authorized': return;
        case 'pending': break;
        case 'slow_down': delayMs += 5000; break;
        case 'expired': throw new Error('The code expired before you authorized. Please try again.');
        case 'denied': throw new Error('Access was denied on GitHub.');
        default: throw new Error('Unexpected sign-in status from GitHub.');
      }
    }
    throw new Error('Timed out waiting for authorization.');
  }

  /**
   * Sign out of the GitHub login Juggler stored (leaves any editor login alone).
   * @param {any} provider
   * @param {HTMLButtonElement} button
   * @private
   */
  async _copilotSignOut(provider, button) {
    const ok = await showConfirm(
      'Sign out of the GitHub login stored by Juggler? Copilot becomes unavailable until you sign in again (any editor Copilot login on this machine will still be used).',
      'Sign out'
    );
    if (!ok) return;
    button.disabled = true;
    try {
      const data = await fetchJson('/api/providers/copilot/signout', { method: 'POST' });
      if (!data?.success) throw new Error(data?.error || 'Sign out failed');
      await this._refreshAfterAuthChange(provider, false);
    } catch (err) {
      button.disabled = false;
      await showAlert(httpErrorText(err, 'Sign out failed'), 'GitHub Copilot');
    }
  }

  /**
   * Re-sync after a sign in/out. Optimistically flips this provider's cached
   * availability and re-renders the fields so the Sign in/out control updates
   * immediately (the backend's queued RefreshProviders broadcasts the settled
   * state shortly after via `providers-update`). Re-rendering is non-destructive:
   * API-key inputs always render empty and are reconciled by updateAllButtons.
   * That same broadcast is what puts the new provider's models in every model
   * selector, so this tab has nothing to tell them.
   * @param {any} provider
   * @param {boolean} available
   * @private
   */
  async _refreshAfterAuthChange(provider, available) {
    provider.available = available;
    provider.authHint = available ? 'Signed in with GitHub' : '';
    this.renderProviderFields();
    this.updateAllButtons();
  }

  /**
   * Build the field for a keyless provider (like Claude Code, Ollama): name,
   * optional description and an enable/disable toggle in place of an API-key
   * input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildKeylessProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const toggleWrapper = document.createElement('div');
    toggleWrapper.className = 'provider-toggle-wrapper';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = `${provider.name}-toggle`;
    toggle.className = 'provider-toggle';
    toggle.checked = provider.available;

    const toggleLabel = document.createElement('label');
    toggleLabel.setAttribute('for', toggle.id);
    toggleLabel.className = 'toggle-switch';

    toggle.addEventListener('change', async () => {
      await this.toggleProviderEnabled(provider, toggle.checked);
    });

    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(toggleLabel);
    controlColumn.appendChild(toggleWrapper);

    // Ollama: expose the daemon host so users can point at a
    // non-default (LAN / remote) Ollama instance without
    // restarting the app. Saved as the `ollama_host` raw
    // credential; backend re-fetches the model list on change.
    if (provider.name === 'ollama') {
      controlColumn.appendChild(this._buildHostRow({
        inputId: 'ollama-host-input',
        placeholder: 'http://localhost:11434',
        configField: 'ollamaHost',
        configKey: 'ollama_host',
        defaultLabel: 'http://localhost:11434',
      }));
    }

    // llama.cpp: expose the server host so users can point at a non-default
    // (LAN / remote / custom port) instance without restarting the app. The
    // same field reaches an LM Studio server, which serves this API on 1234.
    // Saved as the `llamacpp_host` raw credential; backend re-fetches the model
    // list, and each model's context window, on change.
    if (provider.name === 'llamacpp') {
      controlColumn.appendChild(this._buildHostRow({
        inputId: 'llamacpp-host-input',
        placeholder: 'http://127.0.0.1:8080',
        configField: 'llamacppHost',
        configKey: 'llamacpp_host',
        defaultLabel: 'http://127.0.0.1:8080',
      }));
    }

    // Claude Code: let users point at the `claude` CLI explicitly for obscure
    // install locations auto-detection can't reach. Saved as the
    // `claudecode_binary_path` raw credential; a non-empty save also enables
    // the provider so it becomes selectable without restarting.
    if (provider.name === 'claudecode') {
      controlColumn.appendChild(this._buildClaudeBinaryRow(provider, toggle));
    }

    // Which of this provider's models to offer in the model menu.
    const visibility = this._buildModelVisibilityRow(provider);
    if (visibility) controlColumn.appendChild(visibility);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the field for an API-key provider: name, optional "Get API Key"
   * link, the key input with save/delete buttons, active badge and source
   * hint.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildApiKeyProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const fieldId = `${provider.name}-key`;
    const saveButtonId = `${provider.name}-save`;
    const deleteButtonId = `${provider.name}-delete`;

    const nameLabel = document.createElement('label');
    nameLabel.className = 'provider-name';
    nameLabel.setAttribute('for', fieldId);
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    // "Get API Key" link
    if (provider.apiKeyURL) {
      const keyLink = document.createElement('a');
      keyLink.href = provider.apiKeyURL;
      keyLink.target = '_blank';
      keyLink.rel = 'noopener noreferrer';
      keyLink.className = 'get-api-key-link';
      keyLink.textContent = 'Get API Key \u2192';
      infoColumn.appendChild(keyLink);
    }

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = fieldId;
    input.name = provider.configKeyName;
    input.placeholder = '...';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;

    const activeBadge = document.createElement('span');
    activeBadge.id = `${provider.name}-active-badge`;
    activeBadge.className = 'provider-active-badge';
    activeBadge.style.display = 'none';
    activeBadge.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg><span>key is active</span>';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'provider-buttons';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.id = saveButtonId;
    saveButton.className = 'settings-btn primary small';
    saveButton.textContent = 'Save';
    saveButton.style.display = 'none';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.id = deleteButtonId;
    deleteButton.className = 'settings-btn danger small';
    deleteButton.textContent = 'Delete';
    deleteButton.style.display = 'none';

    // Add input event listener to update buttons
    input.addEventListener('input', () => {
      this.updateAllButtons();
    });

    // Save button handler
    saveButton.addEventListener('click', async () => {
      await this.saveProviderKey(provider, input.value.trim());
    });

    // Delete button handler
    deleteButton.addEventListener('click', async () => {
      await this.deleteProviderKey(provider);
    });

    buttonGroup.appendChild(saveButton);
    buttonGroup.appendChild(deleteButton);

    inputWrapper.appendChild(input);
    inputWrapper.appendChild(activeBadge);
    inputWrapper.appendChild(buttonGroup);

    const sourceHint = document.createElement('div');
    sourceHint.id = `${provider.name}-source`;
    sourceHint.className = 'key-source-hint';
    sourceHint.style.display = 'none';

    controlColumn.appendChild(inputWrapper);
    controlColumn.appendChild(sourceHint);

    // OpenAI-compatible: expose the gateway base URL and optional custom
    // request headers (JSON), so one provider covers any Chat-Completions
    // gateway. Saved as raw credentials; the backend re-fetches models on save.
    if (provider.name === 'openai-compatible') {
      controlColumn.appendChild(this._buildOpenAICompatRows());
    }

    // Which of this provider's models to offer in the model menu.
    const visibility = this._buildModelVisibilityRow(provider);
    if (visibility) controlColumn.appendChild(visibility);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the collapsible "which models to show" list for a provider: one
   * checkbox per model, plus a filter box.
   *
   * The stored preference is a deny-list (`models.hidden` in the global
   * settings), so a model the provider adds later shows up on its own and only
   * what the user explicitly turned off stays off. Unchecking writes the id into
   * that list; the server then flags the model `hidden` everywhere it publishes
   * the catalogue, which is what actually keeps it out of the model menu and out
   * of default/cheap-model resolution.
   *
   * The filter isn't decoration: OpenRouter publishes several hundred models, and
   * an unfiltered checkbox list of that is unusable.
   * @param {any} provider - Provider info object, including `modelsWithContext`
   * @returns {HTMLElement|null} The row to append, or null when the provider
   *   lists no models (nothing to choose between).
   * @private
   */
  _buildModelVisibilityRow(provider) {
    /** @type {Array<{id: string, displayName?: string, hidden?: boolean}>} */
    const models = Array.isArray(provider.modelsWithContext) ? provider.modelsWithContext : [];
    if (models.length === 0) return null;

    // Seeded from the published flags, then kept in step locally: a save
    // triggers a providers refresh, but the fields aren't rebuilt on that, so
    // this Set is the live truth for the summary and the checkboxes.
    const hidden = new Set(models.filter(m => m.hidden).map(m => m.id));

    const details = document.createElement('details');
    details.className = 'model-visibility';

    const summary = document.createElement('summary');
    summary.className = 'model-visibility-summary';
    details.appendChild(summary);

    const summaryLabel = document.createElement('span');
    summaryLabel.className = 'model-visibility-label';
    summaryLabel.textContent = 'Models';
    summary.appendChild(summaryLabel);

    // The count carries the state, so it's the part that stays legible when the
    // label dims — hence its own element rather than one string.
    const summaryCount = document.createElement('span');
    summaryCount.className = 'model-visibility-count';
    summary.appendChild(summaryCount);

    const updateSummary = () => {
      summaryCount.textContent = hidden.size === 0
        ? `${models.length}`
        : `${models.length - hidden.size} of ${models.length} shown`;
    };
    updateSummary();

    const status = document.createElement('div');
    status.className = 'model-visibility-status';
    status.style.display = 'none';

    const filter = document.createElement('input');
    filter.type = 'text';
    filter.className = 'settings-value-input model-visibility-filter';
    filter.placeholder = 'Filter models';
    filter.autocomplete = 'off';
    filter.setAttribute('autocorrect', 'off');
    filter.setAttribute('autocapitalize', 'off');
    filter.setAttribute('aria-label', `Filter ${provider.displayName} models`);
    filter.spellcheck = false;

    const list = document.createElement('div');
    list.className = 'model-visibility-list';

    const empty = document.createElement('div');
    empty.className = 'model-visibility-empty';
    empty.textContent = 'Nothing.';
    empty.style.display = 'none';

    /** @type {Array<{row: HTMLElement, haystack: string}>} */
    const rows = [];
    // Same lineage grouping the model menu uses, so the two lists read alike.
    for (const model of sortModelsByVersion(models)) {
      const row = document.createElement('label');
      row.className = 'model-visibility-row';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'model-visibility-check';
      box.checked = !hidden.has(model.id);

      const name = document.createElement('span');
      name.className = 'model-visibility-name';
      name.textContent = model.id;

      // Dims the name of a model that won't be offered, so the shown/hidden
      // split is readable down the list without checking every box.
      const applyRowState = () => row.classList.toggle('is-hidden', !box.checked);
      applyRowState();

      box.addEventListener('change', async () => {
        const show = box.checked;
        if (show) hidden.delete(model.id);
        else hidden.add(model.id);
        updateSummary();
        applyRowState();
        try {
          // Always send this provider's COMPLETE list. The server merges the
          // hidden map key by key, so an omitted provider keeps whatever it had
          // and re-showing the last hidden model has to be an explicit [].
          await fetchJson('/api/settings', {
            method: 'PUT',
            body: { models: { hidden: { [provider.name]: [...hidden] } } },
          });
          status.style.display = 'none';
        } catch (err) {
          // Put the checkbox back where it was: the stored list is unchanged, so
          // leaving it flipped would misreport what the model menu will do.
          if (show) hidden.add(model.id);
          else hidden.delete(model.id);
          box.checked = !show;
          updateSummary();
          applyRowState();
          status.textContent = `Couldn't save which models to show. ${httpErrorText(err)}`;
          status.style.display = '';
        }
      });

      row.appendChild(box);
      row.appendChild(name);
      list.appendChild(row);
      rows.push({ row, haystack: `${model.id} ${model.displayName || ''}`.toLowerCase() });
    }

    filter.addEventListener('input', () => {
      const query = filter.value.trim().toLowerCase();
      let matches = 0;
      for (const { row, haystack } of rows) {
        const hit = query === '' || haystack.includes(query);
        row.style.display = hit ? '' : 'none';
        if (hit) matches++;
      }
      empty.style.display = matches === 0 ? '' : 'none';
    });

    // The empty state lives inside the scroller so a filter that matches nothing
    // leaves a box saying so, rather than an empty box with a note under it.
    list.appendChild(empty);

    details.appendChild(filter);
    details.appendChild(list);
    details.appendChild(status);
    return details;
  }

  /**
   * Build the base-URL and custom-headers rows for the OpenAI-compatible
   * provider. Base URL saves as `openai_compatible_base_url`; headers save as
   * `openai_compatible_headers` (a JSON object string). Both persist via
   * /api/config on blur or Enter; empty clears the override.
   * @returns {HTMLElement} The rows wrapper to append to the control column.
   * @private
   */
  _buildOpenAICompatRows() {
    const wrapper = document.createElement('div');
    wrapper.className = 'openai-compat-rows';

    /**
     * @param {string} key - config key posted to /api/config
     * @param {string} configField - camelCase field on this.config
     * @param {string} label - visible field label
     * @param {string} placeholder - input placeholder
     * @param {(v: string) => string|null} validate - returns an error string or null
     * @returns {HTMLElement} The input row element.
     */
    const buildRow = (key, configField, label, placeholder, validate) => {
      const row = document.createElement('div');
      row.className = 'provider-subfield';

      const inputId = `openai-compat-${configField}`;

      const labelEl = document.createElement('label');
      labelEl.className = 'provider-subfield-label';
      labelEl.textContent = label;
      labelEl.setAttribute('for', inputId);
      row.appendChild(labelEl);

      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'provider-input-wrapper';

      const input = document.createElement('input');
      input.type = 'text';
      input.id = inputId;
      // Non-secret persisted value: keep visible across close/reopen (see close()).
      input.className = 'settings-value-input';
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.spellcheck = false;
      input.value = /** @type {any} */ (this.config)[configField] || '';
      inputWrapper.appendChild(input);
      row.appendChild(inputWrapper);

      const status = document.createElement('div');
      status.className = 'provider-subfield-status';
      row.appendChild(status);

      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let statusTimer;
      /**
       * @param {string} text
       * @param {'ok'|'error'|'pending'} [kind]
       */
      const setStatus = (text, kind) => {
        clearTimeout(statusTimer);
        status.textContent = text;
        if (kind) status.dataset.kind = kind; else delete status.dataset.kind;
        // Success is transient — the visible value is the real confirmation, so
        // the note fades. Errors stay until the next edit.
        if (kind === 'ok') {
          statusTimer = setTimeout(() => {
            status.textContent = '';
            delete status.dataset.kind;
          }, 2000);
        }
      };

      const save = async () => {
        const value = input.value.trim();
        if (value === (/** @type {any} */ (this.config)[configField] || '')) return;
        const err = validate(value);
        if (err) {
          setStatus(err, 'error');
          return;
        }
        setStatus('Saving…', 'pending');
        try {
          await fetchJson('/api/config', { method: 'PUT', body: { [key]: value } });
          /** @type {any} */ (this.config)[configField] = value;
          setStatus(value ? 'Saved' : 'Cleared', 'ok');
        } catch (e) {
          console.error(`[SettingsPanel] Failed to save ${key}:`, e);
          setStatus('Failed to save', 'error');
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
      return row;
    };

    wrapper.appendChild(buildRow(
      'openai_compatible_base_url', 'openaiCompatibleBaseURL',
      'Base URL', 'https://gateway.example.com/v1', () => null,
    ));
    wrapper.appendChild(buildRow(
      'openai_compatible_headers', 'openaiCompatibleHeaders',
      'Custom headers (JSON, optional)', '{"User-Agent": "my-app/1.0"}',
      (v) => {
        if (v === '') return null;
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return 'Headers must be a JSON object.';
          }
          return null;
        } catch {
          return 'Invalid JSON.';
        }
      },
    ));

    return wrapper;
  }

  /**
   * Build a host-URL input row for a keyless local-server provider (Ollama,
   * llama.cpp). Loads the current value from `this.config[configField]`; saves
   * via /api/config on blur or Enter. Empty value clears the override (falls
   * back to the env var or the server-side default).
   * @param {{inputId: string, placeholder: string, configField: string, configKey: string, defaultLabel: string}} opts
   *   inputId/placeholder for the input; configField is the /api/config field
   *   this value round-trips through; configKey is the raw credential key the
   *   PUT body posts; defaultLabel is shown when the override is cleared.
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildHostRow({ inputId, placeholder, configField, configKey, defaultLabel }) {
    // Wrapper is a no-op fragment-like div so the caller can append a
    // single child; visual layout comes from the parent `.provider-control`
    // column (`flex-direction: column; gap: 0.375rem`).
    const row = document.createElement('div');

    // Reuse the same wrapper as API-key rows so the input picks up the
    // shared border / focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    // Non-secret persisted value: keep visible across close/reopen (see close()).
    input.className = 'settings-value-input';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config)[configField] || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config)[configField] || '')) return;
      status.textContent = 'Saving…';
      try {
        await fetchJson('/api/config', { method: 'PUT', body: { [configKey]: value } });
        /** @type {any} */ (this.config)[configField] = value;
        status.textContent = value
          ? `Saved. Pointing at ${value}.`
          : `Saved. Using default (${defaultLabel}).`;
      } catch (err) {
        console.error(`[SettingsPanel] Failed to save host for ${configField}:`, err);
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

    return row;
  }

  /**
   * Build the CLI binary-path input row for the Claude Code provider. Loads the
   * current value from `this.config.claudecodeBinaryPath`; saves via /api/config
   * on blur or Enter. Empty clears the override (falls back to JUGGLER_CLAUDE_PATH
   * then auto-detection on the server). A non-empty save also enables the
   * provider so it becomes selectable without a restart.
   * @param {any} provider - Provider info object (for the enable call)
   * @param {HTMLInputElement} toggle - The provider's enable checkbox, kept in sync
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildClaudeBinaryRow(provider, toggle) {
    const row = document.createElement('div');

    // Reuse the API-key row wrapper so the input inherits the shared border /
    // focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'claudecode-binary-input';
    // Non-secret persisted value: keep visible across close/reopen (see close()).
    input.className = 'settings-value-input';
    input.placeholder = 'CLI path (leave blank for auto)';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config).claudecodeBinaryPath || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config).claudecodeBinaryPath || '')) return;
      status.textContent = 'Saving…';
      try {
        await fetchJson('/api/config', { method: 'PUT', body: { claudecode_binary_path: value } });
        /** @type {any} */ (this.config).claudecodeBinaryPath = value;
        if (value) {
          // A user pointing us at a binary means "use Claude Code" — enable it
          // (and reflect that in the toggle) so the model is immediately
          // selectable without a separate click.
          if (!toggle.checked) {
            toggle.checked = true;
            await this.toggleProviderEnabled(provider, true);
          }
          status.textContent = `Saved. Using ${value}.`;
        } else {
          status.textContent = 'Saved. Auto-detecting the claude CLI.';
        }
      } catch (err) {
        console.error('[SettingsPanel] Failed to save Claude Code binary path:', err);
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

    return row;
  }

  /**
   * Toggle enabled state for a keyless provider
   * @param {any} provider - Provider info object
   * @param {boolean} enabled - Whether to enable or disable the provider
   * @private
   */
  async toggleProviderEnabled(provider, enabled) {
    try {
      await fetchJson('/api/config/provider-enabled', {
        method: 'POST',
        body: { provider: provider.name, enabled },
        errorPrefix: 'Failed to update provider',
      });
      // The handler queues a provider recompute; the resulting providers-update
      // is what refreshes every model selector.
    } catch (error) {
      console.error('Failed to toggle provider:', error);
      // Revert toggle on error
      const toggle = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-toggle`));
      if (toggle) {
        toggle.checked = !enabled;
      }
      await showAlert(error instanceof Error ? error.message : 'Failed to update provider', 'Error');
    }
  }

  /**
   * Update all provider buttons and placeholders based on current state
   * @private
   */
  updateAllButtons() {
    const configObj = /** @type {any} */ (this.config);

    for (const provider of this.providers) {
      const hasKey = configObj.keys?.[provider.name] || false;
      const input = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-key`));
      const saveButton = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-save`));
      const deleteButton = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-delete`));
      const sourceHint = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-source`));
      const activeBadge = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-active-badge`));

      const inputHasValue = !!(input && input.value.trim() !== '');

      // Update placeholder based on key source
      if (input) {
        if (provider.keySource === 'env') {
          input.placeholder = `using $${provider.envVarName}`;
          input.disabled = true;
        } else if (hasKey) {
          input.placeholder = '';
          input.disabled = false;
        } else {
          input.placeholder = 'enter a key';
          input.disabled = false;
        }
      }

      // Show "key is active" badge when a credentials-file key exists and the
      // input is empty (i.e. user isn't currently typing a replacement).
      if (activeBadge) {
        const showBadge = hasKey && provider.keySource !== 'env' && !inputHasValue;
        activeBadge.style.display = showBadge ? 'inline-flex' : 'none';
      }

      // Update source hint
      if (sourceHint) {
        if (provider.keySource === 'env') {
          sourceHint.textContent = `Using environment variable $${provider.envVarName}`;
          sourceHint.style.display = 'block';
        } else {
          sourceHint.textContent = '';
          sourceHint.style.display = 'none';
        }
      }

      // Show save button only if input has value and key is not from env var
      if (saveButton) {
        const hasInputValue = input && input.value.trim() !== '';
        saveButton.style.display = (hasInputValue && provider.keySource !== 'env') ? 'block' : 'none';
      }

      // Show delete button only if key exists in credentials file (not env var)
      if (deleteButton) {
        deleteButton.style.display = (hasKey && provider.keySource !== 'env') ? 'block' : 'none';
      }
    }
  }

  /**
   * Save API key for a specific provider
   * @param {any} provider - Provider info object
   * @param {string} apiKey - API key to save
   * @returns {Promise<void>} Completes when the API key is saved
   * @private
   */
  async saveProviderKey(provider, apiKey) {
    if (!apiKey) return;

    try {
      await fetchJson('/api/config', {
        method: 'PUT',
        body: { [provider.configKeyName]: apiKey },
        errorPrefix: 'Failed to save API key',
      });

      // Clear the input so the UI returns to the "key is active" state
      const input = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-key`));
      if (input) input.value = '';

      // Reload config from server to get actual state (don't re-render fields)
      await this.host.loadConfig(false);
      // PUT /api/config queues a provider recompute of its own; the resulting
      // providers-update is what refreshes every model selector.
    } catch (error) {
      console.error('Failed to save API key:', error);
      await showAlert(error instanceof Error ? error.message : 'Failed to save API key', 'Error');
    }
  }

  /**
   * Delete API key for a specific provider
   * @param {any} provider - Provider info object
   * @private
   */
  async deleteProviderKey(provider) {
    try {
      // Send empty string to delete the key
      await fetchJson('/api/config', {
        method: 'PUT',
        body: { [provider.configKeyName]: '' },
        errorPrefix: 'Failed to delete API key',
      });

      // Reload config from server to get actual state (don't re-render fields)
      await this.host.loadConfig(false);
      // PUT /api/config queues a provider recompute of its own; the resulting
      // providers-update is what drops the key from every model selector.
    } catch (error) {
      console.error('Failed to delete API key:', error);
      await showAlert(error instanceof Error ? error.message : 'Failed to delete API key', 'Error');
    }
  }
}
