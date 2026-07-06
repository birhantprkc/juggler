//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model display-label tests.
 *
 * Naming is the provider's job — each provider ships a `displayName` on its
 * model list. `model-display.js` only *renders* it: the display name when
 * present, else the bare wire id (with the `models/` namespace stripped). There
 * is deliberately no prettifying or per-provider logic here to test; the
 * derivation lives in Go (providers/utils.ModelDisplayName) and is covered by
 * that package's tests.
 * @module unit-tests/model-display-test
 */

import {
  baseModelLabel,
  modelLabel,
  modelLabelFromList
} from '../../js/model/model-display.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run model-display tests.
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
   * @param {() => void} fn
   */
  function test(name, fn) {
    try {
      fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  // ---- baseModelLabel ----

  test('baseModelLabel strips the models/ namespace prefix', () => {
    assert(baseModelLabel('models/gemini-2.5-pro') === 'gemini-2.5-pro', 'prefix not stripped');
    assert(baseModelLabel('opus') === 'opus', 'bare id unchanged');
    assert(baseModelLabel('') === '', 'empty tolerated');
  });

  // ---- modelLabel: displayName wins, id is the fallback ----

  test('modelLabel uses the provider-supplied display name verbatim', () => {
    assert(modelLabel('Claude Opus (CLI)', 'opus') === 'Claude Opus (CLI)', 'claudecode');
    assert(modelLabel('Gemini 2.5 Pro', 'models/gemini-2.5-pro') === 'Gemini 2.5 Pro', 'gemini');
  });

  test('modelLabel falls back to the bare id when no display name is given', () => {
    assert(modelLabel(undefined, 'gpt-5') === 'gpt-5', 'undefined name');
    assert(modelLabel('', 'gpt-5') === 'gpt-5', 'empty name');
    assert(modelLabel('   ', 'gpt-5') === 'gpt-5', 'whitespace name');
    assert(modelLabel(undefined, 'models/gemini-2.5-pro') === 'gemini-2.5-pro', 'fallback strips namespace');
  });

  // ---- modelLabelFromList: resolve displayName from a providers list ----

  const providers = [
    {
      name: 'claudecode',
      modelsWithContext: [
        { id: 'opus', displayName: 'Claude Opus (CLI)' },
        { id: 'fable' } // no displayName -> id fallback
      ]
    },
    {
      name: 'gemini',
      modelsWithContext: [{ id: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }]
    }
  ];

  test('modelLabelFromList resolves the provider display name', () => {
    assert(
      modelLabelFromList(providers, 'claudecode', 'opus') === 'Claude Opus (CLI)',
      'claudecode displayName not resolved'
    );
    assert(
      modelLabelFromList(providers, 'gemini', 'models/gemini-2.5-pro') === 'Gemini 2.5 Pro',
      'gemini displayName not resolved'
    );
  });

  test('modelLabelFromList falls back to the id when the entry has no display name', () => {
    assert(modelLabelFromList(providers, 'claudecode', 'fable') === 'fable', 'missing displayName');
  });

  test('modelLabelFromList tolerates an unknown provider/model or missing list', () => {
    assert(modelLabelFromList(providers, 'nope', 'ghost-1') === 'ghost-1', 'unknown provider');
    assert(modelLabelFromList(providers, 'gemini', 'unlisted') === 'unlisted', 'unlisted model');
    assert(modelLabelFromList(undefined, 'claudecode', 'opus') === 'opus', 'missing list tolerated');
  });

  return { passed, failed, errors };
}
