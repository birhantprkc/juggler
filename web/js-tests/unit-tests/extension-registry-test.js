//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Extension-registry switchover tests (Phase 2).
 *
 * After the registries stopped fetching `/api/{builtin}-plugins` and began
 * sourcing builtin capabilities from `/api/extensions` (the manifest-driven
 * `@juggler/core` extension), these tests prove parity by construction:
 *
 *   1. The extensions service returns `@juggler/core` with non-empty,
 *      error-free capability lists for all three plugin types.
 *   2. `getExtensionCapabilities()` attributes every capability ref to its
 *      owning extension id.
 *   3. After registry init, every known core capability still registers under
 *      the same bare id (no scoping leaked into cap ids — protects session
 *      restore) — context items, strategies, and commands alike.
 *   4. Each registered core capability is attributed to `@juggler/core` via the
 *      threaded `extensionId` on `getManifests()` / `getAllManifests()`.
 *   5. The LLM-facing tool set is intact: canonical core tool names still
 *      resolve to a context-item class.
 * @module unit-tests/extension-registry-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  fetchExtensions,
  getExtensionCapabilities,
  resetExtensionsCache,
} from '../../js/services/extensions.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import commandRegistry from '../../js/registries/command-registry.js';
import { createItem } from '../../sdk/registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const CORE = '@juggler/core';

// Representative core capability ids that must survive the switchover unchanged.
const CORE_CONTEXT_ITEMS = ['read-file', 'write-file', 'execute'];
const CORE_STRATEGIES = ['default', 'read-only', 'yolo'];
const CORE_COMMANDS = ['clear', 'compact', 'duplicate', 'handoff', 'new', 'thread'];

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregate test results.
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

  // Ensure the registries are initialized via the new extension-backed path.
  if (!contextItemRegistry.isInitialized()) await contextItemRegistry.init();
  if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
  if (!commandRegistry.isInitialized()) await commandRegistry.init();

  await run('extensions service returns @juggler/core with no error', async () => {
    resetExtensionsCache();
    const extensions = await fetchExtensions();
    assert(Array.isArray(extensions), 'expected an array of extensions');
    const core = extensions.find(e => e.manifest?.id === CORE);
    assert(core, `expected an extension with id ${CORE}`);
    assert(!core.error, `core extension reported an error: ${core.error}`);
    assert(core.source === 'builtin', `expected source 'builtin', got ${core.source}`);
    assert(core.capabilities.contextItems.length > 0, 'core has no context items');
    assert(core.capabilities.strategies.length > 0, 'core has no strategies');
    assert(core.capabilities.commands.length > 0, 'core has no commands');
  });

  await run('getExtensionCapabilities attributes builtin refs to @juggler/core', async () => {
    for (const type of /** @type {const} */ (['context-item', 'strategy', 'command'])) {
      const refs = await getExtensionCapabilities(type);
      assert(refs.length > 0, `no capability refs for type ${type}`);
      // At least the core extension contributes; every ref carries an owning
      // extension id. Builtin refs (served under /extensions/juggler-core/) must
      // be attributed to @juggler/core specifically. Other refs (anonymous
      // user wrappers) may also be present.
      const coreRefs = refs.filter(r => r.path.startsWith('/extensions/juggler-core/'));
      assert(coreRefs.length > 0, `no builtin /extensions/juggler-core/ refs for type ${type}`);
      for (const ref of refs) {
        assert(typeof ref.extensionId === 'string' && ref.extensionId.length > 0,
          `ref ${ref.path} has no extensionId`);
      }
      for (const ref of coreRefs) {
        assert(ref.extensionId === CORE,
          `builtin ref ${ref.path} attributed to ${ref.extensionId}, expected ${CORE}`);
      }
    }
  });

  await run('every known core context item still registers under its bare id', () => {
    for (const id of CORE_CONTEXT_ITEMS) {
      assert(contextItemRegistry.has(id), `context item "${id}" not registered`);
    }
  });

  await run('every known core strategy still registers under its bare id', () => {
    for (const id of CORE_STRATEGIES) {
      assert(strategyRegistry.has(id), `strategy "${id}" not registered`);
    }
  });

  await run('every known core command still registers under its bare id', () => {
    for (const id of CORE_COMMANDS) {
      assert(commandRegistry.has(id), `command "${id}" not registered`);
    }
  });

  await run('context-item manifests are attributed to @juggler/core', () => {
    const manifests = contextItemRegistry.getManifests();
    const byId = new Map(manifests.map(m => [m.id, m]));
    for (const id of CORE_CONTEXT_ITEMS) {
      const m = byId.get(id);
      assert(m, `manifest for "${id}" missing`);
      assert(m.extensionId === CORE,
        `context item "${id}" extensionId=${m.extensionId}, expected ${CORE}`);
    }
  });

  await run('strategy manifests are attributed to @juggler/core', () => {
    const manifests = strategyRegistry.getAllManifests();
    const byId = new Map(manifests.map(m => [m.id, m]));
    for (const id of CORE_STRATEGIES) {
      const m = byId.get(id);
      assert(m, `strategy manifest for "${id}" missing`);
      assert(m.extensionId === CORE,
        `strategy "${id}" extensionId=${m.extensionId}, expected ${CORE}`);
    }
  });

  await run('canonical core tool names still resolve to a context-item class', () => {
    for (const toolName of ['read', 'write', 'bash']) {
      const cls = contextItemRegistry.getByToolName(toolName);
      assert(cls, `tool "${toolName}" did not resolve to a registered class`);
    }
  });

  await run('juggler/registry exposes a narrow createItem that delegates to the registry', () => {
    assert(typeof createItem === 'function', 'createItem named export should be a function');
    // Delegation: bad JSON surfaces the registry's own validation error.
    let threw = false;
    try {
      createItem(null, null, null, null);
    } catch (e) {
      threw = true;
      assert(/missing type/i.test(e.message), `expected registry validation error, got: ${e.message}`);
    }
    assert(threw, 'createItem(null) should throw the registry validation error');
  });

  return { passed, failed, errors };
}
