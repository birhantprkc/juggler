//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { presentPopup } from '../utils/popup-surface.js';
import wsService from '../services/websocket.js';
import providersCache from '../services/providers-cache.js';
import usageStatsCache from '../services/usage-stats-cache.js';
import recentModels from '../services/recent-models.js';
import { getRecommendedModels, sortModelsByVersion } from '../utils/model-filter.js';
import { resolveConfig } from '../model/model-config.js';
import { modelLabel, modelLabelFromList } from '../model/model-display.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { formatTokens } from '../utils/format.js';

/** Usage snapshots older than this are blanked while refreshing rather than shown. */
const USAGE_STALE_MS = 5 * 60 * 1000;

/** localStorage key holding the per-provider list view-state override map. */
const VIEW_STATE_STORAGE_KEY = 'juggler-model-view-state';

/** The list view-states a provider header toggle cycles through. */
const VIEW_STATES = ['none', 'top', 'all'];

/** Canonical thinking levels in display order. */
const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

/**
 * Full labels for the popup segmented control.
 * @type {Record<string, string>}
 */
const THINKING_LABELS = { off: 'Off', low: 'Low', medium: 'Med', high: 'High', max: 'Max' };

/**
 * Compact labels for the model-button chip (kept short so the button stays narrow).
 * @type {Record<string, string>}
 */
const THINKING_CHIP = { off: 'off', low: 'low', medium: 'med', high: 'high', max: 'max' };

/**
 * Model selector component with provider and model dropdown menu
 * @typedef {object} ModelInfo
 * @property {string} id - Model ID
 * @property {number} contextWindow - Context window size
 * @property {string} [displayName] - Provider-supplied human label, when the provider exposes one
 * @property {string[]} [thinkingLevels] - Canonical thinking levels the model supports; absent/empty ⇒ no thinking control
 * @property {string} [defaultThinkingLevel] - Level used when a turn carries none (presentation only)
 * @typedef {object} Provider
 * @property {string} name - Provider name (e.g., "anthropic")
 * @property {string} displayName - Display name (e.g., "Anthropic (API)")
 * @property {boolean} available - Whether provider credentials are configured
 * @property {string} [authType] - Provider credential type
 * @property {string} [authHint] - Provider auth/status hint
 * @property {ModelInfo[]} modelsWithContext - Models with context window info
 */

class ModelSelector extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.provider = 'Loading...';
    /** @type {string} @private */
    this.model = '';
    /** @type {Provider[]} @private */
    this.providers = [];
    /** @type {boolean} @private */
    this.dropdownOpen = false;
    /** @type {string|null} @private */
    this.connectionStatus = null; // 'error', 'disconnected', 'connecting', or null for connected
    /** @type {boolean} @private */
    this.loadingProviders = false;
    /** @type {import('../model/conversation.js').default|null} @private */
    this.conversation = null;
    /** @type {(() => void)|null} @private - presentPopup release for the open dropdown. */
    this._popupRelease = null;
    /**
     * This selector's own dropdown while open (relocated to <body>), else null.
     * Instance-scoped so updates/teardown never touch a sibling's surface:
     * multiple selectors coexist (root + each open sub-thread column) and all
     * share the `[data-model-selector="true"]` attribute, so a document-wide
     * query would grab the wrong one.
     * @type {HTMLElement|null} @private
     */
    this._liveDropdown = null;
    /** @type {import('../services/websocket.js').WSEventCallback|null} @private */
    this._providersUpdateHandler = null;
    /**
     * Per-provider list view state: how many of a provider's models the list
     * column shows. Tri-state, cycled from the toggle in each provider's header:
     * 'none' (collapsed, no rows) → 'top' (recommended shortlist) → 'all' (full
     * list). Unset defaults to 'top' for providers with a shortlist, else 'all'.
     * Seeded from (and persisted to) localStorage as a sparse map of user
     * overrides — untouched providers stay absent and fall back to the default.
     * @type {Record<string, 'none'|'top'|'all'>} @private
     */
    this.providerViewState = this._loadViewState();
    /** @type {import('../model/message-thread.js').default|null} @private */
    this._messageThread = null;
    /** @type {*} @private */
    this._currentConfig = null;
    /** @type {boolean} @private - True while a usage-stats fetch is in flight. */
    this._usageLoading = false;
    /** @type {string|null} @private - Last list-column HTML written, for non-destructive updates. */
    this._lastListHTML = null;
    /** @type {string|null} @private - Last info-column HTML written, for non-destructive updates. */
    this._lastInfoHTML = null;
  }

  connectedCallback() {
    this.render();
    this.fetchProviders();

    // Listen for incremental provider updates from WebSocket
    this._providersUpdateHandler = (/** @type {unknown} */ data) => {
      this.providers = /** @type {Provider[]} */ (data);
      if (this.dropdownOpen) {
        this._updateDropdownContent();
      }
      this._syncModelDisplay();
      // The collapsed button's label is resolved from the providers list (to map
      // the model id to its display name), so a push that first supplies those
      // names must re-render it — even when provider/model are unchanged. Without
      // this, setModel() short-circuits on the equal id and the button keeps
      // showing the raw model id from the pre-compute connect seed until the
      // dropdown is opened. Skipped while open: _updateDropdownContent already ran.
      if (!this.dropdownOpen) {
        this.render();
      }
    };
    wsService.on('providers-update', this._providersUpdateHandler);
  }

  disconnectedCallback() {
    // Tear down the open dropdown (surface, scrim, observer, dismissal wiring).
    if (this._popupRelease) {
      this._popupRelease();
      this._popupRelease = null;
    }
    // Clean up WebSocket listener
    if (this._providersUpdateHandler) {
      wsService.off('providers-update', this._providersUpdateHandler);
    }
    // Clean up this instance's dropdown if it was moved to document.body.
    if (this._liveDropdown) {
      this._liveDropdown.remove();
      this._liveDropdown = null;
    }
  }

  /**
   * Set the message thread this model selector is bound to.
   * Updates display with the thread's effective model config.
   * @param {import('../model/message-thread.js').default|null} messageThread
   */
  setMessageThread(messageThread) {
    this._messageThread = messageThread;
    this._syncModelDisplay();
  }

  /**
   * Set the conversation this model selector is bound to
   * @param {import('../model/conversation.js').default|null} conversation
   */
  setConversation(conversation) {
    this.conversation = conversation;
    this._syncModelDisplay();
  }

  /**
   * Sync the model display with the current thread/conversation state.
   * @private
   */
  _syncModelDisplay() {
    const config = this._getEffectiveConfig();
    this._currentConfig = config;
    this.setModel(config?.provider || '', config?.model || '');
    if (this.dropdownOpen) this._updateDropdownContent();
  }

  /**
   * Get the effective model config from thread or conversation
   * @returns {*} The active model config
   * @private
   */
  _getEffectiveConfig() {
    if (this._messageThread) {
      return this._messageThread.modelConfig;
    }
    if (this.conversation) {
      return this.conversation.modelConfig;
    }
    return null;
  }

  /** @private */
  async fetchProviders() {
    // If the cache already has data, use it synchronously to avoid a render
    // with the loading state. Otherwise show loading and wait for the
    // first push.
    if (providersCache.hasReceived()) {
      this.providers = providersCache.get();
      this.loadingProviders = false;
      if (this.dropdownOpen) {
        this._updateDropdownContent();
      } else {
        this.render();
      }
      return;
    }

    this.loadingProviders = true;
    this.render();
    this.providers = await providersCache.waitForFirst();
    this.loadingProviders = false;
    if (this.dropdownOpen) {
      this._updateDropdownContent();
    } else {
      this.render();
    }
  }

  /**
   * Refresh provider list from server (public API)
   */
  async refresh() {
    await providersCache.refresh();
  }

  /**
   * Re-sync the dropdown from the cache. The WS push subscriber already
   * keeps `this.providers` fresh; this just covers the case where the
   * cache was populated after fetchProviders() ran but before the menu
   * was opened.
   * @private
   */
  _refreshProvidersInBackground() {
    const fresh = providersCache.get();
    if (JSON.stringify(fresh) !== JSON.stringify(this.providers)) {
      this.providers = fresh;
      if (this.dropdownOpen) {
        this._updateDropdownContent();
      }
    }
  }

  /**
   * @param {string} provider
   * @param {string} model
   */
  setModel(provider, model) {
    if (this.provider === provider && this.model === model) {
      return;
    }
    this.provider = provider;
    this.model = model;
    this.render();
  }

  /**
   * Set connection status to display
   * @param {string|null} status - 'error', 'disconnected', 'connecting', or null for connected
   */
  setConnectionStatus(status) {
    if (this.connectionStatus === status) {
      return;
    }
    this.connectionStatus = status;
    this.render();
  }

  /** @private */
  toggleDropdown() {
    if (this.dropdownOpen) {
      this.closeDropdown();
      return;
    }
    this.dropdownOpen = true;
    this.render();

    // Ask the server to re-check external provider state. This catches
    // cases like `codex login` completing while Juggler is already open;
    // the fresh list arrives asynchronously via providers-update.
    this.refresh().catch(err => console.warn('[ModelSelector] Failed to refresh providers:', err));

    // Silently sync providers from cache in background (self-healing if initial fetch failed)
    this._refreshProvidersInBackground();

    // Refresh account/plan usage for the info column. The cache debounces
    // to one live call per 10s, so repeated opens are cheap.
    this._refreshUsageStats();

    // Reload server-persisted recent models, then re-render the info column
    // (which hosts the "Recent" section) when the fresh list arrives.
    recentModels.refresh().then(() => {
      if (this.dropdownOpen) this._updateInfoColumn();
    }).catch(() => {});

    // Present the dropdown once rendered. presentPopup owns body-append,
    // dismissal wiring, the reposition observer, and the anchored-vs-sheet
    // decision; we only attach the delegated list listener (which survives the
    // menu's innerHTML replacements) before handing the surface over.
    requestAnimationFrame(() => {
      const dropdown = /** @type {HTMLElement|null} */(this.querySelector('.provider-dropdown'));
      const button = /** @type {HTMLElement|null} */(this.querySelector('.model-selector-button'));
      if (!dropdown || !button) return;
      dropdown.setAttribute('data-model-selector', 'true');
      this._liveDropdown = dropdown;
      this._attachDropdownListener(dropdown);
      this._popupRelease = presentPopup({
        surface: dropdown,
        anchor: button,
        id: 'model-selector',
        onClose: () => this.closeDropdown(),
        align: 'left',
        gap: 8,
        insideSelectors: ['model-selector', '.provider-dropdown[data-model-selector="true"]'],
      });
    });
  }

  /**
   * Update dropdown content in place (when it's already open in document.body).
   * Refreshes both columns: the info/actions column and the scrolling model
   * list. The two are updated independently so a stats refresh never disturbs
   * the list's scroll position (and vice versa).
   * @private
   */
  _updateDropdownContent() {
    const dropdown = this._liveDropdown;
    if (!dropdown) return;

    this._updateInfoColumn(dropdown);

    // The model list lives in its own scrolling column. Rewrite it only when
    // the generated markup actually changed: an unrelated trigger (an LLM
    // message arriving re-syncs the bound conversation) would otherwise
    // replace identical innerHTML and reset the user's scroll position to
    // the top. The list depends solely on providers/selection, so the guard
    // skips that churn.
    const menu = dropdown.querySelector('.model-menu-list > menu');
    if (menu) {
      const html = this._generateModelListContent();
      if (html !== this._lastListHTML) {
        menu.innerHTML = html;
        this._lastListHTML = html;
      }
    }
  }

  /**
   * Re-render just the non-scrolling info column (actions, current model,
   * usage stats). Used both on full updates and after a usage fetch resolves.
   * Skips the write when the markup is unchanged, matching the list column's
   * non-destructive update.
   * @private
   * @param {Element|null} [dropdownEl] - Optional already-resolved dropdown root.
   */
  _updateInfoColumn(dropdownEl) {
    const dropdown = dropdownEl || this._liveDropdown;
    if (!dropdown) return;
    const info = dropdown.querySelector('.model-menu-info');
    if (info) {
      const html = this._generateInfoColumn();
      if (html !== this._lastInfoHTML) {
        info.innerHTML = html;
        this._lastInfoHTML = html;
      }
    }
  }

  /**
   * Refresh provider usage stats (debounced in the cache) and re-render the
   * info column when the fetch settles. Shows a transient loading state while
   * the first snapshot is pending.
   * @private
   */
  async _refreshUsageStats() {
    this._usageLoading = true;
    this._updateInfoColumn();
    try {
      await usageStatsCache.refresh();
    } finally {
      this._usageLoading = false;
      if (this.dropdownOpen) this._updateInfoColumn();
    }
  }

  /**
   * Read the persisted per-provider view-state overrides, tolerant of a
   * missing or corrupt blob. Only recognised states are kept, so a stale or
   * hand-edited value can never poison the map.
   * @private
   * @returns {Record<string, 'none'|'top'|'all'>} provider name → view state.
   */
  _loadViewState() {
    try {
      const raw = JSON.parse(localStorage.getItem(VIEW_STATE_STORAGE_KEY) || '{}') || {};
      /** @type {Record<string, 'none'|'top'|'all'>} */
      const clean = {};
      for (const [name, state] of Object.entries(raw)) {
        if (VIEW_STATES.includes(/** @type {string} */ (state))) {
          clean[name] = /** @type {'none'|'top'|'all'} */ (state);
        }
      }
      return clean;
    } catch {
      return {};
    }
  }

  /**
   * Persist the current per-provider view-state map, best-effort.
   * @private
   */
  _saveViewState() {
    try {
      localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(this.providerViewState));
    } catch {
      /* best-effort — localStorage may be full or unavailable */
    }
  }

  /**
   * Resolve a provider's effective list view state, applying the default when
   * nothing has been chosen yet. Providers with no meaningful shortlist (the
   * recommended subset equals the full list) skip the 'top' state, so an unset
   * or stale 'top' collapses to 'all' for them.
   * @private
   * @param {string} providerName
   * @param {boolean} hasShortlist - Whether a recommended subset < full list exists.
   * @returns {'none'|'top'|'all'} The state to render.
   */
  _resolveViewState(providerName, hasShortlist) {
    const s = this.providerViewState[providerName];
    if (s === 'none' || s === 'all') return s;
    if (s === 'top') return hasShortlist ? 'top' : 'all';
    // Unset: default to the shortlist when there is one, else the full list.
    return hasShortlist ? 'top' : 'all';
  }

  /**
   * Advance a provider's list view to the next tri-state in the cycle
   * none → top → all → none (providers without a shortlist cycle none ↔ all).
   * @private
   * @param {string} providerName
   */
  _cycleProviderView(providerName) {
    const provider = this.providers.find(p => p.name === providerName);
    if (!provider) return;
    const all = provider.modelsWithContext || [];
    const hasShortlist = getRecommendedModels(all).length < all.length;
    const order = hasShortlist ? ['none', 'top', 'all'] : ['none', 'all'];
    const current = this._resolveViewState(providerName, hasShortlist);
    const next = order[(order.indexOf(current) + 1) % order.length];
    this.providerViewState[providerName] = /** @type {'none'|'top'|'all'} */ (next);
    this._saveViewState();
    this._updateDropdownContent();
  }

  /**
   * Render a top-level bold action item with a leading icon.
   * @param {{id: string, iconClass: string, label: string}} opts
   * @returns {string} HTML
   * @private
   */
  _actionItem({ id, iconClass, label }) {
    return `
            <li class="menu-item" id="${id}">
                <span class="${iconClass}"></span>
                <span>${label}</span>
            </li>
        `;
  }

  /**
   * Render a selectable model row inside a `.menu-group`.
   * @param {{label: string, active: boolean, classes?: string, dataAttrs?: string}} opts
   * @returns {string} HTML
   * @private
   */
  _selectionItem({ label, active, classes = '', dataAttrs = '' }) {
    return `
            <li class="menu-item ${active ? 'active' : ''} ${classes}" ${dataAttrs}>
                <span>${label}</span>
                ${active ? '<span class="menu-item-icon">✓</span>' : ''}
            </li>
        `;
  }

  /**
   * @param {Provider} provider
   * @returns {string} Unavailable provider hint.
   * @private
   */
  _unavailableHint(provider) {
    if (provider.authType === 'oauth_bearer') {
      return provider.authHint || 'Login required';
    }
    return provider.authHint || 'Provider not configured';
  }

  /**
   * Render a disabled model row with an inline availability note.
   * @param {{label: string, note: string, active?: boolean}} opts
   * @returns {string} HTML
   * @private
   */
  _disabledModelItem({ label, note, active = false }) {
    return this._selectionItem({
      label: `${label} <span class="menu-item-note">${note}</span>`,
      active,
      classes: 'unavailable',
    });
  }

  /**
   * Render a section with header + group of selection items.
   * @param {{header?: string, items: string[]}} opts
   * @returns {string} HTML
   * @private
   */
  _menuSection({ header, items }) {
    if (items.length === 0) return '';
    const headerHTML = header ? `<li class="menu-header">${header}</li>` : '';
    return `${headerHTML}<menu class="menu-group">${items.join('')}</menu>`;
  }

  /**
   * Generate the info column: provider/default actions (pinned top), the
   * current-model card + usage stats (scrolls internally when short), and
   * recent models (pinned bottom). The column itself does not scroll.
   * @private
   * @returns {string} HTML for the `.model-menu-info` column.
   */
  _generateInfoColumn() {
    // Section 1 — provider/default actions, pinned to the top.
    let actions = this._actionItem({
      id: 'open-settings-item',
      iconClass: 'menu-settings-icon',
      label: 'Manage LLM providers...',
    });
    actions += this._actionItem({
      id: 'set-default-model-item',
      iconClass: 'menu-settings-icon',
      label: 'Set default model...',
    });
    // Show "Reset to inherited" when thread has its own override
    if (this._messageThread && this._messageThread.threadItemId && this._messageThread.ownModelConfig) {
      actions += this._actionItem({
        id: 'reset-to-inherited-item',
        iconClass: 'menu-reset-icon',
        label: 'Reset to inherited model',
      });
    }

    // Section 2 — the current model card + its usage stats.
    // Section 3 — recently-used models, pinned to the bottom of the column.
    return `
            <div class="info-section info-actions">
                <menu class="model-menu-actions">${actions}</menu>
            </div>
            <div class="info-divider"></div>
            <div class="info-section info-current">
                ${this._generateCurrentModelCard()}
            </div>
            ${this._generateRecentSection()}`;
  }

  /**
   * Build the bottom-aligned "Recent" section: up to 5 recently-used concrete
   * models for quick switching. Includes the current model when it is recent;
   * hiding it makes a just-selected model look like it was not recorded.
   * @private
   * @returns {string} HTML for the `.info-recent` section, or ''.
   */
  _generateRecentSection() {
    const recents = recentModels.get().slice(0, 5);
    if (recents.length === 0) return '';

    const items = recents.map(r => {
      const label = modelLabelFromList(this.providers, r.provider, r.model);
      const providerEntry = this.providers.find(p => p.name === r.provider);
      const providerLabel = providerEntry?.displayName || r.provider;
      return `
                <li class="menu-item recent-model" data-provider="${escapeHtml(r.provider)}" data-model="${escapeHtml(r.model)}">
                    <span class="recent-model-name">${escapeHtml(label)}</span>
                    <span class="recent-model-provider">${escapeHtml(providerLabel)}</span>
                </li>`;
    }).join('');

    return `
            <div class="info-recent">
                <div class="menu-header">Recent</div>
                <menu class="recent-model-list">${items}</menu>
            </div>`;
  }

  /**
   * Render one provider's section: a header bar carrying the provider name and
   * a tri-state view toggle ("none"/"top"/"all"), followed by the model rows
   * dictated by the current view state. The header is always rendered — even in
   * the 'none' (collapsed) state, where no rows follow — so the toggle stays
   * reachable to re-expand the list.
   * @private
   * @param {Provider} provider
   * @returns {string} HTML for the provider's header + model group.
   */
  _generateProviderSection(provider) {
    // Sort the full list newest-first: providers (notably OpenAI and Gemini)
    // return models in no meaningful order, so both the "all" view and the
    // shortlist derived from it should be version-ordered rather than API-ordered.
    const allModels = sortModelsByVersion(provider.modelsWithContext);
    const recommendedModels = getRecommendedModels(allModels);
    const hasShortlist = recommendedModels.length < allModels.length;
    const state = this._resolveViewState(provider.name, hasShortlist);

    // Rows shown depend on the state: none → empty, top → shortlist, all → full.
    let modelsToShow = state === 'none' ? [] : (state === 'all' ? allModels : recommendedModels);

    // In the shortlist view, always keep the currently selected model visible
    // even when it isn't part of the recommended subset.
    if (state === 'top' && this.provider === provider.name && this.model) {
      const selectedModel = allModels.find(m => m.id === this.model);
      if (selectedModel && !modelsToShow.find(m => m.id === this.model)) {
        modelsToShow = [selectedModel, ...modelsToShow];
      }
    }

    const recommendedIds = new Set(recommendedModels.map(m => m.id));
    const disabledNote = provider.available ? '' : this._unavailableHint(provider);

    const items = modelsToShow.map(model => {
      const displayName = modelLabel(model.displayName, model.id);
      if (disabledNote) {
        return this._disabledModelItem({
          label: displayName,
          note: disabledNote,
          active: this.provider === provider.name && this.model === model.id,
        });
      }
      return this._selectionItem({
        label: displayName,
        active: this.provider === provider.name && this.model === model.id,
        classes: recommendedIds.has(model.id) ? 'recommended' : '',
        dataAttrs: `data-provider="${provider.name}" data-model="${model.id}"`,
      });
    });

    const toggle = `<button type="button" class="provider-view-toggle" data-provider="${provider.name}" title="Toggle model list: none / top / all">${state}</button>`;
    const header = `<li class="menu-header provider-menu-header"><span class="menu-header-label">${provider.displayName}</span>${toggle}</li>`;
    const group = items.length ? `<menu class="menu-group">${items.join('')}</menu>` : '';
    return `${header}${group}`;
  }

  /**
   * Generate the scrolling model-list column: per-provider model sections.
   * @private
   * @returns {string} The HTML string for the dropdown's model list.
   */
  _generateModelListContent() {
    if (this.loadingProviders) {
      return `
                <li class="menu-item unavailable">
                    <juggler-spinner style="--size: 0.875rem"></juggler-spinner>
                    <span>Loading providers...</span>
                </li>
            `;
    }

    let content = '';

    // Show providers that expose models. Available providers are selectable;
    // OAuth providers with a stale/missing external login remain visible but
    // disabled so the user can see what will unlock after logging in.
    const menuProviders = this.providers
      .filter(p => p.modelsWithContext && p.modelsWithContext.length > 0)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    if (menuProviders.length === 0) {
      // No usable provider — either the cache is empty or every provider is
      // missing credentials. Point the user at the exact menu action above.
      content += `
                <li class="menu-divider"></li>
                <li class="menu-item menu-item-hint">
                    <span class="menu-hint-text">No providers configured yet.<br/>Click "Manage LLM providers..." above to add credentials.</span>
                </li>
            `;
    }

    content += menuProviders
      .map(provider => this._generateProviderSection(provider)).join('');

    // Bottom-of-list escape hatch: clear the model selection entirely. Styled
    // as a plain selection row so it matches the model items above; active (✓)
    // when nothing is currently selected.
    content += '<li class="menu-divider"></li>';
    content += this._menuSection({
      items: [
        this._selectionItem({
          label: 'No model',
          active: !this.model,
          classes: 'no-model',
          dataAttrs: 'id="no-model-item"',
        }),
      ],
    });

    return content;
  }

  /**
   * Build the current-model card shown in the info column: the effective
   * provider/model identity plus its live usage stats.
   * @private
   * @returns {string} HTML for the `.model-current` + `.model-usage` blocks.
   */
  _generateCurrentModelCard() {
    const resolved = resolveConfig(this._currentConfig, this.providers);

    // No model chosen yet: keep the card quiet.
    if (!resolved || !resolved.provider || !resolved.model) {
      return `
                <div class="model-current">
                    <div class="model-current-label">Current model</div>
                    <div class="model-current-name model-current-name--muted">No model selected</div>
                </div>`;
    }

    const providerEntry = this.providers.find(p => p.name === resolved.provider);
    const providerLabel = providerEntry?.displayName || resolved.provider;
    const modelEntry = providerEntry?.modelsWithContext?.find(m => m.id === resolved.model);
    const modelLabelText = modelLabel(modelEntry?.displayName, resolved.model);
    const ctx = modelEntry?.contextWindow || 0;

    const subParts = [providerLabel];
    if (ctx > 0) subParts.push(`${formatTokens(ctx)} context`);

    return `
            <div class="model-current">
                <div class="model-current-label">Current model</div>
                <div class="model-current-name">${escapeHtml(modelLabelText)}</div>
                <div class="model-current-sub">${escapeHtml(subParts.join(' · '))}</div>
            </div>
            ${this._generateThinkingControl(resolved, modelEntry)}
            ${this._generateUsageSection(resolved.provider)}`;
  }

  /**
   * Segmented control for the current model's thinking level, rendered only
   * when the model advertises `thinkingLevels`. "Default" (no explicit level) is
   * always offered first and, when picked, deletes the `thinking` key; the
   * advertised levels follow in canonical order. The active segment reflects the
   * effective config's `thinking` (Default when absent or unsupported). Clicks
   * are dispatched via `data-thinking-level` in `_attachDropdownListener`.
   * @param {import('../model/model-config.js').ResolvedConfig|null} resolved
   * @param {ModelInfo} [modelEntry]
   * @returns {string} HTML, or '' when the model exposes no thinking control.
   * @private
   */
  _generateThinkingControl(resolved, modelEntry) {
    const levels = modelEntry?.thinkingLevels || [];
    if (levels.length === 0) return '';

    const active = resolved?.thinking && levels.includes(resolved.thinking) ? resolved.thinking : '';
    const def = modelEntry?.defaultThinkingLevel;
    const defaultLabel = def ? `Default (${THINKING_LABELS[def] || def})` : 'Default';

    const seg = (/** @type {string} */ level, /** @type {string} */ label) => {
      const isActive = level === active;
      return `<button type="button" class="thinking-seg${isActive ? ' active' : ''}" data-thinking-level="${escapeHtml(level)}" role="radio" aria-checked="${isActive}">${escapeHtml(label)}</button>`;
    };

    const ordered = THINKING_LEVELS.filter(l => levels.includes(l));
    const segments = [seg('', defaultLabel), ...ordered.map(l => seg(l, THINKING_LABELS[l] || l))];

    return `
            <div class="model-thinking">
                <div class="model-thinking-label">Thinking</div>
                <div class="thinking-segmented" role="radiogroup" aria-label="Thinking level">${segments.join('')}</div>
            </div>`;
  }

  /**
   * Write a thinking-level choice into the same scope the model selection writes
   * to. `level === ''` means Default → delete the `thinking` key (never store
   * `thinking: ''`). Spread-and-rewrite the whole config atomically (never mutate
   * the Y.Map field-by-field — see the race note in conversation.js). Keeps the
   * dropdown open and refreshes the info column so the active segment moves; the
   * button chip refreshes on close.
   * @param {string} level - '' for Default, else a canonical level.
   * @private
   */
  _setThinkingLevel(level) {
    const eff = this._currentConfig;
    if (!eff || !eff.provider || !eff.model) return;

    /** @type {{provider: string, model: string, thinking?: string}} */
    const next = { provider: eff.provider, model: eff.model };
    if (level) next.thinking = level;

    if (this._messageThread) {
      this._messageThread.modelConfig = next;
    } else if (this.conversation) {
      this.conversation.setModelConfig(next);
    } else {
      return;
    }

    this._currentConfig = next;
    this._updateDropdownContent();
  }

  /**
   * Render the usage-stats block for one provider from the cached snapshot.
   *
   * A spinner sits at the right edge of the header bar whenever a fetch is in
   * flight. Stats are shown only when present and fresh; data older than
   * {@link USAGE_STALE_MS} is blanked while refreshing (the numbers are often
   * wrong by then). When nothing is displayable the body is a short message —
   * "refreshing…" while fetching (the header spinner is the activity cue), else
   * "no usage data available".
   * @private
   * @param {string} providerName
   * @returns {string} HTML for the `.model-usage` block, or ''.
   */
  _generateUsageSection(providerName) {
    if (!providerName) return '';
    const usage = usageStatsCache.get(providerName);

    const spinner = this._usageLoading
      ? '<juggler-spinner class="model-usage-spinner" style="--size: 1.125rem"></juggler-spinner>'
      : '';

    const hasStats = usage && usage.stats && usage.stats.length > 0;
    const showStats = hasStats && !(this._usageLoading && this._isUsageStale(usage));

    if (showStats) {
      const planLabel = usage.plan
        ? ` · <span class="model-usage-plan">${escapeHtml(this._formatPlan(usage.plan))}</span>`
        : '';
      const rows = usage.stats.map(stat => this._usageRow(stat)).join('');
      return `
            <div class="model-usage">
                <div class="model-usage-header"><span>Usage${planLabel}</span>${spinner}</div>
                ${rows}
            </div>`;
    }

    const message = this._usageLoading ? 'refreshing…' : 'no usage data available';
    return `
            <div class="model-usage">
                <div class="model-usage-header"><span>Usage</span>${spinner}</div>
                <div class="model-usage-empty">${message}</div>
            </div>`;
  }

  /**
   * Whether a usage snapshot is older than {@link USAGE_STALE_MS}. Stale data
   * is suppressed while a refresh is in flight rather than shown as a likely
   * wrong placeholder. A missing/invalid `updatedAt` is treated as not stale.
   * @private
   * @param {import('../services/usage-stats-cache.js').UsageStats} usage
   * @returns {boolean} True when the snapshot is older than the stale window.
   */
  _isUsageStale(usage) {
    if (!usage || !usage.updatedAt) return false;
    const age = Date.now() - new Date(usage.updatedAt).getTime();
    return age >= USAGE_STALE_MS;
  }

  /**
   * Render one usage signal. A stat with a percentage renders as a labelled
   * meter row; one without (e.g. a raw account balance) renders as a value row
   * showing its `detail` text in place of the meter.
   *
   * When both `resetsAt` and `windowSecs` are present, a thin vertical tick
   * is drawn on the bar at the time-elapsed position. The tick acts as a
   * pace reference: fill left of the tick = under-pacing; fill right of it
   * = over-pacing. This is the same "scrubber on a timeline" metaphor used
   * by audio/video players, so no label is needed.
   * @private
   * @param {import('../services/usage-stats-cache.js').UsageStat} stat
   * @returns {string} HTML for one `.usage-stat` row.
   */
  _usageRow(stat) {
    const reset = this._formatResetIn(stat.resetsAt);
    const resetRow = reset ? `<div class="usage-stat-reset">${escapeHtml(reset)}</div>` : '';
    const detail = stat.detail ? escapeHtml(stat.detail) : '';

    // A stat without a percentage (e.g. a raw account balance) has no meter —
    // render the absolute value where the percentage would otherwise sit.
    const hasPct = stat.usedPercent !== null && stat.usedPercent !== undefined
      && Number.isFinite(Number(stat.usedPercent));
    if (!hasPct) {
      return `
            <div class="usage-stat usage-stat-value">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${detail || '—'}</span>
                </div>
                ${resetRow}
            </div>`;
    }

    const pct = Math.max(0, Math.min(100, Number(stat.usedPercent) || 0));
    const level = pct > 80 ? 'usage-high' : (pct > 60 ? 'usage-medium' : '');

    // Time-elapsed marker — only when we can derive window start.
    let timeMarker = '';
    const windowSecs = Number(stat.windowSecs) || 0;
    if (stat.resetsAt && windowSecs > 0) {
      const msRemaining = new Date(stat.resetsAt).getTime() - Date.now();
      const msElapsed = windowSecs * 1000 - msRemaining;
      const timePct = Math.max(0, Math.min(100, msElapsed / (windowSecs * 1000) * 100));
      timeMarker = `<div class="usage-stat-time-marker" style="left:${timePct.toFixed(1)}%" aria-hidden="true"></div>`;
    }

    return `
            <div class="usage-stat">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${Math.round(pct)}%</span>
                </div>
                <div class="usage-stat-bar-wrap">
                    <div class="usage-stat-bar">
                        <div class="usage-stat-fill ${level}" style="width: ${pct}%;"></div>
                    </div>
                    ${timeMarker}
                </div>
                ${detail ? `<div class="usage-stat-detail">${detail}</div>` : ''}
                ${resetRow}
            </div>`;
  }

  /**
   * Human-friendly "resets in …" string from an ISO reset timestamp.
   * @private
   * @param {string|undefined} resetsAt
   * @returns {string} e.g. "Resets in 3h 12m", or '' when unknown.
   */
  _formatResetIn(resetsAt) {
    if (!resetsAt) return '';
    const ms = new Date(resetsAt).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'Resets now';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `Resets in ${Math.max(1, mins)}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Resets in ${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `Resets in ${days}d ${hours % 24}h`;
  }

  /**
   * Title-case a plan label ("pro" → "Pro").
   * @private
   * @param {string} plan
   * @returns {string} Title-cased plan label.
   */
  _formatPlan(plan) {
    if (!plan) return '';
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }

  /**
   * Attach a single delegated click listener to the dropdown nav.
   * This survives menu.innerHTML replacements from background provider updates.
   * @private
   * @param {Element} dropdown
   */
  _attachDropdownListener(dropdown) {
    dropdown.addEventListener('click', (e) => {
      const target = /** @type {Element} */(e.target);

      // Thinking-level segment: a tweak, not a commit-and-go action, so keep the
      // dropdown open (unlike a model pick, which closes it). '' = Default.
      const seg = target.closest('.thinking-seg');
      if (seg) {
        e.stopPropagation();
        this._setThinkingLevel(seg.getAttribute('data-thinking-level') || '');
        return;
      }

      const item = target.closest('.menu-item, .provider-view-toggle');
      if (!item) return;

      if (item.classList.contains('provider-view-toggle')) {
        e.stopPropagation();
        const providerName = item.getAttribute('data-provider');
        if (providerName) {
          this._cycleProviderView(providerName);
        }
        return;
      }

      if (item.id === 'open-settings-item') {
        this.closeDropdown();
        if (/** @type {any} */(window).openSettings) {
          /** @type {any} */(window).openSettings('providers');
        }
        return;
      }

      if (item.id === 'set-default-model-item') {
        this.closeDropdown();
        if (/** @type {any} */(window).openSettings) {
          /** @type {any} */(window).openSettings('default-model');
        }
        return;
      }

      if (item.id === 'reset-to-inherited-item') {
        if (this._messageThread) {
          this._messageThread.modelConfig = null;
          this._syncModelDisplay();
        }
        this.closeDropdown();
        return;
      }

      if (item.id === 'no-model-item') {
        // Clear the model field. At the root binding this nulls the
        // conversation default (→ "Select Model"); on a sub-thread override it
        // reverts that thread to its inherited model.
        if (this._messageThread) {
          this._messageThread.modelConfig = null;
        } else if (this.conversation) {
          this.conversation.setModelConfig(null);
        }
        this._syncModelDisplay();
        this.closeDropdown();
        return;
      }

      if (item.classList.contains('unavailable')) return;

      const providerName = item.getAttribute('data-provider');
      const modelName = item.getAttribute('data-model');
      if (providerName && modelName) {
        this.selectProviderAndModel(providerName, modelName);
      }
    });
  }

  /** @private */
  closeDropdown() {
    if (this.dropdownOpen) {
      this.dropdownOpen = false;
      // Drop the cached column markup so the next open rebuilds from
      // scratch rather than diffing against a stale (removed) dropdown.
      this._lastListHTML = null;
      this._lastInfoHTML = null;
      // Release tears down the surface, scrim, observer and dismissal wiring.
      if (this._popupRelease) {
        this._popupRelease();
        this._popupRelease = null;
      }
      this._liveDropdown = null;
      this.render();
    }
  }

  /**
   * Ask the server to re-read external provider credentials and wait for the
   * refreshed list to arrive, then return the named provider's fresh entry.
   * Lets a just-completed external login (e.g. `codex login`) be picked up
   * without relaunching the app. Resolves with the latest known entry even if
   * no push arrives within the timeout, so the caller never hangs.
   * @param {string} providerName
   * @returns {Promise<Provider|undefined>} The provider's fresh entry, or undefined if absent.
   * @private
   */
  async _recheckProviderAvailability(providerName) {
    const next = /** @type {Promise<Provider[]>} */(new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout>|null} */
      let timer = null;
      /** @param {unknown} data */
      const handler = (data) => {
        if (timer) clearTimeout(timer);
        wsService.off('providers-update', handler);
        resolve(Array.isArray(data) ? /** @type {Provider[]} */(data) : this.providers);
      };
      wsService.on('providers-update', handler);
      timer = setTimeout(() => {
        wsService.off('providers-update', handler);
        resolve(this.providers);
      }, 4000);
    }));
    try {
      await this.refresh();
    } catch (err) {
      console.warn('[ModelSelector] Provider re-check refresh failed:', err);
    }
    const list = await next;
    return list.find(p => p.name === providerName);
  }

  /**
   * Explain why a model can't be selected and offer a path to fix it. Shows the
   * provider's user-actionable hint (e.g. "Run `codex login` first") verbatim
   * when present, else a generic message — never phrased as "not available".
   * Offers "Go to provider settings" / "Cancel".
   * @param {Provider} provider
   * @param {string} modelName
   * @private
   */
  async _showSelectionProblem(provider, modelName) {
    const showConfirm = /** @type {any} */(window).showConfirm;
    if (!showConfirm) return;
    const modelEntry = provider.modelsWithContext?.find(m => m.id === modelName);
    const label = modelLabel(modelEntry?.displayName, modelName);
    const hint = (provider.authHint || '').trim();
    const message = hint
      ? `Can't select ${label} yet: ${hint}`
      : `There was a problem selecting ${label}.`;
    const goToSettings = await showConfirm(message, 'Problem selecting model', {
      confirmText: 'Go to provider settings',
      cancelText: 'Cancel',
    });
    if (goToSettings) {
      this.closeDropdown();
      if (/** @type {any} */(window).openSettings) {
        /** @type {any} */(window).openSettings('providers');
      }
    }
  }

  /**
   * @param {string} providerName
   * @param {string} modelName
   * @private */
  async selectProviderAndModel(providerName, modelName) {
    let provider = this.providers.find(p => p.name === providerName);

    if (!provider) {
      console.error('[ModelSelector] Provider not found:', providerName);
      return;
    }

    if (!provider.available) {
      // The cached availability may be stale — the user could have just added
      // credentials externally (e.g. `codex login`). Re-check against the live
      // server state so a fresh login is picked up without an app relaunch.
      const refreshed = await this._recheckProviderAvailability(providerName);
      if (refreshed) provider = refreshed;
    }

    if (!provider.available) {
      await this._showSelectionProblem(provider, modelName);
      return;
    }

    if (!this.conversation) {
      console.error('[ModelSelector] No conversation bound');
      this.closeDropdown();
      return;
    }

    // Already selected — just close the dropdown.
    if (this.provider === providerName && this.model === modelName) {
      this.closeDropdown();
      return;
    }

    // Remember this concrete pick for the "Recent" quick-access section.
    recentModels.record(providerName, modelName);

    // Preserve the current thinking level onto the new model iff the new model
    // advertises it; otherwise drop it — a level the new model can't honour must
    // not linger. (This is the kind of rule that regresses silently.)
    /** @type {{provider: string, model: string, thinking?: string}} */
    const nextConfig = { provider: providerName, model: modelName };
    const curThinking = this._currentConfig?.thinking;
    if (curThinking) {
      const modelEntry = provider.modelsWithContext?.find(m => m.id === modelName);
      if ((modelEntry?.thinkingLevels || []).includes(curThinking)) {
        nextConfig.thinking = curThinking;
      }
    }

    // Write to thread if bound, otherwise the conversation.
    if (this._messageThread) {
      this._messageThread.modelConfig = nextConfig;
    } else {
      this.conversation.setModelConfig(nextConfig);
    }

    this._currentConfig = nextConfig;
    this.provider = providerName;
    this.model = modelName;
    this.render();

    this.closeDropdown();
  }

  /**
   * Compact thinking-level pill for the model button. Shown only when the
   * effective config has a concrete level that the selected model advertises;
   * an absent level (provider default) yields no chip, so the button never grows
   * for non-reasoning models.
   * @returns {string} HTML for the chip, or ''.
   * @private
   */
  _thinkingChipHTML() {
    const level = this._currentConfig?.thinking;
    if (!level) return '';
    const prov = this.providers.find(p => p.name === this.provider);
    const modelEntry = prov?.modelsWithContext?.find(m => m.id === this.model);
    if (!(modelEntry?.thinkingLevels || []).includes(level)) return '';
    return `<span class="thinking-chip" title="Thinking: ${escapeHtml(level)}">${escapeHtml(THINKING_CHIP[level] || level)}</span>`;
  }

  render() {
    // Show connection status when not connected, otherwise the model label.
    let modelDisplay;
    let modelUnavailable = false;

    if (this.connectionStatus === 'error') {
      modelDisplay = 'Connection Error';
    } else if (this.connectionStatus === 'disconnected') {
      modelDisplay = 'Disconnected';
    } else if (this.connectionStatus === 'connecting') {
      modelDisplay = 'Connecting...';
    } else if (!this.provider || this.provider === '' || this.provider === 'Loading...') {
      modelDisplay = 'Select Model';
    } else {
      modelDisplay = this.model ? modelLabelFromList(this.providers, this.provider, this.model) : this.provider;
    }

    const noModelSelected = modelDisplay === 'Select Model';
    const infoColumn = this._generateInfoColumn();
    const listContent = this._generateModelListContent();
    // Seed the non-destructive-update caches with what we're about to write,
    // so a subsequent in-place update only rewrites a column whose markup
    // genuinely differs from this freshly-rendered DOM.
    this._lastInfoHTML = infoColumn;
    this._lastListHTML = listContent;

    const hasOverride = this._messageThread?.threadItemId && this._messageThread?.ownModelConfig;

    // Flag when the selected model is absent from the current provider list.
    if (this.provider && this.model && this.providers.length > 0) {
      const prov = this.providers.find(p => p.name === this.provider);
      modelUnavailable = !prov || !prov.modelsWithContext ||
                !prov.modelsWithContext.some(m => m.id === this.model);
    }

    this.innerHTML = `
            <button class="model-selector-button input-ctrl-btn${hasOverride ? ' has-override' : ''}${modelUnavailable ? ' model-unavailable' : ''}${noModelSelected ? ' pulse' : ''}" id="model-button" title="LLM Model">
                <span class="icon-auto-awesome"></span>${modelDisplay}${this._thinkingChipHTML()}${hasOverride ? '<span class="override-dot"></span>' : ''}
            </button>

            <nav class="dropdown-menu provider-dropdown ${this.dropdownOpen ? 'show' : ''}" id="provider-dropdown">
                <div class="model-menu-info">${infoColumn}</div>
                <div class="model-menu-list">
                    <menu>${listContent}</menu>
                </div>
            </nav>
        `;

    const button = this.querySelector('#model-button');
    if (button) {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleDropdown();
      });
    }

  }
}

customElements.define('model-selector', ModelSelector);
