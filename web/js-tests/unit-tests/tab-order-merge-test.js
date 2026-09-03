//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Applying a reorder that arrives from the server.
 *
 * Order is persisted by posting the whole tab list and is echoed back to every
 * viewer including the one that sent it, so an echo in flight describes the bar
 * as it was when the post left. A tab created in that window is named by
 * neither, and the arriving order is not entitled to an opinion about it: it
 * says where the tabs it names go, and nothing about the rest. Treating it as
 * the complete truth is what drops a newly created tab to the bottom of the bar.
 *
 * The session is built from the prototype with a map of markers: what is under
 * test is the ordering rule, and real conversations would bring a worker and a
 * server round trip to it without making any assertion sharper.
 * @module unit-tests/tab-order-merge
 */

import { assert } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';

/**
 * A session holding nothing but ids, with notifications stubbed out.
 * @param {string[]} ids - Conversation ids, in bar order
 * @returns {any} A session whose conversations map holds one marker per id
 */
function sessionWithOrder(ids) {
  const session = Object.create(Session.prototype);
  session.conversations = new Map(ids.map((id) => [id, { id }]));
  session._notify = () => {};
  return session;
}

/**
 * @param {any} session - Session to read
 * @returns {string} Its bar order, for assertion messages
 */
function orderOf(session) {
  return Array.from(session.conversations.keys()).join(',');
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all tab-order merge tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} what - Name of the case
   * @param {string[]} local - Local bar order
   * @param {string[]} echo - Order arriving from the server
   * @param {string} expected - Expected resulting order
   */
  const check = (what, local, echo, expected) => {
    try {
      const session = sessionWithOrder(local);
      session.applyConversationsReordered(echo);
      const got = orderOf(session);
      assert(got === expected, `expected ${expected}, got ${got}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // The reported bug: a tab created while a reorder was in flight is named by
  // neither the local snapshot that was posted nor the echo that comes back.
  check('a tab the echo never saw keeps its place',
    ['X', 'A', 'B', 'C'], ['A', 'B', 'C'], 'X,A,B,C');

  // A full order still replaces the lot — this is the drag-reorder path, and it
  // must keep working exactly as before.
  check('a full order is applied whole',
    ['A', 'B', 'C'], ['C', 'A', 'B'], 'C,A,B');

  // A partial order re-slots only the ids it names, leaving the others where
  // they are: A and C hold slots 1 and 3, so they swap and B does not move.
  check('a partial order re-slots only what it names',
    ['X', 'A', 'B', 'C'], ['C', 'A'], 'X,C,B,A');

  // Ids the server names but this realm does not hold are not conjured into the
  // bar — they arrive with their own created/restored event.
  check('an unheld id is ignored',
    ['A', 'B'], ['B', 'ghost', 'A'], 'B,A');

  return { passed, failed, errors };
}
