//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Derived conversation names — /duplicate's "<source> (copy)" and /handoff's
 * "<source> (continued)".
 *
 * The invariant these pin: the suffix is the only thing telling the derived tab
 * apart from its source, so it must always survive. A source name at (or near)
 * MAX_CONVERSATION_NAME_LENGTH cannot be allowed to push the suffix past the
 * cap, because the server truncates from the END when it writes the folder
 * (core.SanitizedNameMaxRunes) — "Long name (continued)" would land on disk as
 * "Long name (contin", and after a reload the continuation is indistinguishable
 * from its source. uniqueSuffixedName clips the BASE instead.
 * @module unit-tests/conversation-naming-test
 */

import { uniqueSuffixedName } from '../../js/model/conversation-naming.js';
import { MAX_CONVERSATION_NAME_LENGTH } from '../../js/utils/constants.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Collision predicate for a session holding no other conversations, so the
 * first candidate always wins.
 * @returns {boolean} Always false.
 */
const nothingTaken = () => false;

/**
 * @param {string[]} names - Names already in use
 * @returns {(name: string) => boolean} Predicate over that set.
 */
function taken(names) {
  const set = new Set(names);
  return (name) => set.has(name);
}

/**
 * Run derived-name tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => Promise<void>|void} fn - Test body
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

  // ---- the plain cases ----
  await test('short name takes the bare suffix', () => {
    assert(uniqueSuffixedName('Fix login', 'copy', nothingTaken) === 'Fix login (copy)',
      'expected "Fix login (copy)"');
    assert(uniqueSuffixedName('Fix login', 'continued', nothingTaken) === 'Fix login (continued)',
      'expected "Fix login (continued)"');
  });

  await test('re-deriving does not stack suffixes', () => {
    assert(uniqueSuffixedName('Fix login (copy)', 'copy', nothingTaken) === 'Fix login (copy)',
      'existing "(copy)" tail should be replaced, not stacked');
    assert(uniqueSuffixedName('Fix login (copy 3)', 'copy', nothingTaken) === 'Fix login (copy)',
      'existing "(copy N)" tail should be replaced, not stacked');
  });

  await test('collisions bump the counter', () => {
    const isTaken = taken(['Fix login (copy)', 'Fix login (copy 2)']);
    assert(uniqueSuffixedName('Fix login', 'copy', isTaken) === 'Fix login (copy 3)',
      'expected the first free counter, "Fix login (copy 3)"');
  });

  // ---- the cap: base gets clipped, suffix stays whole ----
  await test('long source name is clipped so the suffix fits', () => {
    // A source name exactly at the cap: every character of the suffix has to
    // come out of the base.
    const source = 'A'.repeat(MAX_CONVERSATION_NAME_LENGTH);
    const derived = uniqueSuffixedName(source, 'continued', nothingTaken);
    assert(derived.length <= MAX_CONVERSATION_NAME_LENGTH,
      `derived name ${derived.length} chars, cap is ${MAX_CONVERSATION_NAME_LENGTH}: "${derived}"`);
    assert(derived.endsWith(' (continued)'), `suffix must survive intact, got "${derived}"`);
    assert(derived.startsWith('AAA'), `base must be kept as a prefix, got "${derived}"`);
  });

  await test('counter variants stay within the cap too', () => {
    const source = 'B'.repeat(MAX_CONVERSATION_NAME_LENGTH);
    const first = uniqueSuffixedName(source, 'copy', nothingTaken);
    const isTaken = taken([first]);
    const second = uniqueSuffixedName(source, 'copy', isTaken);
    assert(second.length <= MAX_CONVERSATION_NAME_LENGTH,
      `counter variant ${second.length} chars, cap is ${MAX_CONVERSATION_NAME_LENGTH}: "${second}"`);
    assert(second.endsWith(' (copy 2)'), `expected a "(copy 2)" tail, got "${second}"`);
    assert(second !== first, 'counter variant must differ from the first candidate');
  });

  await test('clipping does not leave a dangling space before the suffix', () => {
    // Size the base so the clip lands exactly on a space: "…words  (copy)" would
    // round-trip differently through the server, which collapses and trims
    // whitespace, giving a name we never asked for.
    const room = MAX_CONVERSATION_NAME_LENGTH - ' (copy)'.length;
    const head = 'C'.repeat(room - 1);
    const derived = uniqueSuffixedName(`${head} tail words`, 'copy', nothingTaken);
    assert(derived === `${head} (copy)`, `expected "${head} (copy)", got "${derived}"`);
  });

  await test('surrogate pairs are not split by the clip', () => {
    // Emoji are two UTF-16 units each; clipping mid-pair would leave a lone
    // high surrogate that renders as a replacement character.
    const source = '🙂'.repeat(MAX_CONVERSATION_NAME_LENGTH / 2);
    const derived = uniqueSuffixedName(source, 'copy', nothingTaken);
    assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(derived),
      `lone high surrogate in "${derived}"`);
    assert(derived.endsWith(' (copy)'), `suffix must survive intact, got "${derived}"`);
    assert(derived.length <= MAX_CONVERSATION_NAME_LENGTH, `over the cap: "${derived}"`);
  });

  await test('empty source yields the bare suffix', () => {
    assert(uniqueSuffixedName('', 'copy', nothingTaken) === '(copy)',
      'expected a bare "(copy)" with no leading space');
  });

  return { passed, failed, errors };
}
