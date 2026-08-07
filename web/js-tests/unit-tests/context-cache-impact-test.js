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
  classifyContextCacheImpact
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

  const fp = (/** @type {string} */ sig, /** @type {any[]} */ its) =>
    buildPrefixFingerprint({ toolsetSig: sig, items: its });
  /**
   * A history item with a given content length, so the re-read slice can be sized
   * by content.
   * @param {string} id - Item id
   * @param {number} len - Content length in chars
   * @returns {{get: (k: string) => any}} An item stub
   */
  const sized = (/** @type {string} */ id, /** @type {number} */ len) =>
    item({ itemId: id, type: 'user', content: 'x'.repeat(len) });

  // A long, large-anchor conversation: 10 items × 10 chars = 100 chars of history
  // measured at 100k input tokens, i.e. 1000 tok/char. The 25k warning floor is
  // then ~25 chars ≈ 2.5 items of re-read — anything shorter stays silent.
  const big = 100000;
  const many = Array.from({ length: 10 }, (_, i) => sized(`m${i}`, 10));
  const baseline = fp('read,write', many);

  test('no baseline → none', () => {
    const impact = classifyContextCacheImpact({ baseline: null, current: baseline, anchorTokens: big });
    assert(impact === 'none', `expected none without a baseline, got ${impact}`);
  });

  test('identical prefix → none', () => {
    const impact = classifyContextCacheImpact({ baseline, current: fp('read,write', many), anchorTokens: big });
    assert(impact === 'none', `identical prefix must not warn, got ${impact}`);
  });

  test('pure append (even a huge new tail item) → none', () => {
    const appended = many.concat([sized('new', 100000)]); // a big pasted message
    const current = fp('read,write', appended);
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'none', `an append is new tail, not a re-read of cache, got ${impact}`);
  });

  test('same toolset, no edits (default⇄yolo) → none', () => {
    const impact = classifyContextCacheImpact({ baseline, current: fp('read,write', many), anchorTokens: big });
    assert(impact === 'none', `a same-toolset switch preserves the prefix, got ${impact}`);
  });

  test('edit near the start of a long conversation → busts-large', () => {
    const edited = [sized('m0', 12), ...many.slice(1)]; // first item changes
    const current = fp('read,write', edited);
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'busts-large', `an early edit re-reads the whole tail, got ${impact}`);
  });

  test('edit near the end of a long conversation → none', () => {
    const edited = [...many.slice(0, 9), sized('m9', 12)]; // only the last item changes
    const current = fp('read,write', edited);
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'none', `a late edit re-reads only a short tail, got ${impact}`);
  });

  test('delete from the middle leaving a large tail → busts-large', () => {
    const current = fp('read,write', [many[0], ...many.slice(2)]); // dropped 'm1'
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'busts-large', `an early delete re-reads the surviving tail, got ${impact}`);
  });

  test('delete near the end (short re-read tail) → none', () => {
    const current = fp('read,write', [...many.slice(0, 8), many[9]]); // dropped 'm8'
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'none', `deleting near the end re-reads only a short tail, got ${impact}`);
  });

  test('delete the whole tail (truncation) → none', () => {
    const current = fp('read,write', many.slice(0, 3)); // kept the first 3, dropped the rest
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'none', `truncating the tail leaves the shorter prefix fully cached, got ${impact}`);
  });

  test('/clear over a long conversation (current collapses to tools) → none', () => {
    const cleared = fp('read,write', []); // just the tool-set entry remains
    const impact = classifyContextCacheImpact({ baseline, current: cleared, anchorTokens: big });
    assert(impact === 'none', `a cleared conversation re-reads nothing, got ${impact}`);
  });

  test('toolset change over a long conversation → busts-large', () => {
    const current = fp('read', many); // read-only removes write; divergence at index 0
    const impact = classifyContextCacheImpact({ baseline, current, anchorTokens: big });
    assert(impact === 'busts-large', `a toolset change re-reads the whole history, got ${impact}`);
  });

  test('100% change but a small conversation → none', () => {
    // A toolset change busts from the very front (0% of the prefix survives), but
    // the whole conversation is tiny, so the re-read is cheap — who cares.
    const few = [sized('a', 10), sized('b', 10)];
    const smallBaseline = fp('read,write', few);
    const current = fp('read', few); // toolset changed → divergence at index 0
    const impact = classifyContextCacheImpact({ baseline: smallBaseline, current, anchorTokens: 10000 });
    assert(impact === 'none', `a full bust of a small context is not worth cautioning, got ${impact}`);
  });

  test('undo (fingerprint restored to baseline) → none', () => {
    // After an undo the transcript matches the captured baseline again.
    const restored = fp('read,write', many);
    const impact = classifyContextCacheImpact({ baseline, current: restored, anchorTokens: big });
    assert(impact === 'none', `a restored transcript must clear the caution, got ${impact}`);
  });

  return { passed, failed, errors };
}
