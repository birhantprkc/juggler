//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unified context-cache-impact detector tests: fingerprint construction and the
 * prefix-divergence classifier (see services/context-cache-impact.js). One
 * primitive covers every cause — strategy toolset change, item delete/edit, and
 * pure append — so the cases below exercise each through the same predicate.
 * @module unit-tests/context-cache-impact-test
 */

import {
  buildPrefixFingerprint,
  classifyContextCacheImpact,
  CONTEXT_CACHE_WARNING_TOKENS
} from '../../js/services/context-cache-impact.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * A minimal Y.Map-like item stub whose get(key) reads from a plain object.
 * @param {Record<string, any>} o - Field values keyed by name
 * @returns {{get: (k: string) => any}} A get()-able item stub
 */
function item(o) {
  return { get: (/** @type {string} */ k) => o[k] };
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Passing assertion count
 * @property {number} failed - Failing assertion count
 * @property {string[]} errors - Collected error messages
 */

/**
 * Run context-cache-impact tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => void} fn - Assertions to run
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (/** @type {any} */ e) { failed++; errors.push(`${name}: ${e.message}`); }
  }

  const big = CONTEXT_CACHE_WARNING_TOKENS + 1;
  const small = CONTEXT_CACHE_WARNING_TOKENS - 1;
  const items = [
    item({ itemId: 'a', type: 'user', content: 'hello' }),
    item({ itemId: 'b', type: 'assistant', content: 'hi there' }),
    item({ itemId: 'c', type: 'user', content: 'more' })
  ];
  const fp = (/** @type {string} */ sig, /** @type {any[]} */ its) =>
    buildPrefixFingerprint({ toolsetSig: sig, items: its });
  const baseline = fp('read,write', items);

  test('no baseline → none', () => {
    const impact = classifyContextCacheImpact({ baseline: null, current: baseline, anchorTokens: big });
    assert(impact === 'none', `expected none without a baseline, got ${impact}`);
  });

  test('small conversation → none (even with a divergence)', () => {
    const current = fp('read', items); // toolset changed
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: small });
    assert(impact === 'none', `expected none below the token floor, got ${impact}`);
  });

  test('identical prefix → none', () => {
    const impact = classifyContextCacheImpact({ baseline, current: fp('read,write', items), anchorTokens: big });
    assert(impact === 'none', `identical prefix must not warn, got ${impact}`);
  });

  test('pure append (new tail item) → none', () => {
    const appended = items.concat([item({ itemId: 'd', type: 'user', content: 'next' })]);
    const current = fp('read,write', appended);
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'none', `an append preserves the cached prefix, got ${impact}`);
  });

  test('toolset change (staged strategy switch) → busts-large', () => {
    const current = fp('read', items); // read-only removes write
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'busts-large', `a toolset change busts the prefix, got ${impact}`);
  });

  test('same toolset, no edits (default⇄yolo) → none', () => {
    const impact = classifyContextCacheImpact({ baseline, current: fp('read,write', items), anchorTokens: big });
    assert(impact === 'none', `a same-toolset switch preserves the prefix, got ${impact}`);
  });

  test('delete an early item → busts-large', () => {
    const current = fp('read,write', [items[1], items[2]]); // dropped 'a'
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'busts-large', `deleting an early item busts the prefix, got ${impact}`);
  });

  test('edit an early item (length change) → busts-large', () => {
    const edited = [item({ itemId: 'a', type: 'user', content: 'hello world!!' }), items[1], items[2]];
    const current = fp('read,write', edited);
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'busts-large', `editing an early item busts the prefix, got ${impact}`);
  });

  test('undo (fingerprint restored to baseline) → none', () => {
    // After an undo the transcript matches the captured baseline again.
    const restored = fp('read,write', items);
    const impact = classifyContextCacheImpact({ baseline, current: restored, anchorTokens: big });
    assert(impact === 'none', `a restored transcript must clear the caution, got ${impact}`);
  });

  return { passed, failed, errors };
}
