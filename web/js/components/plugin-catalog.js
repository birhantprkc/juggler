//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from '../registries/context-item-registry.js';
import strategyRegistry from '../registries/strategy-registry.js';
import commandRegistry from '../registries/command-registry.js';
import infoCardRegistry from '../registries/info-card-registry.js';
import fileViewerRegistry from '../registries/file-viewer-registry.js';
import { reloadRegistries } from '../registries/reload-registries.js';
import { fetchExtensions, fetchExtensionLocations } from '../services/extensions.js';
import { addFilePath } from '../utils/properties-panel-helpers.js';
import { renderMarkdown, looksLikeMarkdown } from '../../sdk/lib/markdown.js';
import { ExtensionSettingsEditor } from './settings/extensions-settings.js';

/**
 * @typedef {object} CapCard
 * @property {string} url - Served URL of the capability module
 * @property {'context-item'|'strategy'|'command'|'info-card'|'file-viewer'} itemType - Capability type
 * @property {string|null} id - Capability id (null if it failed to register)
 * @property {string} name - Display name
 * @property {string} description - Short description
 * @property {string} version - Capability version
 * @property {boolean} registered - Whether the capability loaded into a registry
 * @property {string|null} failed - Load error message, if the module failed to import
 * @property {boolean} disabled - Effective disabled state (own id or inherited from extension)
 * @property {boolean} inherited - Disabled solely because the whole extension is off
 * @property {string|null} path - Absolute on-disk path of the module file, or null when it has no revealable file (embedded builtin)
 */

/**
 * @typedef {object} ExtCard
 * @property {import('../services/extensions.js').ExtensionManifest} manifest - Extension manifest
 * @property {string} source - Provenance: 'builtin' | 'user'
 * @property {string|null} error - Manifest parse/validate error, if any
 * @property {string|null} extId - Extension id
 * @property {boolean} extDisabled - Whether the whole extension is disabled
 * @property {CapCard[]} caps - Bundled capabilities
 * @property {string|null} manifestPath - Absolute on-disk path of juggler.extension.json, or null when embedded (no revealable file)
 */

/** Capability-type → response key + display type. */
const CAP_TYPES = /** @type {const} */ ([
  ['contextItems', 'context-item'],
  ['strategies', 'strategy'],
  ['commands', 'command'],
  ['infoCards', 'info-card'],
  ['fileViewers', 'file-viewer'],
]);

/** Human labels for an extension's provenance. */
const SOURCE_LABELS = /** @type {Record<string, string>} */ ({
  builtin: 'built-in',
  user: 'user',
});

/**
 * Plain-language explanation for each known capability/extension permission.
 * Permissions are a *declaration* of the system access an extension's code uses
 * — surfaced with these descriptions so the badges aren't cryptic. They are
 * disclosure to inform the user's trust decision, not a sandbox the host
 * enforces (extensions run with full app privileges).
 */
const PERMISSION_INFO = /** @type {Record<string, string>} */ ({
  'filesystem.read': 'Read files and directories on your computer',
  'filesystem.write': 'Create, modify, and delete files on your computer',
  'shell.exec': 'Run shell commands on your computer',
  'web.fetch': 'Fetch content from the web over the network',
  'llm.generate': 'Generate text with a language model (uses your provider credits)',
});

/** Capability itemType → tree sub-heading, in display order under an extension. */
const CAP_SECTIONS = /** @type {ReadonlyArray<readonly [string, string]>} */ ([
  ['strategy', 'Strategies'],
  ['context-item', 'Context Items'],
  ['command', 'Commands'],
  ['info-card', 'Info Cards'],
  ['file-viewer', 'File Viewers'],
]);

/** Human label for a capability itemType (singular, title-cased). */
const TYPE_LABELS = /** @type {Record<string, string>} */ ({
  'context-item': 'Context Item',
  strategy: 'Strategy',
  command: 'Command',
  'info-card': 'Info Card',
  'file-viewer': 'File Viewer',
});

/**
 * Compute the next disabled-id list after toggling one id on or off. Adding is
 * idempotent (Set semantics); removing clears the id. The id may be a capability
 * id or an extension id — both live in the same flat disabled list.
 * @param {string[]} current - Current disabled ids
 * @param {string} targetId - Capability or extension id being toggled
 * @param {boolean} shouldEnable - true to enable (remove), false to disable (add)
 * @returns {string[]} The next disabled-id list
 */
export function computeNextDisabled(current, targetId, shouldEnable) {
  const set = new Set(current);
  if (shouldEnable) set.delete(targetId);
  else set.add(targetId);
  return [...set];
}

/**
 * Merge the extension catalog (metadata + served URLs) with per-capability
 * registry state (registered / disabled / failed) into renderable card models.
 * Pure: no DOM, no fetch — so it is unit-testable in isolation.
 * @param {import('../services/extensions.js').Extension[]} extensions - From fetchExtensions()
 * @param {Map<string, {id: string, manifest: any, itemType: string, disabled: boolean}>} entriesByPath - Registry entries keyed by served URL
 * @param {Map<string, string>} failedByPath - Load errors keyed by served URL
 * @param {Set<string>} disabledIds - Disabled capability/extension ids from config
 * @returns {ExtCard[]} One card per extension
 */
export function buildExtensionCards(extensions, entriesByPath, failedByPath, disabledIds) {
  return extensions.map((ext) => {
    const extId = ext.manifest?.id ?? null;
    const extDisabled = !!extId && disabledIds.has(extId);

    /** @type {CapCard[]} */
    const caps = [];
    for (const [key, itemType] of CAP_TYPES) {
      const urls = ext.capabilities?.[key] || [];
      for (const url of urls) {
        const reg = entriesByPath.get(url);
        const failed = failedByPath.get(url) ?? null;
        const capId = reg?.id ?? null;
        const selfDisabled = !!capId && disabledIds.has(capId);
        caps.push({
          url,
          itemType: /** @type {'context-item'|'strategy'|'command'|'info-card'|'file-viewer'} */ (itemType),
          id: capId,
          name: reg?.manifest?.name || url.split('/').pop() || url,
          description: reg?.manifest?.description || '',
          version: reg?.manifest?.version || '',
          registered: !!reg,
          failed,
          disabled: selfDisabled || extDisabled,
          inherited: extDisabled && !selfDisabled,
          path: ext.files?.[url] ?? null,
        });
      }
    }

    return {
      manifest: ext.manifest,
      source: ext.source,
      error: ext.error || null,
      extId,
      extDisabled,
      caps,
      manifestPath: ext.manifestPath ?? null,
    };
  });
}

/**
 * PluginCatalog — the Extensions view.
 *
 * Shows one card per installed extension (built-in core, user, and project),
 * with its metadata, bundled capabilities, and failed-load diagnostics. Each
 * extension and each capability has an enable/disable toggle; toggling writes
 * the merged disabled-id list to the config endpoint, then re-initialises the
 * registries in place (the same path as plugin hot reload) so the change takes
 * effect without a reload.
 * @class
 * @augments HTMLElement
 */
class PluginCatalog extends HTMLElement {
  constructor() {
    super();

    /** @type {ExtCard[]} */
    this._cards = [];

    /** @type {Set<string>} */
    this._disabledIds = new Set();

    /**
     * Enabled-id list carried verbatim from the config endpoint so a disabled
     * write does not clobber it (the endpoint overwrites both lists).
     * @type {string[]}
     */
    this._enabledIds = [];

    /** @type {Array<{path: string, error: string}>} */
    this._failedModules = [];

    /**
     * Guards against overlapping toggles re-entering the re-init path.
     * @type {boolean}
     */
    this._busy = false;

    /**
     * Key of the currently selected sidebar entry (`ext:<id>` for an extension,
     * `cap:<itemType>:<id|url>` for a capability), or null before first render.
     * @type {string|null}
     */
    this._selectedKey = null;

    /**
     * The left sidebar scroll container, retained so a toggle can rebuild its
     * entries in place (preserving scroll) instead of tearing down the view.
     * @type {HTMLElement|null}
     */
    this._sidebar = null;

    /**
     * The right detail pane, retained so selecting an entry swaps only its
     * contents (the sidebar and its scroll position stay put).
     * @type {HTMLElement|null}
     */
    this._detailPanel = null;

    /**
     * The first load+render, retained so an outside caller (revealCapability)
     * can wait for the catalog to be ready instead of racing it.
     * @type {Promise<void>|null}
     */
    this._ready = null;

    /**
     * Keys of extension tree nodes whose children are expanded. `null` means
     * "not yet initialised" — the first render expands every extension so the
     * tree opens fully revealed; thereafter the user's collapses are remembered.
     * @type {Set<string>|null}
     */
    this._expanded = null;
  }

  /** Called when the component is inserted into the DOM. */
  connectedCallback() {
    this.classList.add('plugin-catalog');
    this._ready = this._init();
  }

  /**
   * Select one capability's entry from outside the catalog — the deep-link the
   * properties-panel header badge follows. Waits for the first load so a click
   * arriving while the catalog is still fetching still lands on the right row,
   * and scrolls the row into view since the target is usually well down the tree.
   * @param {string} itemType - Capability type, e.g. 'context-item'
   * @param {string} capId - The capability's registry id
   * @returns {Promise<boolean>} True when the capability was found and selected
   */
  async revealCapability(itemType, capId) {
    if (this._ready) await this._ready;
    const key = `cap:${itemType}:${capId}`;
    if (!this._buildEntries().some((e) => e.key === key)) return false;
    this._select(key);
    const row = /** @type {HTMLElement|null} */ (this._sidebar?.querySelector('.plugin-tree-row.selected') ?? null);
    row?.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  /**
   * Load data then render. Kept separate from connectedCallback so tests can
   * drive it without mounting.
   * @private
   * @returns {Promise<void>}
   */
  async _init() {
    await this._loadData();
    this.render();
  }

  /**
   * Assemble the card models: extension metadata from the catalog endpoint,
   * cross-referenced with the three registries' loaded/disabled/failed state.
   * @private
   * @returns {Promise<void>}
   */
  async _loadData() {
    const extensions = await fetchExtensions();
    this._disabledIds = await this._fetchConfig();

    const entriesByPath = this._collectRegistryEntries();
    const failedByPath = this._collectFailed();

    this._cards = buildExtensionCards(extensions, entriesByPath, failedByPath, this._disabledIds);
    this._failedModules = [...failedByPath.entries()].map(([path, error]) => ({ path, error }));
  }

  /**
   * Build a served-URL → registry-entry map across all three registries,
   * including disabled capabilities (still loaded, still have a manifest).
   * @private
   * @returns {Map<string, {id: string, manifest: any, itemType: string, disabled: boolean}>} Registry entries keyed by served URL
   */
  _collectRegistryEntries() {
    /** @type {Map<string, {id: string, manifest: any, itemType: string, disabled: boolean}>} */
    const byPath = new Map();
    const regs = /** @type {const} */ ([
      [contextItemRegistry, 'context-item'],
      [strategyRegistry, 'strategy'],
      [commandRegistry, 'command'],
      [infoCardRegistry, 'info-card'],
      [fileViewerRegistry, 'file-viewer'],
    ]);
    for (const [reg, itemType] of regs) {
      for (const m of reg.getCatalogManifests()) {
        if (m.modulePath) {
          byPath.set(m.modulePath, { id: m.id, manifest: m.manifest, itemType, disabled: m.disabled });
        }
      }
    }
    return byPath;
  }

  /**
   * Collect failed module loads (served URL → error) across all registries.
   * @private
   * @returns {Map<string, string>} Load errors keyed by served URL
   */
  _collectFailed() {
    /** @type {Map<string, string>} */
    const failed = new Map();
    for (const reg of [contextItemRegistry, strategyRegistry, commandRegistry, infoCardRegistry]) {
      for (const { path, error } of reg.getFailedModules()) {
        failed.set(path, error);
      }
    }
    return failed;
  }

  /**
   * Fetch the disabled/enabled config lists. Stashes `enabled` for re-sending.
   * @private
   * @returns {Promise<Set<string>>} The disabled-id set
   */
  async _fetchConfig() {
    try {
      const response = await fetch('/api/config/plugins');
      if (!response.ok) {
        this._enabledIds = [];
        return new Set();
      }
      const { disabled, enabled } = await response.json();
      this._enabledIds = Array.isArray(enabled) ? enabled : [];
      return new Set(Array.isArray(disabled) ? disabled : []);
    } catch {
      this._enabledIds = [];
      return new Set();
    }
  }

  /**
   * Persist the disabled-id list, preserving the enabled list.
   * @param {string[]} disabledList - The new disabled-id list
   * @private
   * @returns {Promise<void>}
   */
  async _persist(disabledList) {
    const resp = await fetch('/api/config/plugins', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: disabledList, enabled: this._enabledIds }),
    });
    if (!resp.ok) throw new Error(`Failed to save extension config (${resp.status})`);
  }

  /**
   * Fetch authoritative server activity before a registry-affecting toggle.
   * @private
   * @returns {Promise<{active: boolean, conversationIds: string[]}>} Active flag and active conversation IDs
   */
  async _fetchActiveHealth() {
    const resp = await fetch('/api/health/active');
    if (!resp.ok) return { active: false, conversationIds: [] };
    const data = await resp.json();
    return {
      active: !!data.active,
      conversationIds: Array.isArray(data.conversationIds) ? data.conversationIds : [],
    };
  }

  /**
   * Resolve the currently attached UI session, when this catalog is in the main app.
   * @private
   * @returns {import('../model/session.js').default|null} Active app session or null
   */
  _getSession() {
    return /** @type {any} */ (window).jugglerApp?._connectionManager?.getSession?.() || null;
  }

  /**
   * If any conversation has a live turn, ask the operator before cancelling all
   * local active conversations and applying the extension-set change.
   * @private
   * @returns {Promise<boolean>} true when it is safe to persist the toggle
   */
  async _quiesceBeforeToggle() {
    const health = await this._fetchActiveHealth();
    if (!health.active) return true;

    const count = health.conversationIds.length || 1;
    const confirmed = await /** @type {any} */ (window).showConfirm?.(
      `${count} conversation${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} running. ` +
      'Changing extensions will stop them so the capability set can be safely rebuilt.',
      'Stop conversations and apply extension change?',
      { confirmText: 'Stop & apply', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return false;

    const session = this._getSession();
    if (session?.cancelAllActiveConversations) {
      await session.cancelAllActiveConversations(health.conversationIds);
    }

    // Worker truth is authoritative. If another client started work, or a local
    // conversation was not loaded here, do not persist into a still-active engine.
    const after = await this._fetchActiveHealth();
    if (after.active) {
      throw new Error('Could not stop all active conversations; extension change was not applied.');
    }
    return true;
  }

  /**
   * Re-initialise the three registries from the (now updated) config — the same
   * teardown/rebuild used by plugin hot reload, so a toggle applies live. Shared
   * `reloadRegistries()` also announces the change (REGISTRIES_RELOADED) so the
   * strategy menu and other registry-backed UI refresh.
   * @private
   * @returns {Promise<void>}
   */
  async _reinitRegistries() {
    await reloadRegistries();
  }

  /**
   * Toggle one-or-more capability/extension ids on/off together: persist,
   * re-init registries, reload data, refresh the cards in place. Multiple ids
   * travel together so a strategy and the context items it owns enable/disable
   * as a unit. Overlapping toggles are ignored while one is in flight so the
   * live re-init isn't re-entered.
   * @param {string|string[]} target - Capability/extension id, or a set of ids to toggle together
   * @param {boolean} shouldEnable - true to enable, false to disable
   * @private
   * @returns {Promise<void>}
   */
  async _toggle(target, shouldEnable) {
    const ids = (Array.isArray(target) ? target : [target]).filter(Boolean);
    if (this._busy || ids.length === 0) return;
    this._busy = true;
    try {
      let next = [...this._disabledIds];
      const enabled = new Set(this._enabledIds);
      for (const id of ids) {
        next = computeNextDisabled(next, id, shouldEnable);
        if (shouldEnable) enabled.add(id);
        else enabled.delete(id);
      }
      this._enabledIds = [...enabled];
      if (!await this._quiesceBeforeToggle()) return;
      await this._persist(next);
      await this._reinitRegistries();
      await this._loadData();
      this._refreshCards();
    } catch (err) {
      console.error('[PluginCatalog] Failed to apply toggle:', err);
    } finally {
      this._busy = false;
    }
  }

  /** Render the catalog as a master/detail view. */
  render() {
    this.innerHTML = '';
    this.appendChild(this._renderHeader());

    if (this._failedModules.length > 0) {
      this.appendChild(this._renderFailedBanner());
    }

    const entries = this._buildEntries();
    if (entries.length === 0) {
      this.appendChild(this._createElement('div', 'catalog-empty', 'No extensions installed'));
      return;
    }

    // Default to (or recover) a valid selection.
    const firstEntry = entries[0];
    if (firstEntry && !entries.some((e) => e.key === this._selectedKey)) {
      this._selectedKey = firstEntry.key;
    }

    const main = this._createElement('div', 'catalog-main');
    this._sidebar = this._renderSidebar(entries);
    this._detailPanel = this._createElement('div', 'catalog-detail-panel');
    main.appendChild(this._sidebar);
    main.appendChild(this._detailPanel);
    this.appendChild(main);
    this._renderDetailInto(entries);

    // Install-location paths (async footer).
    this._renderLocations();
  }

  /**
   * Build the catalog header: title, extension/capability counts, and a short
   * explanation of what the view is for.
   * @returns {HTMLElement} The header element
   * @private
   */
  _renderHeader() {
    const header = this._createElement('header', 'catalog-header');
    const left = this._createElement('div', 'catalog-header-left');
    left.appendChild(this._createElement('h2', 'catalog-title', 'Extensions'));
    const extCount = this._cards.length;
    const capCount = this._cards.reduce((n, c) => n + c.caps.length, 0);
    left.appendChild(this._createElement('div', 'catalog-subtitle',
      `${extCount} extension${extCount === 1 ? '' : 's'}, ${capCount} capabilities`));
    header.appendChild(left);

    const right = this._createElement('div', 'catalog-header-right');
    right.appendChild(this._createElement('p', 'catalog-explanation',
      'A Juggler extension is a bundle of strategies, context items, and commands.'));
    header.appendChild(right);
    return header;
  }

  /**
   * Flatten the card models into selectable sidebar entries: one per extension
   * and one per standalone capability. Each entry knows its owning extension
   * (`extKey`) and, for capabilities, its type section, so `_fillSidebar` can
   * render them as a tree. The flat order is extension-then-its-capabilities
   * so `entries[0]` is the first extension — a sensible default selection.
   * @returns {Array<{key: string, kind: 'extension'|'cap', extKey: string, section: string, label: string, card: ExtCard, cap?: CapCard, disabled: boolean, failed: boolean, status: string}>} One entry per extension and per capability
   * @private
   */
  _buildEntries() {
    /** @type {ReturnType<PluginCatalog['_buildEntries']>} */
    const entries = [];

    for (const card of this._cards) {
      const extKey = `ext:${card.extId || card.manifest?.name || 'extension'}`;
      entries.push({
        key: extKey,
        kind: 'extension',
        extKey,
        section: 'Extensions',
        label: card.manifest?.name || card.extId || 'Extension',
        card,
        disabled: card.extDisabled,
        failed: !!card.error,
        status: card.error ? 'error' : (card.extDisabled ? 'off' : ''),
      });

      for (const [itemType, section] of CAP_SECTIONS) {
        for (const cap of card.caps) {
          if (cap.itemType !== itemType) continue;
          entries.push({
            key: `cap:${itemType}:${cap.id || cap.url}`,
            kind: 'cap',
            extKey,
            section,
            label: cap.name,
            card,
            cap,
            disabled: cap.disabled,
            failed: !!cap.failed,
            status: cap.failed ? 'failed' : (cap.disabled ? 'off' : ''),
          });
        }
      }
    }
    return entries;
  }

  /**
   * Build the left sidebar: a scroll container filled with the extension tree.
   * @param {ReturnType<PluginCatalog['_buildEntries']>} entries - Sidebar entries
   * @returns {HTMLElement} The sidebar element
   * @private
   */
  _renderSidebar(entries) {
    const sidebar = this._createElement('div', 'catalog-sidebar');
    this._fillSidebar(sidebar, entries);
    return sidebar;
  }

  /**
   * Fill (or refill) the sidebar with the extension tree: each extension is a
   * top-level node, its capabilities nested beneath under per-type sub-headings
   * (Strategies, Context Items, Commands), shown only while the node is
   * expanded. Replacing the children in place preserves the container's scroll
   * position, so a toggle's refresh doesn't jump the tree (no save/restore
   * scroll hack).
   * @param {HTMLElement} sidebar - The sidebar scroll container
   * @param {ReturnType<PluginCatalog['_buildEntries']>} entries - Sidebar entries
   * @private
   */
  _fillSidebar(sidebar, entries) {
    // First real render seeds expansion: every extension open.
    if (this._expanded === null) {
      this._expanded = new Set(entries.filter((e) => e.kind === 'extension').map((e) => e.key));
    }

    const tree = this._createElement('div', 'plugin-tree');
    for (const ext of entries.filter((e) => e.kind === 'extension')) {
      const node = this._createElement('div', 'plugin-tree-node');
      const isOpen = this._expanded.has(ext.key);
      node.appendChild(this._renderTreeExtension(ext, isOpen));

      if (isOpen) {
        const children = this._createElement('div', 'plugin-tree-children');
        const caps = entries.filter((e) => e.kind === 'cap' && e.extKey === ext.key);
        for (const [, section] of CAP_SECTIONS) {
          const inSection = caps.filter((e) => e.section === section);
          if (inSection.length === 0) continue;
          children.appendChild(this._createElement('div', 'plugin-tree-section', section));
          for (const cap of inSection) children.appendChild(this._renderTreeCap(cap));
        }
        if (caps.length === 0) {
          children.appendChild(this._createElement('div', 'plugin-tree-empty', 'No capabilities'));
        }
        node.appendChild(children);
      }
      tree.appendChild(node);
    }
    sidebar.replaceChildren(tree);
  }

  /**
   * Render an extension's tree row: an expand/collapse caret plus the
   * selectable extension label and an on/off toggle. The caret toggles the
   * children; the label selects the extension; the toggle enables/disables it.
   * @param {ReturnType<PluginCatalog['_buildEntries']>[number]} entry - Extension entry
   * @param {boolean} isOpen - Whether this extension's children are expanded
   * @returns {HTMLElement} The row element
   * @private
   */
  _renderTreeExtension(entry, isOpen) {
    const row = this._createElement('div', 'plugin-tree-row plugin-tree-ext');
    row.dataset.key = entry.key;
    if (entry.key === this._selectedKey) row.classList.add('selected');
    if (entry.failed) row.classList.add('plugin-tree-row-failed');
    else if (entry.disabled) row.classList.add('plugin-tree-row-off');

    const caret = this._createElement('span', 'plugin-tree-caret', isOpen ? '▾' : '▸');
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleExpanded(entry.key);
    });
    row.appendChild(caret);

    row.appendChild(this._createElement('span', 'plugin-tree-label', entry.label));
    row.appendChild(this._renderToggleBadge(entry));
    row.addEventListener('click', () => this._select(entry.key));
    return row;
  }

  /**
   * Render a capability's tree row: an indented, selectable leaf with an on/off
   * toggle (no caret — capabilities have no children of their own in the tree; a
   * strategy's owned items live in its detail).
   * @param {ReturnType<PluginCatalog['_buildEntries']>[number]} entry - Capability entry
   * @returns {HTMLElement} The row element
   * @private
   */
  _renderTreeCap(entry) {
    const row = this._createElement('div', 'plugin-tree-row plugin-tree-leaf');
    row.dataset.key = entry.key;
    if (entry.key === this._selectedKey) row.classList.add('selected');
    if (entry.failed) row.classList.add('plugin-tree-row-failed');
    else if (entry.disabled) row.classList.add('plugin-tree-row-off');
    row.appendChild(this._createElement('span', 'plugin-tree-label', entry.label));
    row.appendChild(this._renderToggleBadge(entry));
    row.addEventListener('click', () => this._select(entry.key));
    return row;
  }

  /**
   * Render the on/off toggle badge for a tree row — the primary enable/disable
   * control (there is no toggle in the detail pane). It reads as a status pill
   * and acts as a button: clicking flips the row's enabled state in place,
   * carrying any context items a strategy owns along with it.
   *
   * Non-interactive states:
   * - `failed` — the module didn't load; nothing to toggle.
   * - a capability whose extension is off — it can't be enabled on its own;
   *   the badge shows `off` but is inert (enable the extension first).
   *
   * The click is stopped from bubbling so toggling doesn't also select the row.
   * @param {ReturnType<PluginCatalog['_buildEntries']>[number]} entry - Tree entry
   * @returns {HTMLElement} The badge/button element
   * @private
   */
  _renderToggleBadge(entry) {
    if (entry.failed) {
      return this._createElement('span', 'plugin-tree-toggle plugin-tree-toggle-failed', 'failed');
    }

    const isExt = entry.kind === 'extension';
    const enabled = !entry.disabled;
    const ids = /** @type {string[]} */ ((isExt
      ? [entry.card.extId]
      : [entry.cap?.id]).filter(Boolean));
    const canToggle = isExt ? !!entry.card.extId : (!!entry.cap?.id && !entry.card.extDisabled);

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = `plugin-tree-toggle plugin-tree-toggle-${enabled ? 'on' : 'off'}`;
    badge.textContent = enabled ? 'on' : 'off';
    badge.dataset.testid = `toggle-${entry.key}`;

    if (!canToggle) {
      badge.disabled = true;
      if (!isExt && entry.card.extDisabled) {
        badge.title = 'Enable the extension to toggle this capability';
      }
    } else {
      badge.title = enabled ? 'Click to disable' : 'Click to enable';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggle(ids, !enabled);
      });
    }
    return badge;
  }

  /**
   * Expand or collapse one extension node, then rebuild the tree in place. Only
   * the sidebar tree changes — the detail pane and selection are untouched.
   * @param {string} extKey - The extension entry key to toggle
   * @private
   */
  _toggleExpanded(extKey) {
    if (!this._expanded) this._expanded = new Set();
    if (this._expanded.has(extKey)) this._expanded.delete(extKey);
    else this._expanded.add(extKey);
    if (this._sidebar) this._fillSidebar(this._sidebar, this._buildEntries());
  }

  /**
   * Select a sidebar entry: highlight its tree row and swap the detail pane to
   * its contents. Only `.selected` flags and the detail pane change — the
   * sidebar element and its scroll position are untouched.
   * @param {string} key - The entry key to select
   * @private
   */
  _select(key) {
    this._selectedKey = key;
    const entries = this._buildEntries();

    // Reveal the selection: ensure its owning extension is expanded so the row
    // exists to highlight (covers cross-links from the detail pane into a
    // currently-collapsed extension). Rebuild the tree when expansion changed,
    // otherwise just move the `.selected` flag.
    const entry = entries.find((e) => e.key === key);
    if (this._sidebar && entry && this._expanded && !this._expanded.has(entry.extKey)) {
      this._expanded.add(entry.extKey);
      this._fillSidebar(this._sidebar, entries);
    } else if (this._sidebar) {
      this._sidebar.querySelectorAll('.plugin-tree-row').forEach((el) => {
        el.classList.toggle('selected', /** @type {HTMLElement} */ (el).dataset.key === key);
      });
    }
    this._renderDetailInto(entries);
    if (this._detailPanel) this._detailPanel.scrollTop = 0;
  }

  /**
   * Render the detail pane for the current selection into `this._detailPanel`.
   * @param {ReturnType<PluginCatalog['_buildEntries']>} entries - Sidebar entries
   * @private
   */
  _renderDetailInto(entries) {
    if (!this._detailPanel) return;
    const entry = entries.find((e) => e.key === this._selectedKey);
    if (!entry) {
      this._detailPanel.replaceChildren(
        this._createElement('div', 'catalog-detail-empty', 'Select an item to view its details'));
      return;
    }
    const detail = entry.kind === 'extension'
      ? this._renderExtensionDetail(entry.card)
      : this._renderCapDetailFull(/** @type {CapCard} */ (entry.cap), entry.card);
    this._detailPanel.replaceChildren(detail);
  }

  /**
   * Rebuild the sidebar entries and detail pane in place after a toggle. The
   * set of entries is unchanged (a toggle only flips disabled state), so the
   * sidebar element keeps its identity and scroll position; only its rows and
   * the detail contents are rebuilt. Falls back to a full render if the layout
   * hasn't been built yet.
   * @private
   */
  _refreshCards() {
    if (!this._sidebar || !this._sidebar.isConnected) {
      this.render();
      return;
    }
    const entries = this._buildEntries();
    if (!entries.some((e) => e.key === this._selectedKey)) {
      this._selectedKey = entries[0]?.key ?? null;
    }
    this._fillSidebar(this._sidebar, entries);
    this._renderDetailInto(entries);
  }

  /**
   * Render the failed-load diagnostics banner.
   * @returns {HTMLElement} The banner element
   * @private
   */
  _renderFailedBanner() {
    const banner = this._createElement('div', 'catalog-failed-banner');
    banner.appendChild(this._createElement('div', 'catalog-failed-title',
      `${this._failedModules.length} capability module(s) failed to load`));
    for (const { path, error } of this._failedModules) {
      const entry = this._createElement('div', 'catalog-failed-entry');
      entry.appendChild(this._createElement('code', 'catalog-failed-path', path));
      entry.appendChild(this._createElement('span', 'catalog-failed-error', error));
      banner.appendChild(entry);
    }
    return banner;
  }

  /**
   * Render the detail pane for a whole extension: identity, source, an explained
   * permissions section, and a list of the capabilities it bundles (each
   * selectable). Enabling/disabling is done from the tree's on/off badge, not
   * here — the detail pane only reports state.
   * @param {ExtCard} card - Card model
   * @returns {HTMLElement} The detail element
   * @private
   */
  _renderExtensionDetail(card) {
    const container = this._createElement('div', 'plugin-detail-container');

    const header = this._createElement('div', 'plugin-detail-header');
    const titleRow = this._createElement('div', 'plugin-title-row');
    titleRow.appendChild(this._createElement('h3', 'plugin-detail-name',
      card.manifest?.name || card.extId || 'Extension'));

    const badges = this._createElement('div', 'plugin-badges');
    if (card.manifest?.version) {
      badges.appendChild(this._createElement('span', 'plugin-badge plugin-version', `v${card.manifest.version}`));
    }
    if (card.manifest?.author) {
      badges.appendChild(this._createElement('span', 'plugin-badge plugin-author', card.manifest.author));
    }
    badges.appendChild(this._createElement('span', `plugin-badge ext-source ext-source-${card.source}`,
      SOURCE_LABELS[card.source] || card.source));
    if (card.extDisabled) {
      badges.appendChild(this._createElement('span', 'plugin-badge ext-cap-status-disabled', 'disabled'));
    }
    titleRow.appendChild(badges);
    header.appendChild(titleRow);

    if (card.extId) {
      const idRow = this._createElement('div', 'plugin-id-container');
      idRow.appendChild(this._createElement('span', 'plugin-id-label', 'ID:'));
      idRow.appendChild(this._createElement('code', 'plugin-id-value', card.extId));
      header.appendChild(idRow);
    }
    container.appendChild(header);

    const content = this._createElement('div', 'plugin-detail-content');
    if (card.error) {
      content.appendChild(this._createElement('div', 'ext-card-error-msg', card.error));
    }
    const file = this._renderSourceFileSection(card.manifestPath, 'Manifest File');
    if (file) content.appendChild(file);
    const perms = this._permissionsSection(card.manifest?.permissions);
    if (perms) content.appendChild(perms);
    if (card.extId && Array.isArray(card.manifest?.settings) && card.manifest.settings.length > 0) {
      content.appendChild(new ExtensionSettingsEditor(card.manifest).render());
    }
    if (card.caps.length > 0) content.appendChild(this._renderBundledCaps(card));
    container.appendChild(content);

    return container;
  }

  /**
   * Render a "Source File" section showing the module/manifest's on-disk path
   * with our standard file-path control (copy + reveal-in-Finder, right-click
   * Open/Reveal/Copy). Returns null when there is no revealable file (e.g. an
   * extension embedded in the production binary).
   * @param {string|null} filePath - Absolute on-disk path, or null
   * @param {string} [title] - Section heading (default 'Source File')
   * @returns {HTMLElement|null} The section, or null if no path
   * @private
   */
  _renderSourceFileSection(filePath, title = 'Source File') {
    if (!filePath) return null;
    const section = this._createElement('section', 'plugin-section');
    const head = this._createElement('header', 'plugin-section-header');
    head.appendChild(this._createElement('h5', 'plugin-section-title', title));
    section.appendChild(head);
    addFilePath(section, filePath);
    return section;
  }

  /**
   * Render the "Bundled Capabilities" section of an extension's detail: a
   * selectable row per capability. Clicking a row navigates to that
   * capability's detail.
   * @param {ExtCard} card - Owning extension card
   * @returns {HTMLElement} The section element
   * @private
   */
  _renderBundledCaps(card) {
    const section = this._createElement('section', 'plugin-section');
    const head = this._createElement('header', 'plugin-section-header');
    head.appendChild(this._createElement('h5', 'plugin-section-title', 'Bundled Capabilities'));
    head.appendChild(this._createElement('div', 'plugin-section-explanation',
      'The strategies, context items, and commands this extension provides. Select one to see its details.'));
    section.appendChild(head);

    const list = this._createElement('div', 'ext-cap-list');
    for (const cap of card.caps) {
      list.appendChild(this._renderBundledCapRow(cap));
    }
    section.appendChild(list);
    return section;
  }

  /**
   * Render a single selectable capability row inside an extension's detail.
   * @param {CapCard} cap - Capability model
   * @returns {HTMLElement} The row element
   * @private
   */
  _renderBundledCapRow(cap) {
    const row = this._createElement('div', 'ext-cap ext-cap-link');
    if (cap.failed) row.classList.add('ext-cap-failed');
    else if (cap.disabled) row.classList.add('ext-cap-disabled');

    const main = this._createElement('div', 'ext-cap-main');
    main.appendChild(this._createElement('span', 'ext-cap-name', cap.name));
    main.appendChild(this._createElement('span',
      `ext-cap-type ext-cap-type-${cap.itemType}`, TYPE_LABELS[cap.itemType] || cap.itemType));
    if (cap.failed) {
      main.appendChild(this._createElement('span', 'ext-cap-status ext-cap-status-failed', 'failed to load'));
    } else if (cap.disabled) {
      main.appendChild(this._createElement('span', 'ext-cap-status ext-cap-status-disabled',
        cap.inherited ? 'disabled (extension off)' : 'disabled'));
    }
    row.appendChild(main);
    if (cap.description) row.appendChild(this._createElement('div', 'ext-cap-desc', cap.description));
    if (cap.id || cap.url) {
      row.addEventListener('click', () => this._select(`cap:${cap.itemType}:${cap.id || cap.url}`));
    }
    return row;
  }

  /**
   * Render the full detail pane for a single capability: identity, description,
   * an explained permissions section, tool definitions, and strategy
   * recommendations. Enabling/disabling is done from the tree's on/off badge,
   * not here — the detail pane only reports state.
   * @param {CapCard} cap - Capability model
   * @param {ExtCard} card - Owning extension card
   * @returns {HTMLElement} The detail element
   * @private
   */
  _renderCapDetailFull(cap, card) {
    const container = this._createElement('div', 'plugin-detail-container');
    container.dataset.pluginType = cap.itemType;

    const header = this._createElement('div', 'plugin-detail-header');
    const titleRow = this._createElement('div', 'plugin-title-row');
    titleRow.appendChild(this._createElement('h3', 'plugin-detail-name', cap.name));

    const badges = this._createElement('div', 'plugin-badges');
    badges.appendChild(this._createElement('span',
      `plugin-badge ext-cap-type ext-cap-type-${cap.itemType}`, TYPE_LABELS[cap.itemType] || cap.itemType));
    if (cap.version) {
      badges.appendChild(this._createElement('span', 'plugin-badge plugin-version', `v${cap.version}`));
    }
    if (cap.failed) {
      badges.appendChild(this._createElement('span', 'plugin-badge ext-cap-status-failed', 'failed to load'));
    } else if (cap.disabled) {
      badges.appendChild(this._createElement('span', 'plugin-badge ext-cap-status-disabled',
        cap.inherited ? 'disabled (extension off)' : 'disabled'));
    }
    titleRow.appendChild(badges);
    header.appendChild(titleRow);

    if (cap.id) {
      const idRow = this._createElement('div', 'plugin-id-container');
      idRow.appendChild(this._createElement('span', 'plugin-id-label', 'ID:'));
      idRow.appendChild(this._createElement('code', 'plugin-id-value', cap.id));
      header.appendChild(idRow);
    }

    const extName = card.manifest?.name || card.extId;
    if (extName) {
      const fromRow = this._createElement('div', 'plugin-detail-from');
      fromRow.appendChild(this._createElement('span', 'plugin-id-label', 'From extension:'));
      const link = this._createElement('span', 'plugin-detail-from-link', extName);
      link.addEventListener('click',
        () => this._select(`ext:${card.extId || card.manifest?.name}`));
      fromRow.appendChild(link);
      header.appendChild(fromRow);
    }

    if (cap.description) {
      header.appendChild(this._createProse('div', 'plugin-description', cap.description));
    }
    container.appendChild(header);

    const content = this._createElement('div', 'plugin-detail-content');
    if (cap.failed) {
      content.appendChild(this._createElement('div', 'ext-cap-error', cap.failed));
    }
    const file = this._renderSourceFileSection(cap.path);
    if (file) content.appendChild(file);

    const ItemClass = this._classFor(cap);
    if (ItemClass) {
      const perms = this._renderPermissions(ItemClass);
      if (perms) content.appendChild(perms);
      const tools = this._renderToolDefinitions(ItemClass);
      if (tools) content.appendChild(tools);
      if (cap.itemType === 'strategy') {
        const recs = this._renderStrategyRecommendations(ItemClass);
        if (recs) content.appendChild(recs);
      }
    }

    if (content.children.length === 0) {
      content.appendChild(this._createElement('div', 'catalog-detail-empty',
        'No further details for this capability.'));
    }
    container.appendChild(content);
    return container;
  }

  /**
   * Render an explained permissions section: each permission badge paired with
   * a plain-language description of the access it grants, under a heading that
   * says what permissions are. Returns null when there are none.
   * @param {string[]|undefined} permissions - Permission identifiers
   * @returns {HTMLElement|null} The section, or null if no permissions
   * @private
   */
  _permissionsSection(permissions) {
    if (!Array.isArray(permissions) || permissions.length === 0) return null;

    const section = this._createElement('section', 'plugin-section');
    const head = this._createElement('header', 'plugin-section-header');
    head.appendChild(this._createElement('h5', 'plugin-section-title', 'Permissions'));
    head.appendChild(this._createElement('div', 'plugin-section-explanation',
      'What this extension declares it does with your computer — so you can decide whether to trust it. '
      + 'This is disclosure, not a limit the app enforces; enabled extensions run with full privileges.'));
    section.appendChild(head);

    const list = this._createElement('div', 'permissions-explained');
    for (const p of permissions) {
      const item = this._createElement('div', 'permission-explained-item');
      item.appendChild(this._createElement('code', 'permission-badge', p));
      item.appendChild(this._createElement('span', 'permission-explained-desc',
        PERMISSION_INFO[p] || 'Custom permission required by this extension'));
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  /**
   * Resolve the loaded class for a capability via its registry, including
   * disabled items — a disabled capability keeps its class, so its detail pane
   * shows the full properties (permissions, tools, recommendations) rather than
   * hiding them while it's off.
   * @param {CapCard} cap - Capability model
   * @returns {any} The class, or undefined
   * @private
   */
  _classFor(cap) {
    if (!cap.id) return undefined;
    if (cap.itemType === 'strategy') return strategyRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'command') return commandRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'info-card') return infoCardRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'file-viewer') return fileViewerRegistry.getIncludingDisabled(cap.id);
    return contextItemRegistry.getIncludingDisabled(cap.id);
  }

  /**
   * Render an install-locations footer: where extensions live on disk, so a
   * developer knows where to drop new ones.
   * @private
   * @returns {Promise<void>}
   */
  async _renderLocations() {
    try {
      const loc = await fetchExtensionLocations();
      const rows = [
        ['Extensions (global)', loc.userExtensions],
      ].filter(([, p]) => p);
      if (rows.length === 0) return;

      const footer = this._createElement('div', 'catalog-plugin-dirs');
      footer.appendChild(this._createElement('span', 'catalog-plugin-dirs-label', 'Install locations: '));
      for (const [label, p] of rows) {
        footer.appendChild(this._createElement('code', 'catalog-plugin-dir-path', `${label}: ${p}`));
      }
      this.appendChild(footer);
    } catch {
      // Silently skip if location info is unavailable.
    }
  }

  /**
   * Render the required-permissions section for a capability class.
   * @param {any} ItemClass - Plugin class
   * @returns {HTMLElement|null} The section, or null if no permissions
   * @private
   */
  _renderPermissions(ItemClass) {
    if (!ItemClass || !ItemClass.MANIFEST) return null;
    return this._permissionsSection(ItemClass.MANIFEST.permissions);
  }

  /**
   * Render strategy recommendations section.
   * @param {any} ItemClass - Strategy class
   * @returns {HTMLElement|null} The section, or null if none
   * @private
   */
  _renderStrategyRecommendations(ItemClass) {
    if (!ItemClass || !ItemClass.MANIFEST || !ItemClass.MANIFEST.recommendations) return null;
    const rec = ItemClass.MANIFEST.recommendations;
    const section = this._createElement('section', 'plugin-section');

    const header = this._createElement('header', 'plugin-section-header');
    header.appendChild(this._createElement('h5', 'plugin-section-title', 'Strategy Recommendations'));
    section.appendChild(header);

    const container = this._createElement('div', 'strategy-recommendations');

    if (rec.recommendedFor && rec.recommendedFor.length > 0) {
      const group = this._createElement('div', 'recommendation-group');
      group.appendChild(this._createElement('div', 'recommendation-label', 'Recommended For:'));
      const list = this._createElement('div', 'recommendation-badges');
      for (const item of rec.recommendedFor) {
        list.appendChild(this._createElement('span', 'recommendation-badge', item));
      }
      group.appendChild(list);
      container.appendChild(group);
    }

    if (rec.approach) {
      const group = this._createElement('div', 'recommendation-group');
      group.appendChild(this._createElement('div', 'recommendation-label', 'Approach:'));
      group.appendChild(this._createProse('div', 'approach-text', rec.approach));
      container.appendChild(group);
    }

    section.appendChild(container);
    return section;
  }

  /**
   * Render tool definitions (what the LLM can call) for a capability class.
   * @param {any} ItemClass - Plugin class
   * @returns {HTMLElement|null} The section, or null if no tools
   * @private
   */
  _renderToolDefinitions(ItemClass) {
    if (!ItemClass || typeof ItemClass.getToolDefinitions !== 'function') return null;
    const tools = ItemClass.getToolDefinitions();
    if (!tools || tools.length === 0) return null;

    const section = this._createElement('section', 'plugin-section');
    const header = this._createElement('header', 'plugin-section-header');
    header.appendChild(this._createElement('h5', 'plugin-section-title', 'Tools'));
    section.appendChild(header);

    const list = this._createElement('div', 'tools-list');
    for (const tool of tools) {
      const toolEl = this._createElement('div', 'tool-item');

      const toolHeader = this._createElement('div', 'tool-header');
      toolHeader.appendChild(this._createElement('code', 'tool-name', tool.name));
      if (tool.category) {
        toolHeader.appendChild(this._createElement('span', `tool-category tool-category-${tool.category}`, tool.category));
      }
      toolEl.appendChild(toolHeader);

      if (tool.description) {
        toolEl.appendChild(this._createElement('div', 'tool-description', tool.description));
      }

      if (tool.input_schema?.properties) {
        const required = tool.input_schema.required || [];
        const params = this._createElement('div', 'tool-params-list');
        for (const [propName, propDef] of Object.entries(tool.input_schema.properties)) {
          const prop = /** @type {{type?: string, description?: string}} */ (propDef);
          const param = this._createElement('div', 'tool-param');
          const paramHeader = this._createElement('div', 'tool-param-header');
          paramHeader.appendChild(this._createElement('code', 'tool-param-name', propName));
          if (prop.type) {
            paramHeader.appendChild(this._createElement('span', 'tool-param-type', prop.type));
          }
          const reqClass = required.includes(propName) ? 'tool-param-required' : 'tool-param-optional';
          paramHeader.appendChild(this._createElement('span', reqClass,
            required.includes(propName) ? 'required' : 'optional'));
          param.appendChild(paramHeader);
          if (prop.description) {
            const desc = this._createElement('div', 'tool-param-description');
            desc.textContent = prop.description;
            param.appendChild(desc);
          }
          params.appendChild(param);
        }
        toolEl.appendChild(params);
      }

      list.appendChild(toolEl);
    }
    section.appendChild(list);
    return section;
  }

  /**
   * Create a DOM element with optional class and text content.
   * @param {string} tag - HTML tag name
   * @param {string} [className] - CSS class name(s)
   * @param {string} [textContent] - Text content
   * @returns {HTMLElement} Created element
   * @private
   */
  _createElement(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent !== undefined) el.textContent = textContent;
    return el;
  }

  /**
   * Create an element holding author-facing prose (a capability description or a
   * strategy's "Approach" copy). When the text reads as markdown — or simply
   * spans multiple paragraphs — it is rendered through the shared markdown
   * formatter so paragraphs, lists, `code`, and links display properly; plain
   * one-liners fall back to `textContent` unchanged, so ordinary descriptions
   * are never reflowed. `renderMarkdown` sanitises its own output (tags,
   * attributes, and URL schemes), so assigning it to innerHTML is safe.
   *
   * Use a block-level tag: markdown emits block elements (`<p>`, `<ul>`), which
   * are invalid nested inside a `<p>`.
   * @param {string} tag - Wrapper tag (must be block-level)
   * @param {string} className - CSS class(es)
   * @param {string} text - Prose to render (plain or markdown)
   * @returns {HTMLElement} The created element
   * @private
   */
  _createProse(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    const str = text ?? '';
    // Treat a blank-line paragraph break as markdown too: textContent would
    // collapse it to a space, so multi-paragraph prose needs the renderer.
    if (looksLikeMarkdown(str) || /\n\s*\n/.test(str)) {
      el.classList.add('markdown');
      el.innerHTML = renderMarkdown(str, { escapeXml: true });
    } else {
      el.textContent = str;
    }
    return el;
  }
}

customElements.define('plugin-catalog', PluginCatalog);

export default PluginCatalog;
