//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model shortlist (recommended-models) curation tests.
 *
 * `getRecommendedModels` curates a provider's raw model list into the "top"
 * shortlist shown by the model selector. The strategy is lineage-aware: group
 * models into product lines (the gpt-5.x flagship, the *-codex coding line, the
 * *-mini budget line, the glm-4.x line …), keep only the current generation of
 * each line (plus a close predecessor), keep ALL sibling variants of a kept
 * generation, and return the survivors newest-first.
 *
 * This suite pins the behaviours that motivated the redesign:
 *   1. same-generation siblings (gpt-5.6 sol/terra/luna) all survive together,
 *   2. superseded generations in the same lineage (5.1, 5.2, 4o) are dropped,
 *   3. a distant predecessor is dropped but a close one is kept (the "couple
 *      of versions" rule) — including for a small (~8 model) glm list,
 *   4. each brand is capped to its two newest versions, so lagging -mini/-codex
 *      sub-lines can't pad the list with stale point-releases,
 *   5. hyphenated minor versions (claude-opus-4-7 == 4.7, gpt-5-6 == 5.6) and
 *      fused ones (gpt-4o == 4) parse correctly rather than collapsing to the
 *      bare major, which had defeated both curation and the version sort,
 *   6. the shortlist comes back sorted newest-first regardless of input order,
 *      and sortModelsByVersion orders a full list the same way (stable),
 *   7. tiny lists and specialized-only lists degrade gracefully.
 * @module unit-tests/model-filter-test
 */

import { getRecommendedModels, sortModelsByVersion } from '../../js/utils/model-filter.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build model objects from a list of ids (order preserved).
 * @param {string[]} ids
 * @returns {Array<{id: string}>} Model objects wrapping each id.
 */
function models(ids) {
  return ids.map(id => ({ id }));
}

/**
 * Extract the id list from a recommended-models result.
 * @param {Array<{id: string}>} result
 * @returns {string[]} The ids in result order.
 */
function ids(result) {
  return result.map(m => m.id);
}

/**
 * Run model-filter tests.
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

  // ---- same-generation siblings all survive; older generations drop ----
  await test('gpt-5.6 sol/terra/luna all kept, 5.1/5.2/4o dropped', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'gpt-5.2', 'gpt-5.1', 'gpt-4o',
    ])));
    assert(result.includes('gpt-5.6-sol'), 'sol kept');
    assert(result.includes('gpt-5.6-terra'), 'terra kept');
    assert(result.includes('gpt-5.6-luna'), 'luna kept');
    assert(!result.includes('gpt-5.2'), '5.2 dropped (distant predecessor)');
    assert(!result.includes('gpt-5.1'), '5.1 dropped');
    assert(!result.includes('gpt-4o'), '4o dropped (older gen, same lineage)');
  });

  // ---- separate lineages (codex, mini, o-series) each keep their newest ----
  await test('codex / mini / o-series curated as independent lineages', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'gpt-5.6-codex', 'gpt-5-codex',
      'gpt-5.6-mini', 'gpt-4o-mini',
      'o4-mini', 'o3',
      'gpt-5.2', 'gpt-5.1', 'gpt-4o',
    ])));
    assert(result.includes('gpt-5.6-codex'), 'newest codex kept');
    assert(!result.includes('gpt-5-codex'), 'older codex dropped');
    assert(result.includes('gpt-5.6-mini'), 'newest mini kept');
    assert(!result.includes('gpt-4o-mini'), 'older mini dropped');
    assert(result.includes('o4-mini'), 'o4-mini (o|mini lineage) kept');
    assert(result.includes('o3'), 'o3 (o lineage) kept — its own newest');
  });

  // ---- close predecessor kept (the "couple of versions" rule) ----
  await test('close minor predecessor kept, distant one dropped', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-4o',
    ])));
    assert(result.includes('gpt-5.6-sol'), '5.6 kept');
    assert(result.includes('gpt-5.5'), '5.5 kept (0.1 back, same major)');
    assert(!result.includes('gpt-5.2'), '5.2 dropped (0.4 back — big gap)');
  });

  // ---- major bump shows only the new major ----
  await test('major version bump drops the previous major', () => {
    const result = ids(getRecommendedModels(models([
      'glm-5.0', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.4', 'glm-4.3',
    ])));
    assert(result.includes('glm-5.0'), '5.0 kept');
    assert(!result.includes('glm-4.7'), '4.7 dropped (previous major)');
  });

  // ---- z.ai style: small (8) multi-generation list trims to the latest couple ----
  await test('glm 8-model list trims to the two newest versions', () => {
    const result = ids(getRecommendedModels(models([
      'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air',
      'glm-4.5-flash', 'glm-4.5-x', 'glm-4-32b-0414', 'glm-4-9b',
    ])));
    assert(result.includes('glm-4.7'), '4.7 kept');
    assert(result.includes('glm-4.6'), '4.6 kept (close predecessor)');
    assert(!result.includes('glm-4.5'), '4.5 dropped');
    // The per-brand cap keeps only the two newest versions (4.7, 4.6), so the
    // 4.5-era budget variants drop out as stale even though they head their
    // own lineage.
    assert(!result.includes('glm-4.5-air'), '4.5-air dropped (older than the two newest versions)');
    assert(!result.includes('glm-4.5-flash'), '4.5-flash dropped (stale version)');
  });

  // ---- per-brand cap: no more than the two newest versions of a family ----
  await test('brand capped to two newest versions across all sub-lines', () => {
    // Reproduces the reported OpenAI case: lagging codex/mini/pro sub-lines each
    // survive their own lineage, so without the cap the list shows 5.6, 5.5,
    // 5.4, 5.2 and 5.1. The cap trims it to just the two newest versions.
    const result = ids(getRecommendedModels(models([
      'gpt-5.6', 'gpt-5.5',
      'gpt-5.4-mini', 'gpt-5.2-codex', 'gpt-5.1-nano',
    ])));
    const versions = [...new Set(result.map(id => (id.match(/5\.\d/) || [])[0]))];
    assert(result.includes('gpt-5.6'), '5.6 kept');
    assert(result.includes('gpt-5.5'), '5.5 kept');
    assert(!result.includes('gpt-5.4-mini'), '5.4-mini dropped (third-newest version)');
    assert(!result.includes('gpt-5.2-codex'), '5.2-codex dropped');
    assert(!result.includes('gpt-5.1-nano'), '5.1-nano dropped');
    assert(versions.length <= 2, `at most two distinct versions, got ${versions.join(',')}`);
  });

  // ---- Anthropic hyphenated minor versions (claude-opus-4-7 == 4.7) ----
  await test('anthropic hyphenated versions curate per family, not collapse to major', () => {
    // Reproduces the reported case: raw ids write the minor with a hyphen and
    // append an 8-digit date, so bare-integer parsing collapsed 4.8/4.7/4.6/4.4
    // all to "4" and kept every one. Parsed correctly, opus trims to its two
    // newest and sonnet/haiku are their own families.
    const result = ids(getRecommendedModels(models([
      'claude-opus-4-8-20260101', 'claude-opus-4-7-20251201',
      'claude-opus-4-6', 'claude-opus-4-4',
      'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5',
    ])));
    assert(result.includes('claude-opus-4-8-20260101'), 'opus 4.8 kept');
    assert(result.includes('claude-opus-4-7-20251201'), 'opus 4.7 kept (close predecessor)');
    assert(!result.includes('claude-opus-4-6'), 'opus 4.6 dropped (third version)');
    assert(!result.includes('claude-opus-4-4'), 'opus 4.4 dropped');
    assert(result.includes('claude-sonnet-4-6'), 'sonnet 4.6 kept (own family)');
    assert(result.includes('claude-haiku-4-5'), 'haiku 4.5 kept (own family)');
  });

  // ---- OpenAI hyphenated versions (gpt-5-6 == 5.6) capped to two ----
  await test('hyphenated gpt versions parse as major.minor and cap to two', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-5-6', 'gpt-5-5', 'gpt-5-4', 'gpt-5-2', 'gpt-5-1', 'gpt-4o', 'o4-mini', 'o3',
    ])));
    assert(result.includes('gpt-5-6'), '5.6 kept');
    assert(result.includes('gpt-5-5'), '5.5 kept');
    assert(!result.includes('gpt-5-4'), '5.4 dropped (third version)');
    assert(!result.includes('gpt-5-2'), '5.2 dropped');
    assert(!result.includes('gpt-5-1'), '5.1 dropped');
  });

  // ---- output is sorted newest-first regardless of input order ----
  await test('shortlist sorted newest-first', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-4o', 'gpt-5.1', 'gpt-5.6-luna', 'o3', 'gpt-5.2', 'gpt-5.6-sol',
    ])));
    // gpt-5.6 variants (5.6) must precede o3 (3).
    const firstO3 = result.indexOf('o3');
    assert(result.indexOf('gpt-5.6-sol') < firstO3, '5.6 sorts before o3');
    assert(result.indexOf('gpt-5.6-luna') < firstO3, '5.6 luna sorts before o3');
  });

  // ---- same-generation ties preserve provider (API) order ----
  await test('same-generation variants keep API order', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.1', 'gpt-4o',
    ])));
    const kept = result.filter(id => id.startsWith('gpt-5.6'));
    assert(
      kept.join(',') === 'gpt-5.6-terra,gpt-5.6-sol,gpt-5.6-luna',
      `expected API order among 5.6 variants, got ${kept.join(',')}`
    );
  });

  // ---- preview de-prioritized within a generation when a stable sibling exists ----
  await test('preview variant dropped when a stable sibling shares its generation', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-5.6', 'gpt-5.6-preview', 'gpt-5.2', 'gpt-5.1', 'gpt-4o',
    ])));
    assert(result.includes('gpt-5.6'), 'stable 5.6 kept');
    assert(!result.includes('gpt-5.6-preview'), 'preview 5.6 dropped (stable sibling exists)');
  });

  // ---- specialized/non-chat models excluded ----
  await test('specialized models excluded from shortlist', () => {
    const result = ids(getRecommendedModels(models([
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'gpt-image-1', 'whisper-transcribe', 'sora-2', 'gpt-5.1',
    ])));
    assert(!result.some(id => /image|transcribe|sora/.test(id)), 'no specialized models');
    assert(result.includes('gpt-5.6-sol'), 'chat models still curated');
  });

  // ---- tiny lists shown in full (below curation threshold) ----
  await test('lists of <=4 models are shown in full', () => {
    const input = ['gpt-5.6', 'gpt-5.1', 'gpt-4o', 'o3'];
    const result = ids(getRecommendedModels(models(input)));
    assert(result.length === 4, 'all four kept (below MIN_CURATE_SIZE)');
    assert(input.every(id => result.includes(id)), 'nothing dropped');
  });

  // ---- graceful fallback when every model is specialized ----
  await test('all-specialized list falls back to full list', () => {
    const input = ['gpt-image-1', 'sora-2', 'whisper-transcribe', 'tts-1', 'gpt-realtime'];
    const result = ids(getRecommendedModels(models(input)));
    assert(result.length === input.length, 'fallback returns the original list unchanged');
  });

  // ---- sortModelsByVersion orders a full list newest-first ----
  await test('sortModelsByVersion orders a random full list newest-first', () => {
    const result = ids(sortModelsByVersion(models([
      'gpt-4.1', 'gpt-5.6-sol', 'o3', 'gpt-5.1', 'gpt-5.6-luna',
    ])));
    // 5.6 variants first, then 5.1, then 4.1, then o3 — newest version wins.
    assert(result.indexOf('gpt-5.6-sol') < result.indexOf('gpt-5.1'), '5.6 before 5.1');
    assert(result.indexOf('gpt-5.1') < result.indexOf('gpt-4.1'), '5.1 before 4.1');
    assert(result.indexOf('gpt-4.1') < result.indexOf('o3'), '4.1 before o3');
  });

  // ---- sortModelsByVersion parses fused and hyphenated versions ----
  await test('sortModelsByVersion parses gpt-4o and hyphenated ids', () => {
    const result = ids(sortModelsByVersion(models([
      'o3', 'gpt-4o', 'gpt-5-6', 'claude-opus-4-7-20251201', 'gpt-4.1',
    ])));
    // gpt-5-6 (5.6) and opus 4.7 outrank gpt-4o/gpt-4.1 (4.x), which outrank o3 (3).
    assert(result.indexOf('gpt-5-6') < result.indexOf('gpt-4o'), '5.6 before 4o');
    assert(result.indexOf('claude-opus-4-7-20251201') < result.indexOf('gpt-4o'), 'opus 4.7 before 4o');
    assert(result.indexOf('gpt-4o') < result.indexOf('o3'), 'gpt-4o (v4) before o3 (v3)');
    assert(result[result.length - 1] === 'o3', 'o3 (v3) sorts last');
  });

  // ---- sortModelsByVersion keeps equal-version variants in API order ----
  await test('sortModelsByVersion is stable for equal versions', () => {
    const result = ids(sortModelsByVersion(models([
      'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna',
    ])));
    assert(
      result.join(',') === 'gpt-5.6-terra,gpt-5.6-sol,gpt-5.6-luna',
      `expected API order preserved, got ${result.join(',')}`
    );
  });

  return { passed, failed, errors };
}
