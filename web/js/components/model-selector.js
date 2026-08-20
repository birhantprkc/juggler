//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { presentPopup, presentInlineMenu } from '../utils/popup-surface.js';
import wsService from '../services/websocket.js';
import providersCache from '../services/providers-cache.js';
import connectionStatus from '../services/connection-status.js';
import usageStatsCache from '../services/usage-stats-cache.js';
import recentModels from '../services/recent-models.js';
import { getRecommendedModels, sortModelsByVersion } from '../utils/model-filter.js';
import { resolveConfig } from '../model/model-config.js';
import { modelLabel, modelLabelFromList } from '../model/model-display.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { formatTokens } from '../utils/format.js';
import { formatPlan, isUsageStale, renderUsageRow } from '../utils/usage-renderer.js';
import CycleBuffer from '../services/cycle-buffer.js';
import { showConfirm } from './modal-dialog.js';
import { openSettings } from '../services/settings-launcher.js';

/** localStorage key holding the per-provider list view-state override map. */
const VIEW_STATE_STORAGE_KEY = 'juggler-model-view-state';

/** The list view-states a provider header toggle cycles through. */
const VIEW_STATES = ['none', 'top', 'all'];

/**
 * Title-case a native thinking-level string for the segmented control's full
 * label (e.g. "medium" → "Medium", "xhigh" → "Xhigh"). The button chip shows the
 * raw string verbatim.
 * @param {string} level - The native level string.
 * @returns {string} The level with its first letter upper-cased.
 */
const thinkingLabel = (level) => (level ? level.charAt(0).toUpperCase() + level.slice(1) : level);

/**
 * Structural equality for a `{provider, model, thinking?}` config, with the
 * thinking level normalised (absent === ''). Shared by the CycleBuffer pin
 * comparison and the commit's changed-vs-committed check.
 * @param {*} a - A model config (or null).
 * @param {*} b - A model config (or null).
 * @returns {boolean} True when both name the same provider, model and level.
 */
function sameModelConfig(a, b) {
  return a === b || (!!a && !!b
    && a.provider === b.provider && a.model === b.model
    && (a.thinking || '') === (b.thinking || ''));
}

/**
 * Model selector component with provider and model dropdown menu
 * @typedef {object} ModelInfo
 * @property {string} id - Model ID
 * @property {number} contextWindow - Context window size
 * @property {string} [displayName] - Provider-supplied human label, when the provider exposes one
 * @property {string[]} [thinkingLevels] - Reasoning tiers the model supports, in display order, each named in the provider's own native vocabulary (the string is the identity, shown verbatim); absent/empty ⇒ no thinking control
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
    /** @type {import('../services/connection-status.js').ConnectionStatus} @private */
    this.connectionStatus = null; // 'error', 'disconnected', 'connecting', or null for connected
    /** @type {(() => void)|null} @private - connectionStatus subscription. */
    this._connectionStatusOff = null;
    /** @type {boolean} @private */
    this.loadingProviders = false;
    /** @type {import('../model/conversation.js').default|null} @private */
    this.conversation = null;
    /** @type {(() => void)|null} @private - presentPopup release for the mini thinking popover. */
    this._miniPopupRelease = null;
    /** @type {HTMLElement|null} @private - The mini thinking popover's surface while open. */
    this._miniSurface = null;
    /**
     * The open dropdown's presentation handle (pending frame + popup release),
     * else null. Its `surface` is THIS selector's own dropdown while open
     * (relocated to <body>) — instance-scoped so updates/teardown never touch a
     * sibling's surface: multiple selectors coexist (root + each open sub-thread
     * column) and all share the `[data-model-selector="true"]` attribute, so a
     * document-wide query would grab the wrong one.
     * @type {import('../utils/popup-surface.js').InlineMenu|null} @private
     */
    this._menu = null;
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
    /**
     * The LIVE model config: the committed selection normally, and the previewed
     * hop while a hold-to-cycle gesture is in progress. `this.provider`/`this.model`
     * track it too, so the dropdown/popover HUD shows the preview. The collapsed
     * BUTTON reads `_committed` instead while the gesture runs, so it stays frozen
     * until release.
     * @type {*} @private
     */
    this._currentConfig = null;
    /**
     * The button's frozen `{provider, model, config}` snapshot during a gesture,
     * taken at `beginCycle`; null when no gesture is running (the button then
     * reads the live fields). See `_buttonDisplayState` / `_thinkingChipHTML`.
     * @type {{provider: string, model: string, config: *}|null} @private
     */
    this._committed = null;
    /**
     * The shared display-defence lifecycle for the hold-to-cycle gesture: while
     * it runs the button is frozen at `_committed` and doc-sync is blocked; on
     * commit it pins the landing config against the post-commit sync bounce until
     * the running turn settles — the anti-flicker this selector previously
     * lacked. It does not touch the doc. See `beginCycle` / `commitCycle` and the
     * CycleBuffer module doc.
     * @type {CycleBuffer<*>} @private
     */
    this._cycle = new CycleBuffer({
      isEqual: sameModelConfig,
      // Force a re-sync once the backstop releases a pin, in case the value we
      // masked reflected a genuine external change rather than the transient bounce.
      onRelease: () => this._syncModelDisplay(),
    });
    /** @type {boolean} @private - True while a usage-stats fetch is in flight. */
    this._usageLoading = false;
    /** @type {string|null} @private - Last list-column HTML written, for non-destructive updates. */
    this._lastListHTML = null;
    /** @type {string|null} @private - Last info-column HTML written, for non-destructive updates. */
    this._lastInfoHTML = null;
  }

  connectedCallback() {
    // Seed before the first render, then follow: an instance created during an
    // outage (a tab opened while the socket is down) must show the fault too,
    // and every instance shows it — not just whichever one a document query
    // happened to reach first.
    this.connectionStatus = connectionStatus.get();
    this._connectionStatusOff = connectionStatus.subscribe(
      (status) => this.setConnectionStatus(status)
    );

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
    // Cancel a not-yet-presented dropdown, then tear down any live surface
    // (scrim, observer, dismissal wiring) it left on document.body.
    this._menu?.close();
    this._menu = null;
    // Likewise the mini thinking popover, which lives on document.body too.
    this._closeThinkingMini();
    // Clean up WebSocket listener
    if (this._providersUpdateHandler) {
      wsService.off('providers-update', this._providersUpdateHandler);
    }
    if (this._connectionStatusOff) {
      this._connectionStatusOff();
      this._connectionStatusOff = null;
    }
    // Drop any gesture/pin state (clears the pin's backstop timer).
    this._cycle.reset();
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
    // The CycleBuffer decides whether the doc may drive the display right now.
    // While a gesture buffers, it rejects the read so the previewed hop stays on
    // screen (re-reading the doc — e.g. from an async providers-update push the
    // menu HUD's own open→refresh triggers ~0.5-1s later — would clobber the
    // preview back to the original model). After a commit it rejects the
    // transient post-commit bounce until the running turn settles. Either way
    // the open dropdown still refreshes so updated availability shows.
    const config = this._getEffectiveConfig();
    if (!this._cycle.accepts(config)) {
      if (this.dropdownOpen) this._updateDropdownContent();
      return;
    }
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

    // The open dropdown and its anchor have been moved into separate DOM
    // subtrees by presentPopup. Model config writes notify their observers
    // synchronously, so this method can run in the middle of applyConfigPair.
    // Replacing this element's innerHTML here would detach the anchor and also
    // create a second inline dropdown. Keep both live nodes and refresh them.
    if (this.dropdownOpen && this._menu?.surface) {
      this._updateDropdownContent();
      this._refreshButtonContent();
      return;
    }

    this.render();
  }

  /**
   * Set connection status to display. Driven by the connectionStatus
   * subscription; exposed for tests that want to force a state.
   * @param {import('../services/connection-status.js').ConnectionStatus} status - 'error', 'disconnected', 'connecting', or null for connected
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
    providersCache.refresh().catch(err => console.warn('[ModelSelector] Failed to refresh providers:', err));

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

    // Present the dropdown once rendered. presentInlineMenu owns the deferred
    // frame and cancels it on close, so a close/re-render before it runs cannot
    // leave a stale callback that presents an old detached menu as a second,
    // unanchored surface.
    this._menu = presentInlineMenu({
      host: this,
      surfaceSelector: '.provider-dropdown',
      anchorSelector: '.model-selector-button',
      onClose: () => this.closeDropdown(),
      onPresent: (dropdown) => this._attachDropdownListener(dropdown),
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
    const dropdown = this._menu?.surface;
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
    const dropdown = dropdownEl || this._menu?.surface;
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
    // The info column only shows the resolved (active) provider's usage, so fetch
    // just that one — never fan out across providers the user isn't viewing. No
    // resolved provider ⇒ nothing to fetch.
    const resolved = resolveConfig(this._currentConfig, this.providers);
    const providerName = resolved?.provider || '';
    if (!providerName) return;
    this._usageLoading = true;
    this._updateInfoColumn();
    try {
      await usageStatsCache.refresh(providerName);
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
    const selectedTick = active
      ? `<span class="model-selected-tick" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>
                </span>`
      : '';
    return `
            <li class="menu-item model-selection-item ${active ? 'active' : ''} ${classes}" ${dataAttrs}>
                ${selectedTick}
                <span class="model-item-name">${label}</span>
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
      label: 'Manage LLM providers…',
    });
    actions += this._actionItem({
      id: 'set-default-model-item',
      iconClass: 'menu-settings-icon',
      label: 'Set default model…',
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
   * Build the bottom-aligned "Recent" section: up to 6 recently-used concrete
   * model+level pairs for quick switching. Entries are distinct by
   * provider+model+thinking, so the same model at two levels is two rows —
   * the level chip after the name differentiates them. Includes the current
   * model when it is recent; hiding it makes a just-selected model look like
   * it was not recorded.
   * @private
   * @returns {string} HTML for the `.info-recent` section, or ''.
   */
  _generateRecentSection() {
    const recents = recentModels.getAvailable(this.providers).slice(0, 6);
    if (recents.length === 0) return '';
    const current = this.currentConfigPair();

    const items = recents.map(r => {
      const label = modelLabelFromList(this.providers, r.provider, r.model);
      const providerEntry = this.providers.find(p => p.name === r.provider);
      const providerLabel = providerEntry?.displayName || r.provider;
      const active = !!current && r.provider === current.provider && r.model === current.model
        && (r.thinking || '') === (current.thinking || '');
      // The stored level rides along as data-thinking so a click restores the
      // exact pair; the chip is display-only (the whole row is the target).
      const chip = r.thinking
        ? `<span class="recent-model-chip" title="Thinking: ${escapeHtml(r.thinking)}">${escapeHtml(r.thinking)}</span>`
        : '';
      const thinkingAttr = r.thinking ? ` data-thinking="${escapeHtml(r.thinking)}"` : '';
      return `
                <li class="menu-item recent-model${active ? ' active' : ''}" data-provider="${escapeHtml(r.provider)}" data-model="${escapeHtml(r.model)}"${thinkingAttr}>
                    <span class="recent-model-name">${escapeHtml(label)}${chip}</span>
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
    // (Casts: the filter utils' generic Model typedef erases the richer
    // ModelInfo shape, but they return the same objects they were given.)
    const allModels = /** @type {ModelInfo[]} */ (sortModelsByVersion(provider.modelsWithContext));
    const recommendedModels = /** @type {ModelInfo[]} */ (getRecommendedModels(allModels));
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
      const isCurrent = this.provider === provider.name && this.model === model.id;
      if (disabledNote) {
        return this._disabledModelItem({
          label: displayName,
          note: disabledNote,
          active: isCurrent,
        });
      }
      return this._selectionItem({
        label: displayName,
        active: isCurrent,
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
                    <span class="menu-hint-text">No providers yet.<br/>Click "Manage LLM providers…" to add credentials.</span>
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
   * advertised levels follow in the provider's declared order, each shown by its
   * native name. The active segment reflects the effective config's `thinking`
   * (Default when absent or unsupported). Clicks are dispatched via
   * `data-thinking-level` in `_attachDropdownListener`.
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
    const defaultLabel = def ? `Default (${thinkingLabel(def)})` : 'Default';

    const seg = (/** @type {string} */ level, /** @type {string} */ label) => {
      const isActive = level === active;
      return `<button type="button" class="thinking-seg${isActive ? ' active' : ''}" data-thinking-level="${escapeHtml(level)}" role="radio" aria-checked="${isActive}">${escapeHtml(label)}</button>`;
    };

    // Advertised order, shown verbatim (title-cased) — the provider owns the set.
    const segments = [seg('', defaultLabel), ...levels.map(l => seg(l, thinkingLabel(l)))];

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
   * the Y.Map field-by-field — see the race note in conversation.js). The shared
   * write path serves the dropdown's segmented control, the button chip's mini
   * popover, and the cycle-thinking shortcut. Pure write — the caller owns any
   * re-render (see `refreshThinkingDisplay`).
   * @param {string} level - '' for Default, else a native provider level.
   * @returns {boolean} True when the level was written.
   */
  applyThinkingLevel(level) {
    const eff = this._currentConfig;
    if (!eff || !eff.provider || !eff.model) return false;

    /** @type {{provider: string, model: string, thinking?: string}} */
    const next = { provider: eff.provider, model: eff.model };
    if (level) next.thinking = level;

    if (!this._writeOrDefer(next)) return false;

    this._currentConfig = next;
    return true;
  }

  /**
   * Apply a thinking-level pick from the dropdown's segmented control and close
   * the menu — model + level is one identity, so picking a level is a commit
   * action exactly like picking a model.
   * @param {string} level - '' for Default, else a native provider level.
   * @private
   */
  _setThinkingLevel(level) {
    if (this.applyThinkingLevel(level)) this.closeDropdown();
  }

  /**
   * Render the usage-stats block for one provider from the cached snapshot.
   *
   * A spinner sits at the right edge of the header bar whenever a fetch is in
   * flight. Stats are shown only when present and fresh; data older than
   * {@link USAGE_STALE_MS} is blanked while refreshing (the numbers are often
   * wrong by then). When nothing is displayable the body is a short message —
   * "refreshing…" while fetching (the header spinner is the activity cue), else
   * "no usage data".
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
    const showStats = hasStats && !(this._usageLoading && isUsageStale(usage));

    if (showStats) {
      const planLabel = usage.plan
        ? ` · <span class="model-usage-plan">${escapeHtml(formatPlan(usage.plan))}</span>`
        : '';
      const rows = usage.stats.map(renderUsageRow).join('');
      return `
            <div class="model-usage">
                <div class="model-usage-header"><span>Usage${planLabel}</span>${spinner}</div>
                ${rows}
            </div>`;
    }

    const message = this._usageLoading ? 'refreshing…' : 'no usage data';
    return `
            <div class="model-usage">
                <div class="model-usage-header"><span>Usage</span>${spinner}</div>
                <div class="model-usage-empty">${message}</div>
            </div>`;
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

      // Thinking-level segment: apply the level and close the dropdown.
      // '' = Default.
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
          /** @type {any} */(window).openSettings('defaults');
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
        // Recent rows carry their stored level in data-thinking so the exact
        // pair is restored; plain list rows have no such attribute, so a bare
        // name click selects the model at its default level.
        this.selectProviderAndModel(providerName, modelName,
          item.getAttribute('data-thinking') || undefined);
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
      // Close cancels a deferred presentation before it can resurrect this
      // menu, then tears down the surface, scrim, observer and dismissal wiring.
      this._menu?.close();
      this._menu = null;
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
      await providersCache.refresh();
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
      openSettings('providers');
    }
  }

  /**
   * Select a model, optionally at an explicit thinking level. Model + level is
   * one identity: `thinking` is honoured only when the model advertises that
   * level (a stale level from a recent entry falls back to the model's
   * default).
   * @param {string} providerName
   * @param {string} modelName
   * @param {string} [thinking] Native provider thinking level; absent/empty
   *   means the model's default level.
   * @private */
  async selectProviderAndModel(providerName, modelName, thinking) {
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

    // Honour the requested level only when the model advertises it — a recent
    // entry may carry a level the model no longer supports, which must fall
    // back to the default rather than store a level the model can't honour.
    const modelEntry = provider.modelsWithContext?.find(m => m.id === modelName);
    const level = thinking && (modelEntry?.thinkingLevels || []).includes(thinking) ? thinking : '';

    // Already selected at this exact level — just close the dropdown. The
    // level is part of the identity, so the same model at a different level
    // is a real change and falls through.
    if (this.provider === providerName && this.model === modelName
      && (this._currentConfig?.thinking || '') === level) {
      this.closeDropdown();
      return;
    }

    // An explicit pick supersedes any in-flight post-commit pin.
    this._cycle.reset();

    /** @type {{provider: string, model: string, thinking?: string}} */
    const nextConfig = { provider: providerName, model: modelName };
    if (level) nextConfig.thinking = level;

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
   * Open the dropdown menu if it isn't already open. Public entry point for
   * the hold-to-cycle model shortcut, which uses the menu as its HUD.
   */
  open() {
    if (!this.dropdownOpen) this.toggleDropdown();
  }

  /**
   * Close the dropdown menu. Idempotent.
   */
  close() {
    this.closeDropdown();
  }

  /**
   * The current effective `{provider, model, thinking?}` pair, with `thinking`
   * normalised to the levels the model actually advertises (an unsupported
   * stored level means the model's default, same as everywhere else).
   * @returns {{provider: string, model: string, thinking?: string}|null} The
   *   pair, or null when no model is selected.
   */
  currentConfigPair() {
    const c = this._currentConfig;
    if (!c || !c.provider || !c.model) return null;
    const level = c.thinking && this.supportedThinkingLevels().includes(c.thinking) ? c.thinking : '';
    return level
      ? { provider: c.provider, model: c.model, thinking: level }
      : { provider: c.provider, model: c.model };
  }

  /**
   * The thinking levels the currently selected model advertises, in the
   * provider's declared order. Empty for non-thinking models (or when nothing is
   * selected).
   * @returns {string[]} Supported levels in advertised order.
   */
  supportedThinkingLevels() {
    const prov = this.providers.find(p => p.name === this.provider);
    const modelEntry = prov?.modelsWithContext?.find(m => m.id === this.model);
    return (modelEntry?.thinkingLevels || []).slice();
  }

  /**
   * Apply a `{provider, model, thinking?}` pair WITHOUT recording it to the
   * Recent section — the write path for the hold-to-cycle model shortcut,
   * whose intermediate hops must not reorder the very recents list being
   * cycled (the controller records the landing pair on commit). `thinking` is
   * honoured only when the model advertises that level, like everywhere else.
   * Unlike `selectProviderAndModel` this never prompts about an unavailable
   * provider (cycling just skips it, so the caller gets `false`) and never
   * closes the dropdown, which the gesture keeps open as its HUD — while open,
   * both dropdown columns and the collapsed button refresh in place.
   * @param {{provider: string, model: string, thinking?: string}} pair
   * @returns {boolean} True when the pair was applied.
   */
  applyConfigPair(pair) {
    const provider = this.providers.find(p => p.name === pair.provider);
    if (!provider || !provider.available) return false;

    const modelEntry = provider.modelsWithContext?.find(m => m.id === pair.model);
    const level = pair.thinking && (modelEntry?.thinkingLevels || []).includes(pair.thinking) ? pair.thinking : '';

    /** @type {{provider: string, model: string, thinking?: string}} */
    const nextConfig = { provider: pair.provider, model: pair.model };
    if (level) nextConfig.thinking = level;

    if (!this._writeOrDefer(nextConfig)) return false;

    this._currentConfig = nextConfig;
    this.provider = pair.provider;
    this.model = pair.model;

    if (this.dropdownOpen) {
      // The open dropdown is the gesture's HUD: refresh its columns and the
      // collapsed button in place — a full render() would build a duplicate
      // inline dropdown behind the live surface presentPopup moved to <body>.
      this._updateDropdownContent();
      this._refreshButtonContent();
    } else {
      this.render();
    }
    return true;
  }

  /**
   * Persist a `{provider, model, thinking?}` choice into the bound scope — the
   * conversation/thread Y.Map the engine (and any running turn) reads. The
   * single write path shared by `applyConfigPair` and `applyThinkingLevel`.
   * @param {{provider: string, model: string, thinking?: string}} config
   * @returns {boolean} True when written; false when there is nothing bound.
   * @private
   */
  _writeConfigToDoc(config) {
    if (this._messageThread) {
      this._messageThread.modelConfig = config;
      return true;
    }
    if (this.conversation) {
      this.conversation.setModelConfig(config);
      return true;
    }
    return false;
  }

  /**
   * Write `config` now, or — during a hold-to-cycle gesture (`beginCycle`) —
   * buffer it so a running turn never observes an intermediate hop; the local
   * fields and HUD still update on every hop, and `commitCycle` flushes the
   * landing value once. Returns false only when nothing is bound to write to,
   * so callers still reject an inapplicable pair identically in both modes.
   * @param {{provider: string, model: string, thinking?: string}} config
   * @returns {boolean} True when the choice may be applied to the display.
   * @private
   */
  _writeOrDefer(config) {
    // During a gesture, preview only — no doc write (a running turn never sees an
    // intermediate config); the landing config is written once by commitCycle.
    if (this._cycle.buffering) {
      return !!(this._messageThread || this.conversation);
    }
    // A non-buffered write is an explicit choice (a picked model/level) — it
    // supersedes any in-flight post-commit pin so the pick shows immediately.
    this._cycle.reset();
    return this._writeConfigToDoc(config);
  }

  /**
   * Begin a hold-to-cycle gesture: snapshot the committed config so the button
   * stays frozen on it while the dropdown/popover previews hops, and freeze
   * doc-sync. Idempotent, so the model and thinking cyclers (which share this
   * selector) can both open a gesture without the second disturbing the first.
   */
  beginCycle() {
    this._committed = { provider: this.provider, model: this.model, config: this._currentConfig };
    this._cycle.begin();
  }

  /**
   * Commit the gesture (modifier released): the previewed config becomes the
   * selection. If it changed, write it to the doc exactly once — so a running
   * turn only ever sees the final choice — and pin it against the post-commit
   * sync bounce until the turn settles. Then repaint the button DIRECTLY (not
   * via the doc-sync path, which the pin may gate). A pure hold-to-peek that
   * landed back on the committed config writes nothing.
   */
  commitCycle() {
    const landing = this._currentConfig;
    const changed = !sameModelConfig(landing, this._committed?.config);
    this._committed = null;
    if (changed && landing) {
      this._cycle.pin(landing);
      this._writeConfigToDoc(landing);
    } else {
      this._cycle.end();
    }
    this.render();
  }

  /**
   * Abandon the gesture (Escape): nothing was written, so drop the preview and
   * restore the live fields (button + dropdown/popover) to the committed config.
   */
  cancelCycle() {
    if (this._committed) {
      this.provider = this._committed.provider;
      this.model = this._committed.model;
      this._currentConfig = this._committed.config;
    }
    this._committed = null;
    this._cycle.end();
    this.render();
  }

  /**
   * Open the mini thinking popover anchored to the button chip — the public
   * entry point for the hold-to-cycle thinking shortcut's HUD. The chip always
   * exists for a selected thinking-capable model (see `_thinkingChipHTML`), so
   * failure means the current model has no thinking control.
   * @returns {boolean} True when the popover is (now) open.
   */
  openThinkingMini() {
    if (this._miniPopupRelease) return true;
    // With the dropdown open, close it first — same rule as the chip's own
    // click handler; closing re-renders the button, so re-resolve the chip.
    if (this.dropdownOpen) this.closeDropdown();
    const chip = /** @type {HTMLElement|null} */(this.querySelector('.model-selector-button .thinking-chip'));
    if (!chip) return false;
    this._openThinkingMini(chip);
    return true;
  }

  /**
   * Close the mini thinking popover if open. Idempotent.
   */
  closeThinkingMini() {
    this._closeThinkingMini();
  }

  /**
   * Refresh everything displaying the current thinking level after an
   * out-of-band level change (the hold-to-cycle thinking shortcut). With the
   * mini popover open it is the gesture's HUD: its segmented control and the
   * anchor chip are updated IN PLACE, because a full render() would replace —
   * and thereby close — the popover's anchor. Same in-place treatment with the
   * dropdown open (whose surface lives in <body>). Otherwise a full render.
   */
  refreshThinkingDisplay() {
    if (this._miniPopupRelease && this._miniSurface) {
      const providerEntry = this.providers.find(p => p.name === this.provider);
      const modelEntry = providerEntry?.modelsWithContext?.find(m => m.id === this.model);
      const resolved = resolveConfig(this._currentConfig, this.providers);
      this._miniSurface.innerHTML = this._generateThinkingControl(resolved, modelEntry);
      this._updateChipInPlace();
      return;
    }
    if (this.dropdownOpen) {
      this._updateDropdownContent();
      this._updateChipInPlace();
      return;
    }
    this.render();
  }

  /**
   * Update the button chip's classes/label for the current effective level
   * without replacing the element — the chip anchors the mini popover, and
   * swapping the node out from under presentPopup would orphan its
   * positioning. Falls back to a full render when the chip's very existence
   * changed (it appeared or disappeared).
   * @private
   */
  _updateChipInPlace() {
    const chip = /** @type {HTMLElement|null} */(this.querySelector('.model-selector-button .thinking-chip'));
    const html = this._thinkingChipHTML();
    if (!chip || !html) {
      if (!!chip !== !!html) this.render();
      return;
    }
    // Clone the freshly-generated chip's attributes/text onto the live node.
    const tmp = document.createElement('span');
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    if (!fresh) return;
    chip.className = fresh.className;
    chip.setAttribute('title', fresh.getAttribute('title') || '');
    chip.textContent = fresh.textContent;
  }

  /**
   * Compact thinking-level pill for the model button, always showing the
   * EFFECTIVE level for a thinking-capable selected model: an explicit config
   * level the model advertises ⇒ solid chip; otherwise the model's declared
   * `defaultThinkingLevel` (or "def" when none is declared) ⇒ hollow `.default`
   * variant. Non-thinking models get no chip, so the button never grows for
   * them. The chip is its own click target — it toggles the mini thinking
   * popover (see `_openThinkingMini`), wired up in `render()`.
   * @returns {string} HTML for the chip, or ''.
   * @private
   */
  _thinkingChipHTML() {
    // Frozen at the committed snapshot while a gesture cycles (the button chip
    // must not track previewed hops — those show in the mini popover HUD).
    const frozen = this._cycle.buffering ? this._committed : null;
    const provider = frozen ? frozen.provider : this.provider;
    const model = frozen ? frozen.model : this.model;
    const config = frozen ? frozen.config : this._currentConfig;

    const prov = this.providers.find(p => p.name === provider);
    const modelEntry = prov?.modelsWithContext?.find(m => m.id === model);
    const levels = modelEntry?.thinkingLevels || [];
    if (levels.length === 0) return '';
    // An explicit level counts only when the model advertises it — a stale
    // stored level means the model's default, same as everywhere else.
    const explicit = config?.thinking;
    const level = explicit && levels.includes(explicit) ? explicit : '';
    const declaredDefault = modelEntry?.defaultThinkingLevel || '';
    const shown = level || declaredDefault || 'def';
    // The chip shows the provider's native level string verbatim.
    const shownLabel = shown;
    // Cite the switch-thinking shortcut (⌥⌘T / Ctrl+Alt+T) live from the central
    // table, so the hint stays correct if it's ever rebound or left unbound.
    const cycleKey = keyShortcutManager.formatBinding('cycle-thinking');
    const keyHint = cycleKey ? ` (${cycleKey}, hold for menu)` : '';
    const title = level
      ? `Thinking: ${level} — click to change${keyHint}`
      : `Thinking: ${declaredDefault ? `${declaredDefault} (default)` : 'default'} — click to change${keyHint}`;
    // A <span> (not <button>): the chip nests inside the model button, and a
    // button inside a button is invalid HTML the parser would eject.
    return `<span class="thinking-chip${level ? '' : ' default'}" role="button" title="${escapeHtml(title)}">${escapeHtml(shownLabel)}</span>`;
  }

  /**
   * Open the mini thinking popover: just the thinking segmented control,
   * anchored to the button chip, for changing the current model's level without
   * opening the full dropdown. Reuses `_generateThinkingControl` for the markup
   * and `applyThinkingLevel` for the write, so both entry points stay in
   * lock-step. presentPopup's id-based mutual exclusion guarantees at most one
   * popover and closes it whenever another popup (the main dropdown included)
   * opens.
   * @param {HTMLElement} chip - The button chip to anchor to.
   * @private
   */
  _openThinkingMini(chip) {
    const resolved = resolveConfig(this._currentConfig, this.providers);
    const providerEntry = this.providers.find(p => p.name === this.provider);
    const modelEntry = providerEntry?.modelsWithContext?.find(m => m.id === this.model);
    const controlHTML = this._generateThinkingControl(resolved, modelEntry);
    if (!controlHTML) return;

    // `show` up front: presentPopup owns placement, but display comes from the
    // base .dropdown-menu rule, which hides surfaces without it.
    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu thinking-mini show';
    surface.innerHTML = controlHTML;
    surface.addEventListener('click', (e) => {
      const target = /** @type {Element} */(e.target);
      const seg = target.closest('.thinking-seg');
      if (!seg) return;
      e.stopPropagation();
      this.applyThinkingLevel(seg.getAttribute('data-thinking-level') || '');
      this._closeThinkingMini();
      // Re-render so the button chip reflects the new level immediately.
      this.render();
    });
    this._miniSurface = surface;

    this._miniPopupRelease = presentPopup({
      surface,
      anchor: chip,
      id: 'thinking-mini',
      onClose: () => this._closeThinkingMini(),
      align: 'left',
      gap: 8,
      // The whole selector counts as "inside" so a second chip click reaches
      // the toggle handler in render() instead of racing the capture-phase
      // outside-click dismissal (which runs before the chip's bubble handler).
      insideSelectors: ['model-selector', '.thinking-mini'],
    });
  }

  /**
   * Release the mini thinking popover if open — tears down its surface, scrim,
   * observer and dismissal wiring via presentPopup's release. Idempotent.
   * @private
   */
  _closeThinkingMini() {
    if (this._miniPopupRelease) {
      this._miniPopupRelease();
      this._miniPopupRelease = null;
    }
    this._miniSurface = null;
  }

  /**
   * Compute the collapsed button's display state: the label text plus the
   * flags its state classes key off. Shared by `render()` and the in-place
   * refresh used while the dropdown is open (`_refreshButtonContent`).
   * @private
   * @returns {{modelDisplay: string, noModelSelected: boolean, modelUnavailable: boolean, hasOverride: boolean}}
   *   The button's display state.
   */
  _buttonDisplayState() {
    // While a gesture cycles, the button is frozen at the committed snapshot —
    // the previewed hops show only in the dropdown/popover HUD (which reads the
    // live this.provider/this.model). Outside a gesture these ARE the live fields.
    const frozen = this._cycle.buffering ? this._committed : null;
    const provider = frozen ? frozen.provider : this.provider;
    const model = frozen ? frozen.model : this.model;

    // Show connection status when not connected, otherwise the model label.
    let modelDisplay;
    let modelUnavailable = false;

    if (this.connectionStatus === 'error') {
      modelDisplay = 'Connection Error';
    } else if (this.connectionStatus === 'disconnected') {
      modelDisplay = 'Disconnected';
    } else if (this.connectionStatus === 'connecting') {
      modelDisplay = 'Connecting...';
    } else if (!provider || provider === '' || provider === 'Loading...') {
      modelDisplay = 'Select Model';
    } else {
      modelDisplay = model ? modelLabelFromList(this.providers, provider, model) : provider;
    }

    const hasOverride = !!(this._messageThread?.threadItemId && this._messageThread?.ownModelConfig);

    // Flag when the selected model is absent from the current provider list.
    if (provider && model && this.providers.length > 0) {
      const prov = this.providers.find(p => p.name === provider);
      modelUnavailable = !prov || !prov.modelsWithContext ||
                !prov.modelsWithContext.some(m => m.id === model);
    }

    return { modelDisplay, noModelSelected: modelDisplay === 'Select Model', modelUnavailable, hasOverride };
  }

  /**
   * The collapsed button's inner markup: icon, label, thinking chip, override dot.
   * @private
   * @param {{modelDisplay: string, hasOverride: boolean}} state - From `_buttonDisplayState`.
   * @returns {string} HTML for the button's content.
   */
  _buttonContentHTML(state) {
    return `<span class="icon-auto-awesome"></span><span class="model-name">${state.modelDisplay}</span>${this._thinkingChipHTML()}${state.hasOverride ? '<span class="override-dot"></span>' : ''}`;
  }

  /**
   * Rebuild the collapsed button's content and state classes in place, keeping
   * the <button> element itself — it anchors the open dropdown, and replacing
   * it would orphan presentPopup's positioning. Rewires the chip's click
   * handler, which was attached to the replaced chip node. Used by
   * `applyConfigPair` while the dropdown is open as the cycling HUD.
   * @private
   */
  _refreshButtonContent() {
    const button = /** @type {HTMLElement|null} */(this.querySelector('#model-button'));
    if (!button) return;
    const state = this._buttonDisplayState();
    button.classList.toggle('has-override', state.hasOverride);
    button.classList.toggle('model-unavailable', state.modelUnavailable);
    button.classList.toggle('pulse', state.noModelSelected);
    button.innerHTML = this._buttonContentHTML(state);
    this._wireChip();
  }

  /**
   * Attach the thinking chip's click handler: the chip is a click target of
   * its own — it toggles the mini popover and must never toggle the main
   * dropdown underneath it. No-op when the button carries no chip.
   * @private
   */
  _wireChip() {
    const chip = /** @type {HTMLElement|null} */(this.querySelector('.model-selector-button .thinking-chip'));
    if (!chip) return;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._miniPopupRelease) {
        this._closeThinkingMini();
        return;
      }
      // With the dropdown open, close it first (its info column already has
      // the full control, but the chip promises the mini). Closing re-renders
      // the button, so re-resolve the freshly-built chip as the anchor.
      if (this.dropdownOpen) this.closeDropdown();
      const anchor = /** @type {HTMLElement|null} */(this.querySelector('.model-selector-button .thinking-chip'));
      if (anchor) this._openThinkingMini(anchor);
    });
  }

  render() {
    // The button chip (the mini popover's anchor) is about to be replaced —
    // release the popover first so it never floats against a dead anchor.
    this._closeThinkingMini();

    const state = this._buttonDisplayState();
    const infoColumn = this._generateInfoColumn();
    const listContent = this._generateModelListContent();
    // Seed the non-destructive-update caches with what we're about to write,
    // so a subsequent in-place update only rewrites a column whose markup
    // genuinely differs from this freshly-rendered DOM.
    this._lastInfoHTML = infoColumn;
    this._lastListHTML = listContent;

    // Cite the switch-model shortcut (⌥⌘M / Ctrl+Alt+M) live from the central
    // table, so the tooltip stays correct if it's ever rebound or left unbound.
    const cycleModelKey = keyShortcutManager.formatBinding('cycle-model');
    const modelTitle = cycleModelKey ? `LLM Model (${cycleModelKey}, hold for menu)` : 'LLM Model';

    this.innerHTML = `
            <button class="model-selector-button input-ctrl-btn${state.hasOverride ? ' has-override' : ''}${state.modelUnavailable ? ' model-unavailable' : ''}${state.noModelSelected ? ' pulse' : ''}" id="model-button" title="${escapeHtml(modelTitle)}">
                ${this._buttonContentHTML(state)}
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

    this._wireChip();
  }
}

customElements.define('model-selector', ModelSelector);
