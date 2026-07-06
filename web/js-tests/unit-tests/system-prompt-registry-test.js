//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * System-prompt registry + preset-resolution tests.
 *
 * These cover the in-memory, per-iframe pieces only — the registry (built-in
 * catalog + user-preset merge) and the default-preset resolution — so they are
 * lane-safe: they never mutate the shared per-user preset store on the server
 * (which is load-modify-write and would race across pool lanes). Server
 * persistence is covered by Go unit tests (core/system_prompt_presets_test.go).
 * @module unit-tests/system-prompt-registry-test
 */

import {
  systemPromptRegistry,
  getDefaultIdentityText,
  BUILTIN_DEFAULT_ID
} from '../../sdk/lib/system-prompt-registry.js';
import { getDefaultPresetSeed, getDefaultPresetId } from '../../js/services/system-prompt-presets.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passing assertions.
 * @property {number} failed - Number of failing assertions.
 * @property {string[]} errors - Collected error messages.
 */

/**
 * Run system-prompt registry tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  await test('built-in presets are registered with neutral default content', () => {
    const def = systemPromptRegistry.getPreset('default');
    assert(!!def, 'default preset must exist');
    assert(def.builtin === true, 'default must be marked builtin');
    assert(systemPromptRegistry.getPreset('minimal') !== undefined, 'minimal preset must exist');
    assert(systemPromptRegistry.getPreset('code-reviewer') !== undefined, 'code-reviewer preset must exist');
    // Pruned persona presets are gone.
    assert(systemPromptRegistry.getPreset('mentor') === undefined, 'mentor preset should be removed');
    assert(systemPromptRegistry.getPreset('pair-programmer') === undefined, 'pair-programmer preset should be removed');
    assert(systemPromptRegistry.getPreset('architect') === undefined, 'architect preset should be removed');
  });

  await test('default preset body is neutral (no opinionated guidance)', () => {
    const content = getDefaultIdentityText();
    assert(content.includes('## Code'), 'default body should carry working-style guidance');
    assert(content.includes('`file_path:line_number`'), 'default body should carry the code-reference convention');
    assert(!content.includes('Git Workflow'), 'default body must not carry git rules');
    assert(!content.includes('disagree when necessary'), 'default body must not carry opinionated tone');
    assert(!content.includes('No time estimates'), 'default body must not carry the time-estimate rule');
  });

  await test('getCategories reflects built-in categories', () => {
    const cats = systemPromptRegistry.getCategories();
    assert(cats.includes('general'), 'general category present');
    assert(cats.includes('specialized'), 'specialized category present');
  });

  await test('setUserPresets merges user presets under the user category and replaces prior set', () => {
    systemPromptRegistry.setUserPresets([
      { id: 'user-a', name: 'Alpha', content: 'A body' },
      { id: 'user-b', name: 'Beta', content: 'B body' }
    ]);
    let userPresets = systemPromptRegistry.getPresetsByCategory('user');
    assert(userPresets.length === 2, `expected 2 user presets, got ${userPresets.length}`);
    assert(systemPromptRegistry.getPreset('user-a').category === 'user', 'user preset filed under user category');
    assert(systemPromptRegistry.getPreset('user-a').builtin === false, 'user preset marked non-builtin');

    // Built-ins survive a user-set replacement.
    assert(systemPromptRegistry.getPreset('default') !== undefined, 'built-ins must survive setUserPresets');

    // A second call replaces, not appends.
    systemPromptRegistry.setUserPresets([{ id: 'user-c', name: 'Gamma', content: 'C body' }]);
    userPresets = systemPromptRegistry.getPresetsByCategory('user');
    assert(userPresets.length === 1 && userPresets[0].id === 'user-c', 'setUserPresets should replace the prior user set');
    assert(systemPromptRegistry.getPreset('user-a') === undefined, 'old user preset removed on replace');

    // Clearing removes all user presets, leaving built-ins.
    systemPromptRegistry.setUserPresets([]);
    assert(systemPromptRegistry.getPresetsByCategory('user').length === 0, 'empty setUserPresets clears user presets');
    assert(systemPromptRegistry.getPreset('default') !== undefined, 'built-ins remain after clear');
  });

  await test('setUserPresets ignores malformed entries', () => {
    systemPromptRegistry.setUserPresets([
      { id: 'user-ok', name: 'OK', content: 'body' },
      { id: '', name: 'no id', content: 'x' },
      { id: 'user-nocontent', name: 'no content', content: '' },
      null
    ]);
    const userPresets = systemPromptRegistry.getPresetsByCategory('user');
    assert(userPresets.length === 1 && userPresets[0].id === 'user-ok', 'only the well-formed user preset is registered');
    systemPromptRegistry.setUserPresets([]); // cleanup
  });

  await test('default preset resolution falls back to the built-in default', () => {
    // With no explicit server-side default set in this lane, resolution lands
    // on the built-in default.
    assert(getDefaultPresetId() === BUILTIN_DEFAULT_ID, 'default id resolves to built-in default');
    const seed = getDefaultPresetSeed();
    assert(seed.id === BUILTIN_DEFAULT_ID, 'seed id is the built-in default');
    assert(seed.content === getDefaultIdentityText(), 'seed content is the built-in default body');
    assert(seed.content.includes('## Code'), 'seed body carries the neutral guidance');
  });

  return { passed, failed, errors };
}
