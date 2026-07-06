//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Extension capability-collision resolution tests.
 *
 * When two extensions provide the same capability id, the registry resolves the
 * collision deterministically by precedence (descriptor order) — NOT by which
 * module's import happens to resolve first. The lowest-precedence entry holds
 * the id; any duplicate is a surfaced load error, never a silent
 * last-write-wins.
 *
 * These drive `_resolveLoaded` (the resolution stage of init) directly with
 * synthetic loaded entries, so the algorithm is tested in isolation — the full
 * fetch→import→resolve path is covered by the extension-registry suite. Entry
 * `index` carries precedence; the input array is deliberately shuffled so a
 * passing test proves resolution honours index, not array position.
 * @module unit-tests/extension-collision-test
 */

import { assert } from '../utilities/test-helpers.js';
import BaseRegistry from '../../js/registries/base-registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors collected error messages
 */

/** Concrete BaseRegistry for testing (BaseRegistry is abstract). */
class TestRegistry extends BaseRegistry {
  constructor() {
    super('TestRegistry', ['id', 'name', 'version', 'description']);
  }

  /** @returns {Promise<object[]>} empty list of module paths. */
  async getModulePaths() {
    return [];
  }
}

/**
 * Build a synthetic loaded entry. `marker` distinguishes otherwise-identical
 * classes so the winning one is identifiable; `index` is the precedence rank.
 * @param {string} id
 * @param {string} marker
 * @param {string} extensionId
 * @param {number} index
 * @returns {object} the synthetic loaded entry.
 */
function entry(id, marker, extensionId, index) {
  return {
    id,
    ItemClass: { MANIFEST: { id, name: id, version: '1.0.0', description: marker } },
    modulePath: `mod://${extensionId}/${id}`,
    extensionId,
    index,
  };
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} aggregate pass/fail counts and errors.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * @param {TestRegistry} reg
   * @param {string} id
   * @returns {string} the manifest description marker for the resolved item.
   */
  const marker = (reg, id) => /** @type {any} */ (reg.get(id)).MANIFEST.description;

  run('distinct ids both register', () => {
    const reg = new TestRegistry();
    reg._resolveLoaded([
      entry('alpha', 'a', '@juggler/core', 0),
      entry('beta', 'b', '@juggler/core', 1),
    ]);
    assert(reg.has('alpha') && reg.has('beta'), 'both ids should register');
    assert(reg.getFailedModules().length === 0, 'no failures expected');
  });

  run('collision keeps lowest-precedence holder, surfaces duplicate', () => {
    const reg = new TestRegistry();
    // Shuffled: higher-precedence intruder listed first to prove order-independence.
    reg._resolveLoaded([
      entry('read-file', 'intruder', '@user/pack', 1),
      entry('read-file', 'core', '@juggler/core', 0),
    ]);
    assert(marker(reg, 'read-file') === 'core',
      `holder should win; got marker ${marker(reg, 'read-file')}`);
    const f = reg.getFailedModules();
    assert(f.length === 1, `expected 1 surfaced duplicate, got ${f.length}`);
    assert(/duplicate capability id/i.test(f[0].error),
      `expected duplicate-id error, got: ${f[0].error}`);
    const m = reg.getManifests().find(x => x.id === 'read-file');
    assert(m && m.extensionId === '@juggler/core',
      `expected @juggler/core, got ${m && m.extensionId}`);
  });

  run('lowest-precedence wins a 3-way collision; both higher are surfaced', () => {
    const reg = new TestRegistry();
    reg._resolveLoaded([
      entry('x', 'project', '@proj/p', 2),
      entry('x', 'core', '@juggler/core', 0),
      entry('x', 'user', '@user/u', 1),
    ]);
    assert(marker(reg, 'x') === 'core', `core should hold; got ${marker(reg, 'x')}`);
    assert(reg.getFailedModules().length === 2, 'both duplicates surfaced');
  });

  return { passed, failed, errors };
}
