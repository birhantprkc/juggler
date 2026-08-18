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
  // As fp, but pinning the model signature that heads the fingerprint.
  const fpm = (/** @type {string} */ modelSig, /** @type {string} */ sig, /** @type {any[]} */ its) =>
    buildPrefixFingerprint({ modelSig, toolsetSig: sig, items: its });
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

  // ── Model / provider switches ────────────────────────────────────────────
  // The biggest bust there is, and the one no provider reports back: a cache
  // entry is scoped to one model at one provider, so a switch leaves NOTHING
  // cached — a different vendor never had the prefix at all.

  test('switching provider over a long conversation → busts-large', () => {
    const before = fpm('anthropic/claude-sonnet-4', 'read,write', many);
    const after = fpm('openai/gpt-5', 'read,write', many);
    const impact = classifyContextCacheImpact({ baseline: before, current: after, anchorTokens: big });
    assert(impact === 'busts-large', `a provider switch discards the whole prefix, got ${impact}`);
  });

  test('switching model within one provider → busts-large', () => {
    // Cache entries are keyed per-model, so a sibling model is just as cold.
    const before = fpm('anthropic/claude-sonnet-4', 'read,write', many);
    const after = fpm('anthropic/claude-opus-4', 'read,write', many);
    const impact = classifyContextCacheImpact({ baseline: before, current: after, anchorTokens: big });
    assert(impact === 'busts-large', `a sibling model keys its own cache, got ${impact}`);
  });

  test('same model, untouched transcript → none', () => {
    const before = fpm('anthropic/claude-sonnet-4', 'read,write', many);
    const after = fpm('anthropic/claude-sonnet-4', 'read,write', many);
    const impact = classifyContextCacheImpact({ baseline: before, current: after, anchorTokens: big });
    assert(impact === 'none', `an unchanged model must stay silent, got ${impact}`);
  });

  test('changing the thinking level → busts-large', () => {
    // The thinking configuration is rendered INTO the prompt, so changing the
    // level starts a new prefix and the message cache misses unconditionally —
    // same total loss as changing the model, from a control that looks unrelated.
    const before = fpm('anthropic/claude-sonnet-4#medium', 'read,write', many);
    const after = fpm('anthropic/claude-sonnet-4#high', 'read,write', many);
    const impact = classifyContextCacheImpact({ baseline: before, current: after, anchorTokens: big });
    assert(impact === 'busts-large', `a thinking-level change starts a new prefix, got ${impact}`);
  });

  test('switching model on a small conversation → none', () => {
    // Total loss, but of almost nothing: the magnitude gate still rules.
    const few = [sized('a', 10), sized('b', 10)];
    const before = fpm('anthropic/claude-sonnet-4', 'read,write', few);
    const after = fpm('openai/gpt-5', 'read,write', few);
    const impact = classifyContextCacheImpact({ baseline: before, current: after, anchorTokens: 10000 });
    assert(impact === 'none', `a full bust of a small context is not worth cautioning, got ${impact}`);
  });

  test('undo (fingerprint restored to baseline) → none', () => {
    // After an undo the transcript matches the captured baseline again.
    const restored = fp('read,write', many);
    const impact = classifyContextCacheImpact({ baseline, current: restored, anchorTokens: big });
    assert(impact === 'none', `a restored transcript must clear the caution, got ${impact}`);
  });

  // ── Leading `prefix` context items (frozen pinned/dropped files) ──────────
  // These sit between tools+system and the growing history, so they ARE part of
  // the cached prefix now: add/remove/re-pin busts from their position.
  const fpp = (
    /** @type {string} */ sig,
    /** @type {any[]} */ prefixItems,
    /** @type {any[]} */ its
  ) => buildPrefixFingerprint({ toolsetSig: sig, prefixItems, items: its });
  /**
   * A `prefix` context-item stub with a content length, so the re-read slice can
   * be sized by content just like history items.
   * @param {string} id - Context item id
   * @param {number} len - Frozen content length in chars
   * @returns {{id: string, type: string, data: {content: string}}} A context-item stub
   */
  const pctx = (/** @type {string} */ id, /** @type {number} */ len) =>
    ({ id, type: 'file-content', data: { content: 'x'.repeat(len) } });

  test('identical prefix items → none', () => {
    const b = fpp('read,write', [pctx('FILE_1', 40)], many);
    const c = fpp('read,write', [pctx('FILE_1', 40)], many);
    const impact = classifyContextCacheImpact({ baseline: b, current: c, anchorTokens: big });
    assert(impact === 'none', `an unchanged pin must not warn, got ${impact}`);
  });

  test('adding a leading prefix item busts the whole history after it → busts-large', () => {
    const b = fpp('read,write', [], many);
    const c = fpp('read,write', [pctx('FILE_1', 40)], many);
    const impact = classifyContextCacheImpact({ baseline: b, current: c, anchorTokens: big });
    assert(impact === 'busts-large', `a new pin ahead of history re-reads all of it, got ${impact}`);
  });

  test('re-pinning a prefix item to different bytes busts → busts-large', () => {
    const b = fpp('read,write', [pctx('FILE_1', 40)], many);
    const c = fpp('read,write', [pctx('FILE_1', 41)], many); // re-snapshot, new length
    const impact = classifyContextCacheImpact({ baseline: b, current: c, anchorTokens: big });
    assert(impact === 'busts-large', `a changed pin snapshot re-reads history after it, got ${impact}`);
  });

  test('removing a leading prefix item shifts all history after it → busts-large', () => {
    // Unpinning a leading item moves every history entry up one position, so the
    // fingerprint diverges at the pin's slot and re-reads the history after it —
    // the "add/remove cold-starts once" tradeoff, surfaced as a caution.
    const b = fpp('read,write', [pctx('FILE_1', 40)], many);
    const c = fpp('read,write', [], many);
    const impact = classifyContextCacheImpact({ baseline: b, current: c, anchorTokens: big });
    assert(impact === 'busts-large', `removing a leading pin re-reads the history after it, got ${impact}`);
  });

  return { passed, failed, errors };
}
