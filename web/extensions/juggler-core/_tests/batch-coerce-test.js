//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * BatchContextItem argument-coercion unit tests.
 *
 * Some models double-encode array arguments as a JSON string — e.g. they emit
 *   { searches: "[{\"pattern\": \"foo\"}]" }
 * instead of the array literal the schema asks for. Before the coercion fix
 * this produced two visible failures:
 *
 *   1. validate() rejected the call with "searches must be a non-empty array"
 *      even though the content was fully present (just string-wrapped).
 *   2. getStatusUI() read the raw string and reported `string.length` as the
 *      item count, rendering a "huge list" of bogus boxes (one per character).
 *
 * BatchContextItem._coerceArray parses a JSON-string-of-an-array back into the
 * array so both paths behave. Anything that is genuinely malformed (a plain
 * string, a non-array JSON value) is left untouched so the real validation
 * error still surfaces.
 * @module unit-tests/batch-coerce-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import BatchContextItem from '../context-items/batch-context-item.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
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

  // validate()/getStatusUI()/_coerceArray() use no instance state; the base
  // ContextItem constructor only requires these fields to be truthy.
  const item = new BatchContextItem({
    id: 'test-batch',
    session: {},
    conversation: {},
    messageThread: {}
  });

  const stringifiedSearches = JSON.stringify([
    { pattern: 'window/control', glob: 'cmd/juggler/server/*.go', output_mode: 'content' },
    { pattern: 'instance.json|Addr|port', glob: 'cmd/juggler/core/*.go', output_mode: 'content' }
  ]);

  await run('_coerceArray parses a JSON-string-of-an-array', () => {
    const out = BatchContextItem._coerceArray(stringifiedSearches);
    assert(Array.isArray(out) && out.length === 2,
      `expected 2-element array, got ${JSON.stringify(out)}`);
    assert(out[0].pattern === 'window/control',
      `expected first pattern preserved, got ${out[0]?.pattern}`);
  });

  await run('_coerceArray passes a real array through unchanged', () => {
    const arr = [{ pattern: 'x' }];
    assert(BatchContextItem._coerceArray(arr) === arr, 'array identity should be preserved');
  });

  await run('_coerceArray leaves a non-JSON string untouched', () => {
    assert(BatchContextItem._coerceArray('not json') === 'not json',
      'unparseable string should be returned as-is');
  });

  await run('_coerceArray leaves a JSON non-array untouched', () => {
    // `{"pattern":"x"}` parses but isn't an array — return original so the
    // caller's array check still reports the real shape error.
    const obj = '{"pattern":"x"}';
    assert(BatchContextItem._coerceArray(obj) === obj,
      'JSON object string should not be unwrapped to an object');
  });

  await run('validate accepts a stringified searches array (batch_grep)', async () => {
    const result = await item.validate({ searches: stringifiedSearches });
    assert(result.valid === true, `expected valid, got error: ${result.error}`);
    assert(result.params._batchType === 'grep', `expected grep, got ${result.params?._batchType}`);
    assert(Array.isArray(result.params.searches) && result.params.searches.length === 2,
      'validated searches must be a 2-element array');
  });

  await run('validate accepts a stringified files array (batch_read)', async () => {
    const files = JSON.stringify([{ file_path: '/a.txt' }, { file_path: '/b.txt' }]);
    const result = await item.validate({ files });
    assert(result.valid === true, `expected valid, got error: ${result.error}`);
    assert(result.params._batchType === 'read', `expected read, got ${result.params?._batchType}`);
    assert(Array.isArray(result.params.files) && result.params.files.length === 2,
      'validated files must be a 2-element array');
  });

  await run('validate still rejects a genuinely empty array', async () => {
    const result = await item.validate({ searches: '[]' });
    assert(result.valid === false, 'empty array must remain invalid');
    assert(result.error === 'searches must be a non-empty array',
      `expected non-empty-array error, got ${result.error}`);
  });

  await run('validate still rejects a malformed (non-array) searches string', async () => {
    const result = await item.validate({ searches: 'totally bogus' });
    assert(result.valid === false, 'malformed searches must remain invalid');
    assert(result.error === 'searches must be a non-empty array',
      `expected non-empty-array error, got ${result.error}`);
  });

  await run('getStatusUI counts coerced searches, not string length', () => {
    const ui = item.getStatusUI({ pending: true }, { searches: stringifiedSearches });
    assert(ui.typeName === 'BatchGrep', `expected BatchGrep, got ${ui?.typeName}`);
    assert(ui.summary === '2 searches...', `expected "2 searches...", got "${ui?.summary}"`);
  });

  await run('getStatusUI counts coerced files, not string length', () => {
    const files = JSON.stringify([{ file_path: '/a.txt' }, { file_path: '/b.txt' }]);
    const ui = item.getStatusUI({ pending: true }, { files });
    assert(ui.typeName === 'BatchRead', `expected BatchRead, got ${ui?.typeName}`);
    assert(ui.summary === '2 files...', `expected "2 files...", got "${ui?.summary}"`);
  });

  // The properties-panel render path must coerce too — otherwise a stringified
  // `searches` is iterated character-by-character, emitting one empty "Pattern"
  // subsection per character (the "huge list of empty boxes" bug).
  /** @returns {{labels: string[], addSubsection: Function}} Helpers recording rendered subsection labels. */
  const recordingHelpers = () => {
    /** @type {string[]} */
    const labels = [];
    return {
      labels,
      addSubsection: (/** @type {any} */ _wrapper, /** @type {string} */ label) => {
        labels.push(label);
      }
    };
  };

  await run('renderToolActionDetails coerces a stringified searches array', () => {
    const helpers = recordingHelpers();
    item.renderToolActionDetails({}, {
      toolName: 'batch_grep',
      input: { searches: stringifiedSearches },
      helpers
    });
    // Two real searches: one "Pattern" each, plus a "Glob" each (both fixtures
    // set glob). No per-character explosion.
    const patternCount = helpers.labels.filter((l) => l === 'Pattern').length;
    assert(patternCount === 2,
      `expected 2 Pattern subsections, got ${patternCount} (labels: ${helpers.labels.length})`);
  });

  await run('renderToolActionDetails coerces a stringified files array', () => {
    const helpers = recordingHelpers();
    const files = JSON.stringify([{ file_path: '/a.txt' }, { file_path: '/b.txt' }]);
    item.renderToolActionDetails({}, {
      toolName: 'batch_read',
      input: { files },
      helpers
    });
    const fileCount = helpers.labels.filter((l) => l === 'File').length;
    assert(fileCount === 2,
      `expected 2 File subsections, got ${fileCount} (labels: ${helpers.labels.length})`);
  });

  return { passed, failed, errors };
}
