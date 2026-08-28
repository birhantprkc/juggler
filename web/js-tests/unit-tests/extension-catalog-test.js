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

import { assert } from '../utilities/test-helpers.js';
import { badgeForItem } from '../../js/utils/item-badge.js';
import '../../js/components/properties-panel.js';
import '../../js/components/settings-panel.js';
import BaseRegistry from '../../js/registries/base-registry.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import {
  buildExtensionCards,
  computeNextDisabled,
} from '../../js/components/plugin-catalog.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import commandRegistry from '../../js/registries/command-registry.js';

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
 * @param {string} id
 * @returns {any} A minimal class with a MANIFEST.
 */
function fakeClass(id) {
  return { MANIFEST: { id, name: id, version: '1.0.0', description: `${id} desc` } };
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

    const orig = window.fetch;
    window.fetch = async () => /** @type {any} */ ({
      ok: true,
      json: async () => ({ disabled: ['@jules/pack'], enabled: [] }),
    });
    try {
      await reg._applyDisabledFilter();
    } finally {
      window.fetch = orig;
    }

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

    const orig = window.fetch;
    window.fetch = async () => /** @type {any} */ ({
      ok: true,
      json: async () => ({ disabled: ['lint'], enabled: [] }),
    });
    try {
      await reg._applyDisabledFilter();
    } finally {
      window.fetch = orig;
    }

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

    const orig = window.fetch;
    window.fetch = async () => /** @type {any} */ ({
      ok: true,
      json: async () => ({ disabled: ['@jules/pack'], enabled: [] }),
    });
    try {
      await reg._applyDisabledFilter();
    } finally {
      window.fetch = orig;
    }

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

  return { passed, failed, errors };
}
