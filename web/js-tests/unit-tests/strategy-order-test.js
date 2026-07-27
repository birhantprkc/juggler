//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy display-order tests.
 *
 * `orderStrategies` is a pure sort by `manifest.order` ascending with a
 * stable load-order tiebreak — the framework has no knowledge of any specific
 * strategy id, built-in or otherwise. These tests pin that contract directly
 * against the pure function so they do not depend on which strategies happen
 * to be registered in the test build.
 * @module unit-tests/strategy-order-test
 */

import { assert } from '../utilities/test-helpers.js';
import { orderStrategies } from '../../js/registries/strategy-order.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * Build a minimal manifest entry shaped like the registry's output — only the
 * fields `orderStrategies` reads (`id` + `manifest.order`) are populated.
 * @param {string} id
 * @param {number} [order]
 * @returns {{id: string, manifest: {order?: number}}} A minimal manifest entry shaped like the registry's output.
 */
function entry(id, order) {
  return order === undefined ? { id, manifest: {} } : { id, manifest: { order } };
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
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

  await run('sorts by manifest.order ascending', () => {
    // Load order deliberately scrambled relative to the declared order.
    const input = [
      entry('yolo', 3),
      entry('default', 0),
      entry('read-only', 2),
      entry('auto-approve', 1),
    ];
    const ids = orderStrategies(input).map(m => m.id);
    assert(JSON.stringify(ids) === JSON.stringify(['default', 'auto-approve', 'read-only', 'yolo']),
      `expected order asc, got ${JSON.stringify(ids)}`);
  });

  await run('a strategy without `order` sorts after any with an `order`', () => {
    const input = [
      entry('research', 5),
      entry('notes'), // no order → +Infinity → after `research`
    ];
    const ids = orderStrategies(input).map(m => m.id);
    assert(JSON.stringify(ids) === JSON.stringify(['research', 'notes']),
      `expected [research,notes], got ${JSON.stringify(ids)}`);
  });

  await run('equal `order` preserves load order', () => {
    // Same numeric order on both — load order must win.
    const input = [
      entry('beta', 10),
      entry('alpha', 10),
    ];
    const ids = orderStrategies(input).map(m => m.id);
    assert(JSON.stringify(ids) === JSON.stringify(['beta', 'alpha']),
      `expected load order [beta,alpha] for equal orders, got ${JSON.stringify(ids)}`);
  });

  await run('no `order` on any strategy preserves load order entirely', () => {
    const input = [
      entry('default'),
      entry('alpha'),
      entry('beta'),
    ];
    const ids = orderStrategies(input).map(m => m.id);
    assert(JSON.stringify(ids) === JSON.stringify(['default', 'alpha', 'beta']),
      `expected load order unchanged, got ${JSON.stringify(ids)}`);
  });

  await run('negative order sorts before zero', () => {
    const input = [
      entry('default', 0),
      entry('eager', -1),
    ];
    const ids = orderStrategies(input).map(m => m.id);
    assert(JSON.stringify(ids) === JSON.stringify(['eager', 'default']),
      `expected [eager,default], got ${JSON.stringify(ids)}`);
  });

  await run('3rd-party and built-in strategies use the same field symmetrically', () => {
    // No id is privileged: a 3rd-party 'sneaky' with a lower order sorts first,
    // exactly like any builtin would.
    const input = [
      entry('default', 0),
      entry('sneaky', -5),
      entry('yolo', 3),
    ];
    const ids = orderStrategies(input).map(m => m.id);
    assert(JSON.stringify(ids) === JSON.stringify(['sneaky', 'default', 'yolo']),
      `expected [sneaky,default,yolo], got ${JSON.stringify(ids)}`);
  });

  await run('non-numeric manifest.order is treated as absent', () => {
    const input = [
      entry('bad', /** @type {any} */ ('first')),
      entry('good', 3),
    ];
    const ids = orderStrategies(input).map(m => m.id);
    // 'good' has a numeric order and sorts before 'bad' (treated as +Infinity).
    assert(JSON.stringify(ids) === JSON.stringify(['good', 'bad']),
      `expected [good,bad], got ${JSON.stringify(ids)}`);
  });

  await run('empty input yields an empty result and does not throw', () => {
    assert(orderStrategies([]).length === 0, 'empty input should produce empty output');
  });

  await run('orderStrategies returns a new array and does not mutate input', () => {
    const input = [entry('yolo', 3), entry('default', 0)];
    const snapshot = input.map(m => m.id);
    orderStrategies(input);
    assert(JSON.stringify(input.map(m => m.id)) === JSON.stringify(snapshot),
      'input array order must be unchanged');
  });

  return { passed, failed, errors };
}
