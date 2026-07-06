//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for `stripSurroundingQuotes`, the paste-time path normaliser used by
 * <path-input>. A path copied from macOS Finder (or many other apps) arrives
 * wrapped in quotes; the project picker must drop the wrapping quotes so the
 * bare path lands in the field. Interior quotes and unquoted paths must survive
 * untouched (beyond whitespace trimming).
 * @module unit-tests/path-input-quotes-test
 */

import { stripSurroundingQuotes } from '../../js/components/path-input.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run path-input quote-stripping tests.
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

  /**
   * @param {string} input
   * @param {string} expected
   */
  function expect(input, expected) {
    const got = stripSurroundingQuotes(input);
    assert(got === expected, `stripSurroundingQuotes(${JSON.stringify(input)}) === ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
  }

  test('strips straight double quotes', () => {
    expect('"/Users/jules/code/juggler"', '/Users/jules/code/juggler');
  });

  test('strips straight single quotes', () => {
    expect("'/Users/jules/My Project'", '/Users/jules/My Project');
  });

  test('strips curly double quotes', () => {
    expect('\u201c/Users/jules/code\u201d', '/Users/jules/code');
  });

  test('strips curly single quotes', () => {
    expect('\u2018/Users/jules/code\u2019', '/Users/jules/code');
  });

  test('trims whitespace outside the quotes', () => {
    expect('  "/Users/jules/code"  ', '/Users/jules/code');
  });

  test('trims whitespace inside the quotes', () => {
    expect('" /Users/jules/code "', '/Users/jules/code');
  });

  test('leaves an unquoted path untouched (just trimmed)', () => {
    expect('  /Users/jules/code  ', '/Users/jules/code');
  });

  test('preserves quotes inside the path', () => {
    expect('/Users/jules/a"b/c', '/Users/jules/a"b/c');
  });

  test('does not strip a leading-only quote', () => {
    expect('"/Users/jules/code', '"/Users/jules/code');
  });

  test('does not strip mismatched quote kinds', () => {
    expect('\u201c/Users/jules/code"', '\u201c/Users/jules/code"');
  });

  test('handles an empty string', () => {
    expect('', '');
  });

  test('does not strip a lone quote character', () => {
    expect('"', '"');
  });

  test('strips only one wrapping layer', () => {
    expect('""/Users/jules/code""', '"/Users/jules/code"');
  });

  return { passed, failed, errors };
}
