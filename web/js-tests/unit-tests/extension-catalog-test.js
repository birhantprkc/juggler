//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Extensions catalog UI tests (Phase 5).
 *
 * Cover the four moving parts of the master/detail catalog without mutating
 * shared server config (the iframe pool shares one project config.json, so a
 * real toggle write would pollute sibling lanes' registry re-inits):
 *
 *   1. base-registry disables a capability when its *extension id* — not just
 *      its own cap id — appears in the disabled set (drives _applyDisabledFilter
 *      directly with a stubbed config fetch on a throwaway registry).
 *   2. computeNextDisabled adds/removes ids with Set (idempotent) semantics.
 *   3. buildExtensionCards merges catalog metadata with registry
 *      registered/disabled/failed state, including extension-level inheritance.
 *   4. The live component renders the sidebar as an extension tree (extensions
 *      as top-level nodes, capabilities nested under per-type sub-headings,
 *      expand/collapse) with a detail pane for the selected item (read-only:
 *      real catalog + config GET, no POST).
 *   5. The deep-link into the catalog: a properties-panel header badge resolves
 *      the capability that owns its item and revealCapability selects it.
 * @module unit-tests/extension-catalog-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { badgeForItem } from '../../js/utils/item-badge.js';
import '../../js/components/properties-panel.js';
import '../../js/components/settings-panel.js';
import BaseRegistry from '../../js/registries/base-registry.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import {
  buildExtensionCards,
  collectOrphanedDisabled,
  computeNextDisabled,
} from '../../js/components/plugin-catalog.js';
import Conversation from '../../js/model/conversation.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import commandRegistry from '../../js/registries/command-registry.js';
import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** Concrete BaseRegistry for testing (BaseRegistry is abstract). */
class TestRegistry extends BaseRegistry {
  constructor() {
    super('CatalogTestReg', ['id', 'name', 'version', 'description']);
  }

  /** @returns {Promise<object[]>} Resolves to the list of module paths (empty in tests). */
  async getModulePaths() {
    return [];
  }
}

/**
 * A minimal capability class. Really a class, not an object with a MANIFEST:
 * `validateClass` rejects anything that isn't callable, so a plain object would
 * make every registerClass assertion pass for the wrong reason.
 * @param {string} id - Capability id
 * @returns {any} A class carrying a valid static MANIFEST
 */
function fakeClass(id) {
  return class {
    static MANIFEST = { id, name: id, version: '1.0.0', description: `${id} desc` };
  };
}

/**
 * Run `fn` with `/api/config/plugins` answering `disabled`, against a cleared
 * cache. The resolved set is read ONCE per load and shared by every registry and
 * the catalog (`services/extensions.js` `fetchDisabledPluginIds`), so a test that
 * changes the answer has to invalidate first — which is exactly what a real
 * toggle does, through `reloadRegistries()` → `resetExtensionsCache()`.
 * @param {string[]} disabled - The resolved disabled-id list the server reports
 * @param {() => Promise<void>} fn - The body to run against it
 * @returns {Promise<void>}
 */
async function withPluginConfig(disabled, fn) {
  const { resetExtensionsCache } = await import('../../js/services/extensions.js');
  const orig = window.fetch;
  resetExtensionsCache();
  window.fetch = async () => /** @type {any} */ ({ ok: true, json: async () => ({ disabled }) });
  try {
    await fn();
  } finally {
    window.fetch = orig;
    resetExtensionsCache();
  }
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves to the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 1 — disable a capability via its extension id.
  await run('base-registry disables a capability by its extension id', async () => {
    const reg = new TestRegistry();
    reg.items.set('lint', fakeClass('lint'));
    reg.modulePaths.set('lint', '/user-extensions/pack/context-items/lint-context-item.js');
    reg.itemExtensions.set('lint', '@jules/pack');

    await withPluginConfig(['@jules/pack'], () => reg._applyDisabledFilter());

    assert(!reg.has('lint'), 'capability should be disabled via its extension id');
    assert(reg.getDisabledItems().some((d) => d.id === 'lint'),
      'capability should appear in the disabled list');
    // And getCatalogManifests should report it as disabled, attributed.
    const entry = reg.getCatalogManifests().find((m) => m.id === 'lint');
    assert(entry && entry.disabled === true && entry.extensionId === '@jules/pack',
      'getCatalogManifests should report the disabled, attributed capability');
  });

  // 1b — a disabled capability keeps its class, reachable via
  // getIncludingDisabled, so the catalog can still show its full properties.
  await run('base-registry exposes a disabled capability class via getIncludingDisabled', async () => {
    const reg = new TestRegistry();
    reg.items.set('lint', fakeClass('lint'));
    reg.modulePaths.set('lint', '/x/lint.js');
    reg.itemExtensions.set('lint', '@jules/pack');

    await withPluginConfig(['lint'], () => reg._applyDisabledFilter());

    // get() hides the disabled item; getIncludingDisabled() still returns it.
    assert(reg.get('lint') === undefined, 'get() excludes the disabled capability');
    const cls = reg.getIncludingDisabled('lint');
    assert(cls && cls.MANIFEST && cls.MANIFEST.id === 'lint',
      'getIncludingDisabled() returns the disabled capability class with its MANIFEST');
    assert(reg.getIncludingDisabled('nope') === undefined,
      'getIncludingDisabled() returns undefined for an unknown id');
  });

  await run('base-registry leaves capabilities of other extensions enabled', async () => {
    const reg = new TestRegistry();
    reg.items.set('lint', fakeClass('lint'));
    reg.modulePaths.set('lint', '/x/lint.js');
    reg.itemExtensions.set('lint', '@jules/pack');
    reg.items.set('fmt', fakeClass('fmt'));
    reg.modulePaths.set('fmt', '/y/fmt.js');
    reg.itemExtensions.set('fmt', '@other/pack');

    await withPluginConfig(['@jules/pack'], () => reg._applyDisabledFilter());

    assert(!reg.has('lint'), 'lint (in disabled extension) should be off');
    assert(reg.has('fmt'), 'fmt (in a different extension) should stay on');
  });

  // 2 — computeNextDisabled.
  await run('computeNextDisabled adds and removes with Set semantics', () => {
    assert(JSON.stringify(computeNextDisabled([], 'x', false)) === '["x"]',
      'disabling adds the id');
    assert(JSON.stringify(computeNextDisabled(['x'], 'x', false)) === '["x"]',
      'disabling an already-disabled id is idempotent');
    assert(JSON.stringify(computeNextDisabled(['x'], 'x', true)) === '[]',
      'enabling removes the id');
    assert(JSON.stringify(computeNextDisabled(['x'], 'y', true)) === '["x"]',
      'enabling an absent id is a no-op');
  });

  // 3 — buildExtensionCards merge.
  await run('buildExtensionCards merges registered/disabled/failed state', () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0', author: 'jules' },
      source: 'user',
      capabilities: {
        contextItems: [
          '/user-extensions/pack/ci/a-context-item.js',
          '/user-extensions/pack/ci/b-context-item.js',
        ],
        strategies: [],
        commands: [],
      },
      error: '',
    }];
    const byPath = new Map([
      ['/user-extensions/pack/ci/a-context-item.js',
        { id: 'a', manifest: { name: 'Cap A', description: 'does A' }, itemType: 'context-item', disabled: true }],
    ]);
    const failed = new Map([['/user-extensions/pack/ci/b-context-item.js', 'SyntaxError: boom']]);

    const cards = buildExtensionCards(extensions, byPath, failed, new Set(['a']));
    assert(cards.length === 1, 'one extension card expected');
    const card = cards[0];
    assert(card.extId === '@jules/pack' && card.source === 'user', 'card metadata threaded');
    assert(card.extDisabled === false, 'extension itself is not disabled');
    assert(card.caps.length === 2, 'both capabilities present');

    const a = card.caps.find((c) => c.url.endsWith('a-context-item.js'));
    assert(a && a.registered && a.id === 'a' && a.disabled && !a.inherited,
      'cap A is registered, explicitly disabled, not inherited');
    assert(a.name === 'Cap A' && a.description === 'does A', 'cap A metadata from registry');

    const b = card.caps.find((c) => c.url.endsWith('b-context-item.js'));
    assert(b && !b.registered && b.failed === 'SyntaxError: boom' && b.id === null,
      'cap B is unregistered with its load error surfaced');
  });

  await run('buildExtensionCards inherits disabled state from the extension', () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: ['/u/pack/a-context-item.js'], strategies: [], commands: [] },
      error: '',
    }];
    const byPath = new Map([
      ['/u/pack/a-context-item.js', { id: 'a', manifest: { name: 'A' }, itemType: 'context-item', disabled: true }],
    ]);
    // Disable the WHOLE extension, not the cap id.
    const cards = buildExtensionCards(extensions, byPath, new Map(), new Set(['@jules/pack']));
    const card = cards[0];
    assert(card.extDisabled === true, 'extension is disabled');
    const a = card.caps[0];
    assert(a.disabled && a.inherited, 'cap inherits disabled state from its extension');
  });

  // 3a2 — buildExtensionCards threads the on-disk file paths (manifest + per
  // capability) from the catalog, and leaves them null when absent (embedded).
  await run('buildExtensionCards threads on-disk file paths from the catalog', () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: ['/user-extensions/pack/ci/a-context-item.js'], strategies: [], commands: [] },
      error: '',
      manifestPath: '/abs/pack/juggler.extension.json',
      files: { '/user-extensions/pack/ci/a-context-item.js': '/abs/pack/ci/a-context-item.js' },
    }, {
      // An embedded builtin: no manifestPath / files → paths stay null.
      manifest: { id: '@juggler/core', name: 'Core', version: '1.0.0' },
      source: 'builtin',
      capabilities: { contextItems: ['/extensions/core/b-context-item.js'], strategies: [], commands: [] },
      error: '',
    }];
    const byPath = new Map([
      ['/user-extensions/pack/ci/a-context-item.js', { id: 'a', manifest: { name: 'A' }, itemType: 'context-item', disabled: false }],
      ['/extensions/core/b-context-item.js', { id: 'b', manifest: { name: 'B' }, itemType: 'context-item', disabled: false }],
    ]);

    const cards = buildExtensionCards(extensions, byPath, new Map(), new Set());
    const pack = cards.find((c) => c.extId === '@jules/pack');
    assert(pack.manifestPath === '/abs/pack/juggler.extension.json', 'extension manifest path threaded');
    assert(pack.caps[0].path === '/abs/pack/ci/a-context-item.js', 'capability disk path threaded from files map');

    const core = cards.find((c) => c.extId === '@juggler/core');
    assert(core.manifestPath === null, 'embedded extension has null manifest path');
    assert(core.caps[0].path === null, 'embedded capability has null disk path');
  });

  // 3a3 — the detail pane shows the file via our standard file-path control,
  // for both an extension (its manifest) and a capability (its module). Inject
  // synthetic cards so this is deterministic and offline (no API dependency).
  await run('detail pane shows the source file path with reveal control', async () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: ['/user-extensions/pack/ci/a-context-item.js'], strategies: [], commands: [] },
      error: '',
      manifestPath: '/abs/pack/juggler.extension.json',
      files: { '/user-extensions/pack/ci/a-context-item.js': '/abs/pack/ci/a-context-item.js' },
    }];
    const byPath = new Map([
      ['/user-extensions/pack/ci/a-context-item.js', { id: 'a', manifest: { name: 'Cap A' }, itemType: 'context-item', disabled: false }],
    ]);

    const el = /** @type {PluginCatalog} */ (document.createElement('plugin-catalog'));
    el._cards = buildExtensionCards(extensions, byPath, new Map(), new Set());
    el._selectedKey = 'ext:@jules/pack';
    el.render();

    // Extension detail shows the manifest file with copy + reveal controls.
    const extFile = el.querySelector('.properties-panel-filepath');
    assert(extFile && extFile.textContent === '/abs/pack/juggler.extension.json',
      'extension detail shows the manifest file path');
    assert(el.querySelector('.properties-panel-filepath-row reveal-button'),
      'the file path carries our reveal-in-Finder control');
    assert(extFile.dataset.filePath === '/abs/pack/juggler.extension.json',
      'the path is exposed for the right-click Open/Reveal/Copy menu');

    // Selecting the capability shows its module file.
    el._select('cap:context-item:a');
    const capFile = el.querySelector('.properties-panel-filepath');
    assert(capFile && capFile.textContent === '/abs/pack/ci/a-context-item.js',
      'capability detail shows the module file path');
  });

  // 3a4 — a strategy's detail pane publishes the guidance it injects. This is
  // the answer to "does switching mode change what the model is told?", so it is
  // shown verbatim, and a strategy that injects nothing must say so out loud
  // rather than leaving an absent section to be read as either answer.
  await run('strategy detail shows the guidance it injects, verbatim', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
    const el = /** @type {PluginCatalog} */ (document.createElement('plugin-catalog'));

    const readOnly = /** @type {any} */ (strategyRegistry.get('read-only'));
    const section = el._renderStrategyGuidance(readOnly);
    const shown = section.querySelector('.strategy-guidance-text');
    assert(shown && shown.textContent === readOnly.GUIDANCE.trim(),
      `read-only's declared guidance is shown byte for byte; got ${JSON.stringify(shown?.textContent)}`);

    const none = el._renderStrategyGuidance(/** @type {any} */ (strategyRegistry.get('default')));
    assert(!none.querySelector('.strategy-guidance-text'), 'default has no guidance text to show');
    assert(/^Nothing\./.test(none.querySelector('.strategy-guidance-none')?.textContent || ''),
      'a strategy that says nothing to the model states that, rather than rendering an empty section');
  });

  // 4 — live component render: the sidebar is an extension tree (extensions as
  // top-level nodes, capabilities nested under per-type sub-headings) and the
  // detail pane shows the selection. Read-only against real registries + catalog.
  await run('component renders an extension tree with nested type sub-headings + a detail pane', async () => {
    if (!contextItemRegistry.isInitialized()) await contextItemRegistry.init();
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
    if (!commandRegistry.isInitialized()) await commandRegistry.init();

    // Create without mounting, so connectedCallback doesn't double-load; drive
    // the load/render directly. _fetchConfig issues a read-only GET only.
    const el = /** @type {PluginCatalog} */ (document.createElement('plugin-catalog'));
    await el._loadData();
    el.render();

    const sidebar = el.querySelector('.catalog-sidebar');
    const detail = el.querySelector('.catalog-detail-panel');
    assert(sidebar && detail, 'sidebar and detail pane rendered');

    // Top-level nodes are extensions; one per card.
    const extRows = el.querySelectorAll('.plugin-tree-ext');
    assert(extRows.length === el._cards.length && extRows.length > 0,
      'one top-level extension node per card');
    const extLabels = [...extRows].map((n) => n.textContent || '');
    assert(extLabels.some((n) => /core/i.test(n)), `expected a core extension node, got: ${extLabels.join(', ')}`);

    // Extensions are expanded by default, so capability leaves and the per-type
    // sub-headings (Strategies / Context Items / Commands) are visible underneath.
    const subHeadings = [...el.querySelectorAll('.plugin-tree-section')].map((h) => h.textContent || '');
    assert(subHeadings.some((h) => ['Strategies', 'Context Items', 'Commands'].includes(h)),
      `expected type sub-headings under the extension, got: ${subHeadings.join(', ')}`);
    assert(el.querySelectorAll('.plugin-tree-leaf').length > 0, 'capability leaves rendered under the tree');

    // Every selectable row (ext + caps) corresponds to a model entry, and each
    // carries its on/off toggle badge — the toggle lives on the row, not in the
    // detail pane.
    const rows = el.querySelectorAll('.plugin-tree-row');
    assert(rows.length === el._buildEntries().length, 'one tree row per model entry');
    assert(el.querySelectorAll('.plugin-tree-toggle').length === rows.length,
      'every tree row carries an on/off toggle badge');

    // First entry (an extension) is selected by default; its detail reports
    // state but must NOT carry a toggle (toggling is done from the tree badge).
    assert(el.querySelector('.plugin-tree-row.selected'), 'a row is selected by default');
    assert(detail.querySelector('.plugin-detail-name'), 'the detail pane shows the selected item');
    assert(!detail.querySelector('.ext-switch'), 'the detail pane has no toggle control');
  });

  // 4b — collapsing an extension hides its capability leaves; a caret click is
  // the toggle, and it leaves the selection untouched.
  await run('collapsing an extension node hides its capability leaves', async () => {
    if (!contextItemRegistry.isInitialized()) await contextItemRegistry.init();
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
    if (!commandRegistry.isInitialized()) await commandRegistry.init();

    const el = /** @type {PluginCatalog} */ (document.createElement('plugin-catalog'));
    document.body.appendChild(el);
    try {
      await el._loadData();
      el.render();

      const extRow = el.querySelector('.plugin-tree-ext');
      assert(extRow, 'an extension node rendered');
      const extKey = /** @type {HTMLElement} */ (extRow).dataset.key || '';
      assert(el.querySelectorAll('.plugin-tree-leaf').length > 0, 'leaves visible while expanded');

      // Collapse via the public toggle (same code path as a caret click).
      el._toggleExpanded(extKey);
      assert(el.querySelectorAll(`.plugin-tree-leaf`).length === 0
        || el.querySelector(`.plugin-tree-node`)?.querySelectorAll('.plugin-tree-children').length === 0,
      'collapsing the only/first extension hides its leaves');

      // Re-expand restores them.
      el._toggleExpanded(extKey);
      assert(el.querySelectorAll('.plugin-tree-leaf').length > 0, 're-expanding restores the leaves');
    } finally {
      el.remove();
    }
  });

  // 5 — a refresh updates in place: the sidebar and header keep their DOM
  // identity (so the user's scroll position survives), only the rows swap. This
  // is the non-destructive path a toggle uses instead of a full innerHTML reset.
  await run('refreshing preserves the sidebar and header (no teardown)', async () => {
    if (!contextItemRegistry.isInitialized()) await contextItemRegistry.init();
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
    if (!commandRegistry.isInitialized()) await commandRegistry.init();

    const el = /** @type {PluginCatalog} */ (document.createElement('plugin-catalog'));
    document.body.appendChild(el);
    try {
      await el._loadData();
      el.render();

      const sidebarBefore = el.querySelector('.catalog-sidebar');
      const headerBefore = el.querySelector('.catalog-header');
      const firstRowBefore = el.querySelector('.plugin-tree-row');
      assert(sidebarBefore && headerBefore && firstRowBefore, 'sidebar, header, and a tree row rendered');

      el._refreshCards();

      const sidebarAfter = el.querySelector('.catalog-sidebar');
      const headerAfter = el.querySelector('.catalog-header');
      const firstRowAfter = el.querySelector('.plugin-tree-row');
      assert(sidebarAfter === sidebarBefore, 'the sidebar element is reused, not rebuilt');
      assert(headerAfter === headerBefore, 'the header is untouched by a refresh');
      assert(firstRowAfter !== firstRowBefore, 'tree rows are rebuilt inside the same sidebar');
      assert(el.querySelectorAll('.plugin-tree-row').length === el._buildEntries().length,
        'refreshed row count still matches the model');
    } finally {
      el.remove();
    }
  });

  // 6 — the deep-link from a properties-panel badge: the badge resolver names
  // the owning capability, the panel header turns that into a click target, and
  // the catalog selects it. Synthetic cards keep this offline and deterministic.
  await run('badgeForItem names the capability that owns an item', () => {
    const instance = {
      getTitle: () => 'README.md',
      type: 'read-file',
      getManifest: () => ({ id: 'read-file', name: 'Read File' }),
      getBadgeOptions: () => ({ color: 'blue', icon: 'icon-read' }),
    };
    assert(badgeForItem(instance).pluginId === 'read-file',
      'a context-item instance reports its registry id');

    const assistant = { get: (/** @type {string} */ k) => (k === 'type' ? 'assistant' : undefined) };
    assert(badgeForItem(assistant).pluginId === null,
      'a plain assistant message has no owning capability');
  });

  await run('delegated thread badges use the invoking tool name', () => {
    const thread = (/** @type {string} */ runToolName) => ({
      get: (/** @type {string} */ key) => ({ type: 'thread', runToolName })[key]
    });

    const explore = badgeForItem(thread('Explore'));
    assert(explore.typeName === 'Explore' && explore.pluginId === 'explore-agent',
      'an Explore thread is badged as Explore and attributed to that capability');

    const research = badgeForItem(thread('Research'));
    assert(research.typeName === 'Research' && research.pluginId === 'research-agent',
      'a Research thread is badged as Research and attributed to that capability');

    const regular = badgeForItem(thread('create_thread'));
    assert(regular.typeName === 'Thread' && regular.pluginId === 'thread',
      'create_thread keeps the Thread badge');
  });

  await run('a compaction fold says so on its tile', () => {
    // The fold is spliced where the folded history began, wearing the same
    // generic Thread lozenge as work the user asked for — so the one row that
    // reports the conversation being rewritten read as an ordinary sub-thread.
    const fold = {
      get: (/** @type {string} */ key) => ({ type: 'thread', boundedCompaction: true })[key]
    };
    assert(badgeForItem(fold).typeName === 'Compacted',
      `a folded history tile must name itself, got ${badgeForItem(fold).typeName}`);
  });

  await run('the panel header badge links to the owning capability', () => {
    const panel = /** @type {any} */ (document.createElement('properties-panel'));
    const header = panel._createHeader('Read', { color: 'blue', iconClass: 'icon-read', pluginId: 'read-file' });
    const badge = header.querySelector('.message-icon-badge');
    assert(badge && badge.classList.contains('badge-catalog-link'),
      'the icon + lozenge group is marked as a link');
    assert(badge.getAttribute('role') === 'button' && badge.tabIndex === 0,
      'the link is reachable as a button');

    /** @type {any[]} */
    const calls = [];
    // The badge opens settings through services/settings-launcher.js, so the
    // registered opener — not the window alias — is the seam to stand in for.
    const restoreOpener = registerSettingsOpener((/** @type {any[]} */ ...args) => calls.push(args));
    try {
      badge.click();
    } finally {
      restoreOpener();
    }
    assert(calls.length === 1 && calls[0][0] === 'extensions',
      'clicking opens the Extensions settings tab');
    assert(calls[0][1]?.capability?.id === 'read-file' && calls[0][1]?.capability?.itemType === 'context-item',
      'the capability to select is carried along');

    // An item no plugin owns keeps an inert badge.
    const plain = panel._createHeader('User Message', { color: 'green' });
    assert(!plain.querySelector('.badge-catalog-link'),
      'a badge with no owning capability is not a link');
  });

  await run('the settings panel routes a capability target to the catalog', async () => {
    /** @type {any[]} */
    const seen = [];
    const panel = /** @type {any} */ (document.createElement('settings-panel'));
    // Unmounted, so it has no DOM of its own — stand in for the catalog it
    // would otherwise find in its Extensions tab.
    panel.querySelector = () => ({
      revealCapability: (/** @type {string} */ itemType, /** @type {string} */ id) => {
        seen.push([itemType, id]);
        return Promise.resolve(true);
      },
    });
    panel._revealCapability({ itemType: 'context-item', id: 'read-file' });
    assert(seen.length === 1 && seen[0][0] === 'context-item' && seen[0][1] === 'read-file',
      'the capability target reaches the catalog unchanged');
  });

  await run('revealCapability selects a capability from outside the catalog', async () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: ['/u/pack/a-context-item.js'], strategies: [], commands: [] },
      error: '',
    }];
    const byPath = new Map([
      ['/u/pack/a-context-item.js', { id: 'a', manifest: { name: 'Cap A' }, itemType: 'context-item', disabled: false }],
    ]);

    const el = /** @type {PluginCatalog} */ (document.createElement('plugin-catalog'));
    el._cards = buildExtensionCards(extensions, byPath, new Map(), new Set());
    el.render();
    assert(el._selectedKey === 'ext:@jules/pack', 'the extension is selected by default');

    const revealed = await el.revealCapability('context-item', 'a');
    assert(revealed === true, 'revealCapability reports the capability was found');
    assert(el._selectedKey === 'cap:context-item:a', 'the capability is now selected');
    const selected = /** @type {HTMLElement} */ (el.querySelector('.plugin-tree-row.selected'));
    assert(selected && selected.dataset.key === 'cap:context-item:a',
      'its tree row carries the selection');

    const missing = await el.revealCapability('context-item', 'nope');
    assert(missing === false && el._selectedKey === 'cap:context-item:a',
      'an unknown capability is reported and leaves the selection alone');
  });

  // 6 — a toggle must still apply while a conversation sits parked on a tool
  // approval. The worker keeps publishing `processing_tools` for the whole time
  // the user deliberates, and the server's own activity signal
  // (/api/health/active, which _quiesceBeforeToggle consults) deliberately
  // excludes that case — so the toggle sails past the quiesce gate, writes the
  // config, and then blocks forever in the registry rebuild's own busy-wait.
  // That leaves `_busy` latched true, which makes EVERY later toggle on EVERY
  // row a silent no-op: the whole enable/disable UI is dead until the approval
  // is answered.
  await run('a toggle applies while a conversation is parked on a tool approval', async () => {
    const before = await (await fetch('/api/config/plugins')).json();
    const prevApp = /** @type {any} */ (globalThis).jugglerApp;
    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    try {
      // A conversation parked on an approval: the worker's published status
      // stays `processing_tools` indefinitely with no turn actually running.
      // hasPendingApprovalInTree walks Y.Map-shaped items, and a lone
      // tool-action whose state is `pending` is the smallest tree it reports
      // true for. The real Conversation.isAwaitingApproval is borrowed rather
      // than stubbed, so this exercises the production predicate.
      const conv = {
        processingState: { status: 'processing_tools' },
        rootMessageThread: {
          items: [{ get: (/** @type {string} */ k) => ({ type: 'tool-action', state: 'pending' }[k]) }],
        },
        isAwaitingApproval: Conversation.prototype.isAwaitingApproval,
      };
      assert(conv.isAwaitingApproval(), 'the stub conversation reads as approval-parked');
      /** @type {any} */ (globalThis).jugglerApp = {
        getSession: () => ({ conversations: new Map([['c1', conv]]) }),
      };

      document.body.appendChild(el);
      await waitFor(() => el._cards?.length > 0, { description: 'catalog to load' });

      const badge = el.querySelector('[data-testid="toggle-cap:context-item:glob"]');
      assert(badge && !badge.disabled, 'the glob capability starts enabled and toggleable');
      badge.click();

      // Generous on purpose. The bound is here to catch a latch, not to police
      // wall-clock: the regression it guards is a block on the rebuild's
      // quiescence busy-wait, which unblocks only at QUIESCENCE_TIMEOUT_MS
      // (30s), so anything under that separates "latched" from "slow" cleanly.
      // The honest cost of the passing path is a full six-registry rebuild —
      // ~40 module imports — which on a machine running four -race suites at
      // once had been overrunning a 4s budget and failing the whole gate for
      // load rather than for fault.
      await waitFor(() => el._busy === false,
        { timeoutMs: 20000, description: 'the toggle to finish rather than latch _busy' });

      const after = await (await fetch('/api/config/plugins')).json();
      assert(after.disabled.includes('glob'), 'the capability is recorded disabled');
      const now = el.querySelector('[data-testid="toggle-cap:context-item:glob"]');
      assert(now && now.textContent === 'off', `the badge reflects it; got ${now?.textContent}`);
    } finally {
      /** @type {any} */ (globalThis).jugglerApp = prevApp;
      el.remove();
      await fetch('/api/config/plugins', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(before),
      });
      const { whenRegistriesSettled, reloadRegistries } =
        await import('../../js/registries/reload-registries.js');
      await whenRegistriesSettled();
      await reloadRegistries();
    }
  });

  // 7 — a declared capability that never registered still gets a row.
  //
  // A capability row is built from the served URL the extension catalog lists,
  // cross-referenced with the registry entry for that URL. With no entry there
  // is no capability id, so the badge can neither read nor write the config —
  // it says `unknown` and does not pretend otherwise. What it must not do is
  // vanish: an extension declaring a capability that isn't loading is a fault,
  // and a row naming the file is how the user sees it.
  await run('a capability the registry never registered still gets a row', async () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: {
        contextItems: ['/u/pack/ghost-context-item.js', '/u/pack/broken-context-item.js'],
        strategies: [],
        commands: [],
      },
      error: '',
    }];
    // `ghost` produced no registry entry and is not a failed import either — the
    // state the reported catalogs were in. `broken` failed to import.
    const failed = new Map([['/u/pack/broken-context-item.js', 'SyntaxError: unexpected token']]);
    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    el._cards = buildExtensionCards(extensions, new Map(), failed, new Set(['ghost']));
    el._failedModules = [...failed.entries()].map(([path, error]) => ({ path, error }));
    el._orphanedDisabled = [];
    el.render();

    const labels = [...el.querySelectorAll('.plugin-tree-leaf .plugin-tree-label')]
      .map((/** @type {any} */ n) => n.textContent);
    assert(labels.some((/** @type {string} */ l) => /ghost/.test(l)),
      `an unregistered capability is still listed; got ${JSON.stringify(labels)}`);
    const ghost = el.querySelector('[data-testid="toggle-cap:context-item:/u/pack/ghost-context-item.js"]');
    assert(ghost && ghost.textContent === 'unknown',
      `its badge says so rather than claiming a state; got ${ghost?.textContent}`);
    assert(ghost && ghost.disabled, 'and cannot be clicked, having no id to write');

    // A module that FAILED still earns its row: the filename is the diagnostic.
    assert(labels.some((/** @type {string} */ l) => /broken/.test(l)),
      `a failed import stays visible; got ${JSON.stringify(labels)}`);
    assert(el.querySelector('.plugin-tree-toggle-failed'), 'and reads as failed');
  });

  await run('ids switched off but no longer provided get a row of their own', async () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: ['/u/pack/a-context-item.js'], strategies: [], commands: [] },
      error: '',
    }];
    const byPath = new Map([
      ['/u/pack/a-context-item.js', { id: 'a', manifest: { name: 'Cap A' }, itemType: 'context-item', disabled: false }],
    ]);
    const disabled = new Set(['a', '@jules/pack', 'exa-search']);
    const cards = buildExtensionCards(extensions, byPath, new Map(), disabled);

    // Only `exa-search` matches nothing live: `a` is a loaded capability and
    // `@jules/pack` is an installed extension, and both have working rows.
    const orphans = collectOrphanedDisabled(cards, disabled);
    assert(orphans.length === 1 && orphans[0] === 'exa-search',
      `only the unmatched id is orphaned; got ${JSON.stringify(orphans)}`);

    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    el._cards = cards;
    el._disabledIds = disabled;
    el._orphanedDisabled = orphans;
    /** @type {any[]} */
    const toggled = [];
    el._toggle = (/** @type {string[]} */ ids, /** @type {boolean} */ on) => { toggled.push([ids, on]); };
    el.render();

    const labels = [...el.querySelectorAll('.plugin-tree-label')]
      .map((/** @type {any} */ n) => n.textContent);
    assert(labels.includes('Not installed'),
      `the group exists to hold it; got ${JSON.stringify(labels)}`);
    assert(labels.includes('exa-search'), 'and the id is named in it');

    const badge = el.querySelector('[data-testid="toggle-cap:orphan:exa-search"]');
    assert(badge && badge.textContent === 'off',
      `the orphaned id gets an ordinary row reading off; got ${badge?.textContent}`);

    // With nothing remembered the id is all there is to show. Given
    // attribution, the row says what it was instead of a bare id.
    el._attribution = { 'exa-search': { name: 'Exa Search', extension: '@juggler/exa' } };
    el.render();
    const named = [...el.querySelectorAll('.plugin-tree-label')]
      .map((/** @type {any} */ n) => n.textContent);
    assert(named.includes('Exa Search'),
      `a remembered name is used in place of the bare id; got ${JSON.stringify(named)}`);

    assert(badge && !badge.disabled, 'and its badge is clickable');
    badge.click();
    assert(toggled.length === 1 && toggled[0][0][0] === 'exa-search' && toggled[0][1] === true,
      `clicking it switches that id back on; got ${JSON.stringify(toggled)}`);
  });

  // Switching a capability off is the very thing that can orphan its id, and a
  // toggle refreshes through _refreshCards rather than a full render. If that
  // path doesn't rebuild the tree's orphan group, the only control bound to the
  // id stays invisible at exactly the moment it becomes the only way back.
  await run('the orphan row appears on the post-toggle refresh, not just a full render', async () => {
    const extensions = [{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: ['/u/pack/a-context-item.js'], strategies: [], commands: [] },
      error: '',
    }];
    const byPath = new Map([
      ['/u/pack/a-context-item.js', { id: 'a', manifest: { name: 'Cap A' }, itemType: 'context-item', disabled: false }],
    ]);

    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    document.body.appendChild(el);
    try {
      el._cards = buildExtensionCards(extensions, byPath, new Map(), new Set());
      el._disabledIds = new Set();
      el._orphanedDisabled = [];
      el.render();
      assert(!el.querySelector('[data-testid="toggle-cap:orphan:a"]'),
        'nothing orphaned, so no orphan row');

      // The capability is switched off and its registry entry then vanishes —
      // the reported state. Only _refreshCards runs, as after a real toggle.
      el._cards = buildExtensionCards(extensions, new Map(), new Map(), new Set(['a']));
      el._disabledIds = new Set(['a']);
      el._orphanedDisabled = collectOrphanedDisabled(el._cards, el._disabledIds);
      el._refreshCards();

      const badge = el.querySelector('[data-testid="toggle-cap:orphan:a"]');
      assert(badge, 'the orphan row is rendered by the toggle refresh path');
      assert(badge && badge.textContent === 'off' && !badge.disabled,
        `and carries a live toggle that switches the id back on; got ${badge?.textContent}`);
    } finally {
      el.remove();
    }
  });

  // A module that failed to import is identified by its served URL alone, so a
  // registry left out of the failure sweep loses that identification: the row
  // gets no id and no error, and is indistinguishable from a capability the
  // extension never shipped. File viewers were the registry left out.
  await run('a failed load is collected from every registry, file viewers included', async () => {
    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    const url = '/u/pack/probe-file-viewer.js';
    fileViewerRegistry._failedModules.set(url, 'SyntaxError: unexpected token');
    try {
      const failed = el._collectFailed();
      assert(failed.get(url) === 'SyntaxError: unexpected token',
        `the file-viewer failure is collected; got ${JSON.stringify([...failed.keys()])}`);
    } finally {
      fileViewerRegistry._failedModules.delete(url);
    }
  });

  // A capability's id lives inside its module, so a module that stops loading
  // takes the id with it: the row for that served URL has no id to look up, no
  // name, and a badge that can neither read nor write the config. That is the
  // `unknown` filename row. The attribution recorded when the capability was
  // switched off puts the id back, so the row names itself and its badge works.
  await run('a switched-off capability that stopped loading keeps its name and toggle', async () => {
    const url = '/user-extensions/e7/exa/context-items/exa-search-context-item.js';
    const extensions = [{
      manifest: { id: '@juggler/exa', name: 'Exa Search', version: '0.1.0' },
      source: 'user',
      capabilities: { contextItems: [url], strategies: [], commands: [] },
      error: '',
    }];
    // The registry has nothing: the module is not loading, and it did not fail
    // to import either — it is simply not there any more.
    const attribution = {
      'exa-search': {
        extension: '@juggler/exa',
        file: 'exa-search-context-item.js',
        type: 'context-item',
        name: 'Exa Search',
      },
    };
    const disabled = new Set(['exa-search']);
    const cards = buildExtensionCards(extensions, new Map(), new Map(), disabled, attribution);

    const cap = cards[0].caps[0];
    assert(cap.id === 'exa-search', `the row recovers its id; got ${cap.id}`);
    assert(cap.name === 'Exa Search', `and its name rather than a filename; got ${cap.name}`);
    assert(cap.disabled === true, 'and reads as switched off');

    assert(collectOrphanedDisabled(cards, disabled).length === 0,
      'so it is not also listed as not-installed — it has a row of its own');

    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    el._cards = cards;
    el._disabledIds = disabled;
    el._orphanedDisabled = [];
    el.render();

    const badge = el.querySelector('[data-testid="toggle-cap:context-item:exa-search"]');
    assert(badge && badge.textContent === 'off',
      `the badge states the real state; got ${badge?.textContent ?? 'no row'}`);
    assert(badge && !badge.disabled, 'and can be clicked to switch it back on');
  });

  // The recovery above only works if something records the description, and the
  // toggle is the last moment anything can: after it, the capability may stop
  // loading and its id becomes a bare string in a list. Switching ON sends
  // nothing, because the server prunes the entry along with the id.
  await run('switching a capability off records what it was', async () => {
    const url = '/extensions/exa/context-items/exa-search-context-item.js';
    const byPath = new Map([[url, {
      id: 'exa-search',
      manifest: { name: 'Exa Search', description: 'Search the web', version: '0.1.0' },
      itemType: 'context-item',
      disabled: false,
    }]]);
    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    el._cards = buildExtensionCards([{
      manifest: { id: '@juggler/exa', name: 'Exa Search', version: '0.1.0' },
      source: 'builtin',
      capabilities: { contextItems: [url], strategies: [], commands: [] },
      error: '',
    }], byPath, new Map(), new Set());
    el._disabledIds = new Set();
    el._orphanedDisabled = [];

    /** @type {any[]} */
    const writes = [];
    el._persist = async (/** @type {string[]} */ list, /** @type {any} */ attribution) => {
      writes.push({ list, attribution });
    };
    el._quiesceBeforeToggle = async () => true;
    el._reinitRegistries = async () => {};
    el._loadData = async () => {};
    el._refreshCards = () => {};

    await el._toggle(['exa-search'], false);
    assert(writes.length === 1, `one write; got ${writes.length}`);
    const recorded = writes[0].attribution['exa-search'];
    assert(recorded, `the switched-off id is described; got ${JSON.stringify(writes[0].attribution)}`);
    assert(recorded.extension === '@juggler/exa' && recorded.type === 'context-item',
      `with its extension and type; got ${JSON.stringify(recorded)}`);
    assert(recorded.file === 'exa-search-context-item.js',
      `and its module file, not the served URL; got ${recorded.file}`);
    assert(recorded.name === 'Exa Search', `and its name; got ${recorded.name}`);

    await el._toggle(['exa-search'], true);
    assert(Object.keys(writes[1].attribution).length === 0,
      `switching on records nothing; got ${JSON.stringify(writes[1].attribution)}`);
  });

  // Attribution is a hint, not authority. It is matched on base name within one
  // extension, never on the served URL, because a user extension's URL carries
  // an epoch segment that changes whenever extensions are rescanned — a stored
  // URL would stop matching the moment anything was installed.
  await run('attribution matches across a changed URL but not across extensions', async () => {
    const attribution = {
      'exa-search': {
        extension: '@juggler/exa',
        file: 'exa-search-context-item.js',
        type: 'context-item',
        name: 'Exa Search',
      },
    };
    const make = (/** @type {string} */ extId, /** @type {string} */ url) => buildExtensionCards([{
      manifest: { id: extId, name: extId, version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: [url], strategies: [], commands: [] },
      error: '',
    }], new Map(), new Map(), new Set(['exa-search']), attribution);

    // A different epoch in the prefix is the same file.
    const moved = make('@juggler/exa', '/user-extensions/e99/exa/context-items/exa-search-context-item.js');
    assert(moved[0].caps[0].id === 'exa-search',
      `an epoch bump must not break the match; got ${moved[0].caps[0].id}`);

    // The same base name under a different extension is a different capability.
    const impostor = make('@someone/else', '/user-extensions/e7/else/context-items/exa-search-context-item.js');
    assert(impostor[0].caps[0].id === null,
      `another extension's identically-named file must not claim the id; got ${impostor[0].caps[0].id}`);
  });

  // Not every capability arrives by importing a module. User slash commands are
  // synthesised from markdown and item-owned strategies are handed over by the
  // context items that own them; both register through registerClass, and both
  // do it AFTER init() has already run the disabled filter. A registerClass that
  // doesn't consult the same set therefore switches its capability on regardless
  // of config — so disabling a user command did nothing whatsoever.
  await run('a capability registered after init is filtered by the same disabled set', async () => {
    const reg = new TestRegistry();
    await withPluginConfig(['late'], () => reg._applyDisabledFilter());

    const outcome = reg.registerClass(fakeClass('late'), {
      extensionId: null,
      modulePath: 'user-command:project/late',
    });

    assert(outcome.registered === false,
      `a disabled id is not registered as live; got ${JSON.stringify(outcome)}`);
    assert(!reg.has('late'), 'and it does not reach the enabled set');
    const entry = reg.getCatalogManifests().find((m) => m.id === 'late');
    assert(entry && entry.disabled === true,
      `it is reported as disabled rather than missing; got ${JSON.stringify(entry)}`);
    assert(entry && entry.modulePath === 'user-command:project/late',
      `keeping the path it registered under; got ${entry?.modulePath}`);
    assert(reg.getIncludingDisabled('late'), 'and its class is still reachable');
  });

  // The extension-level spelling has to work for a late registration too: an
  // item-owned strategy is switched off by disabling the extension that provides
  // the item, without anyone naming the strategy's own id.
  await run('a late registration is disabled by its extension id as well as its own', async () => {
    const reg = new TestRegistry();
    await withPluginConfig(['@jules/pack'], () => reg._applyDisabledFilter());

    reg.registerClass(fakeClass('owned'), { extensionId: '@jules/pack', modulePath: '' });

    assert(!reg.has('owned'), 'switched off through its owning extension');
    const entry = reg.getCatalogManifests().find((m) => m.id === 'owned');
    assert(entry && entry.disabled === true && entry.extensionId === '@jules/pack',
      `and reported disabled, attributed; got ${JSON.stringify(entry)}`);
  });

  // "Not installed" has to mean it: a capability that no extension card shows
  // may still be installed and known. User slash commands are the case — they
  // are synthesised rather than served from an extension, so no card lists them,
  // and they have a manager of their own. Filing one under Not-installed because
  // the catalog can't see it would be the catalog reporting its own blind spot
  // as the user's problem.
  await run('an id a registry knows is not reported as not-installed', async () => {
    const cards = buildExtensionCards([{
      manifest: { id: '@jules/pack', name: 'Pack', version: '1.0.0' },
      source: 'user',
      capabilities: { contextItems: [], strategies: [], commands: [] },
      error: '',
    }], new Map(), new Map(), new Set());
    const disabled = new Set(['my-command', 'long-gone']);

    const known = new Set(['my-command']);
    const orphans = collectOrphanedDisabled(cards, disabled, known);
    assert(orphans.length === 1 && orphans[0] === 'long-gone',
      `only the id nothing at all provides is orphaned; got ${JSON.stringify(orphans)}`);
  });

  // Six registries rebuild together, and each used to fetch /api/config/plugins
  // for itself — six reads of one fact, with the catalog's own read making seven
  // and a different staleness policy from the rest. They now share one accessor
  // with one cache, cleared by the same resetExtensionsCache() a real toggle
  // already goes through, so the set every registry splits on is the same set.
  await run('the whole registry set reads the disabled config once', async () => {
    const { resetExtensionsCache } = await import('../../js/services/extensions.js');
    const orig = window.fetch;
    let reads = 0;
    window.fetch = async (/** @type {any} */ url) => {
      if (String(url).includes('/api/config/plugins')) reads++;
      return /** @type {any} */ ({ ok: true, json: async () => ({ disabled: ['lint'] }) });
    };
    try {
      resetExtensionsCache();
      const regs = [new TestRegistry(), new TestRegistry(), new TestRegistry()];
      for (const reg of regs) {
        reg.items.set('lint', fakeClass('lint'));
        reg.modulePaths.set('lint', '/u/pack/lint-context-item.js');
      }
      await Promise.all(regs.map((reg) => reg._applyDisabledFilter()));

      assert(reads === 1, `three registries should share one read; made ${reads}`);
      for (const reg of regs) {
        assert(!reg.has('lint'), 'and every one of them applied the set it got');
      }

      // A toggle invalidates, so the next pass sees the new truth.
      resetExtensionsCache();
      await regs[0]._applyDisabledFilter();
      assert(reads === 2, `invalidation should force a fresh read; made ${reads}`);
    } finally {
      window.fetch = orig;
      resetExtensionsCache();
    }
  });

  // An unreadable config must not switch anything on. Collapsing the set to
  // empty would re-enable every disabled capability for as long as the blip
  // lasts, which for an extension-level disable also flips the system-prompt
  // bytes and cold-starts a warm provider cache.
  await run('an unreadable config leaves the split exactly as it stands', async () => {
    const { resetExtensionsCache } = await import('../../js/services/extensions.js');
    const reg = new TestRegistry();
    reg.items.set('lint', fakeClass('lint'));
    reg.modulePaths.set('lint', '/u/pack/lint-context-item.js');

    const orig = window.fetch;
    try {
      resetExtensionsCache();
      window.fetch = async () => /** @type {any} */ ({ ok: true, json: async () => ({ disabled: ['lint'] }) });
      await reg._applyDisabledFilter();
      assert(!reg.has('lint'), 'switched off while the config was readable');

      resetExtensionsCache();
      window.fetch = async () => { throw new Error('offline'); };
      await reg._applyDisabledFilter();
      assert(!reg.has('lint'), 'and stays off when the config cannot be read');
    } finally {
      window.fetch = orig;
      resetExtensionsCache();
    }
  });

  // The disabled filter runs at the end of init(), and init() marks itself
  // initialized only once it has finished — so two overlapping inits (app
  // startup racing the `plugin-changed` broadcast a config write triggers) both
  // run the filter in full against one registry. The pass must therefore be
  // idempotent. Clearing _disabledItems and then re-deriving it from this.items
  // is not: the first pass moves the capability OUT of items, so the second
  // clears the record and finds nothing to re-record. The capability is then in
  // neither map — not enabled, not disabled, simply gone — and the catalog row
  // it backs loses its id, its name and its toggle.
  await run('the disabled filter is idempotent across repeated passes', async () => {
    const url = '/extensions/exa/context-items/exa-search-context-item.js';
    const reg = new TestRegistry();
    reg.items.set('exa-search', fakeClass('exa-search'));
    reg.modulePaths.set('exa-search', url);
    reg.itemExtensions.set('exa-search', '@juggler/exa');

    await withPluginConfig(['exa-search'], async () => {
      await reg._applyDisabledFilter();
      await reg._applyDisabledFilter();
    });

    assert(!reg.has('exa-search'), 'it is still disabled, not silently re-enabled');
    const entry = reg.getCatalogManifests().find((m) => m.id === 'exa-search');
    assert(entry, 'a second pass does not erase the capability');
    assert(entry && entry.disabled === true && entry.modulePath === url,
      `and it keeps its disabled state and served URL; got ${JSON.stringify(entry)}`);
  });

  // The mirror of it: an id leaving the disabled list must come back, without
  // waiting for a full reset/re-init. A filter that only ever moves items one
  // way leaves the capability stranded in _disabledItems.
  await run('the disabled filter restores a capability once its id leaves the list', async () => {
    const reg = new TestRegistry();
    reg.items.set('exa-search', fakeClass('exa-search'));
    reg.modulePaths.set('exa-search', '/x/exa-search-context-item.js');
    reg.itemExtensions.set('exa-search', '@juggler/exa');

    await withPluginConfig(['exa-search'], () => reg._applyDisabledFilter());
    assert(!reg.has('exa-search'), 'switched off by the first pass');
    // The id leaves the list, and the cache is invalidated as a real toggle does.
    await withPluginConfig([], () => reg._applyDisabledFilter());

    assert(reg.has('exa-search'), 'switched back on by the next pass');
    const entry = reg.getCatalogManifests().find((m) => m.id === 'exa-search');
    assert(entry && entry.disabled === false,
      `and reported enabled; got ${JSON.stringify(entry)}`);
  });

  // Switching ONE capability off inside an ENABLED extension must leave that
  // capability's own row in place, reading `off`, with a badge that switches it
  // back on. The row is the only control bound to the id; if it goes, the id is
  // reachable only from the Not-installed group, which is the recovery path, not
  // the everyday one. Modelled on `@juggler/exa`, the one extension the build
  // ships switched off — so it is on only by countermand, and that is the
  // combination in doubt: extension on, one capability inside it off. Driven
  // through the registry rather than the live config endpoint, because the
  // iframe pool shares one project config.json and a real toggle write pollutes
  // sibling lanes' registry re-inits (see the module comment).
  await run('disabling one capability inside an enabled extension keeps its row', async () => {
    const url = '/extensions/exa/context-items/exa-search-context-item.js';
    const reg = new TestRegistry();
    reg.items.set('exa-search', fakeClass('exa-search'));
    reg.modulePaths.set('exa-search', url);
    reg.itemExtensions.set('exa-search', '@juggler/exa');

    // What the server resolves to once the countermand is applied: the
    // extension is ON, the capability alone is OFF.
    await withPluginConfig(['exa-search'], () => reg._applyDisabledFilter());

    const entry = reg.getCatalogManifests().find((m) => m.id === 'exa-search');
    assert(entry && entry.disabled === true,
      'the capability is reported disabled, not dropped');
    assert(entry && entry.modulePath === url,
      `and keeps its served URL, so its row can be matched; got ${entry?.modulePath}`);

    const extensions = [{
      manifest: { id: '@juggler/exa', name: 'Exa Search', version: '0.1.0' },
      source: 'builtin',
      capabilities: { contextItems: [url], strategies: [], commands: [] },
      error: '',
    }];
    const byPath = new Map([[url, {
      id: entry.id, manifest: entry.manifest, itemType: 'context-item', disabled: true,
    }]]);
    const disabled = new Set(['exa-search']);
    const cards = buildExtensionCards(extensions, byPath, new Map(), disabled);

    assert(collectOrphanedDisabled(cards, disabled).length === 0,
      'nothing is orphaned — a live row claims the id');

    const el = /** @type {any} */ (document.createElement('plugin-catalog'));
    el._cards = cards;
    el._disabledIds = disabled;
    el._orphanedDisabled = [];
    el.render();

    const badge = el.querySelector('[data-testid="toggle-cap:context-item:exa-search"]');
    assert(badge, 'the row survives being switched off');
    assert(badge && badge.textContent === 'off' && !badge.disabled,
      `and reads off with a live toggle back on; got ${badge?.textContent}`);
  });

  return { passed, failed, errors };
}
