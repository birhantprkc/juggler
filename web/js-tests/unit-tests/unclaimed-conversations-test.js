//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Pins the leftover-conversation selector used when a test must make room
 * under MAX_CONVERSATIONS in the SHARED pool session: it must return only
 * conversations that no live lane claims in its `__ownConversationIds`.
 * Returning a claimed id here is the cross-lane bulldoze bug — one lane
 * permanently deletes a sibling's conversation mid-turn, the sibling's worker
 * is torn down under it, and the sibling times out with its doc frozen
 * (tool-action state=running, result=none).
 * @module unit-tests/unclaimed-conversations-test
 */

import { assert } from '../utilities/test-helpers.js';
import { unclaimedConversationIds } from '../utilities/conversation-claims.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  try {
    // Simulated pool: two lanes with claims, one lane whose harness hasn't
    // started, and a dead frame whose property access throws. Claims come
    // from another realm in production, so Set membership must be
    // duck-typed (forEach), never instanceof — the fake plain Sets here
    // exercise the same surface.
    const frames = [
      { __ownConversationIds: new Set(['conv_a', 'conv_b']) },
      {},
      { __ownConversationIds: new Set(['conv_c']) },
      { get __ownConversationIds() { throw new Error('detached frame'); } }
    ];
    const all = ['conv_a', 'conv_left1', 'conv_b', 'conv_c', 'conv_left2'];
    const got = unclaimedConversationIds(all, frames);
    assert(JSON.stringify(got) === JSON.stringify(['conv_left1', 'conv_left2']),
      `expected only the unclaimed leftovers in input order, got ${JSON.stringify(got)}`);

    // No frames expose claims at all → everything is a leftover.
    const none = unclaimedConversationIds(['conv_x', 'conv_y'], [{}, {}]);
    assert(JSON.stringify(none) === JSON.stringify(['conv_x', 'conv_y']),
      `with no claims everything is deletable, got ${JSON.stringify(none)}`);

    // Default frames path: a claim registered in THIS window must be
    // honoured. Stash and restore the live set — the harness uses it.
    const w = /** @type {any} */ (window);
    const saved = w.__ownConversationIds;
    w.__ownConversationIds = new Set(['conv_mine_unittest']);
    try {
      const viaDefault = unclaimedConversationIds(['conv_mine_unittest', 'conv_nobody_unittest']);
      assert(!viaDefault.includes('conv_mine_unittest'),
        `a conversation claimed by this lane must never be deletable, got ${JSON.stringify(viaDefault)}`);
      assert(viaDefault.includes('conv_nobody_unittest'),
        `an unclaimed conversation must be deletable, got ${JSON.stringify(viaDefault)}`);
    } finally {
      w.__ownConversationIds = saved;
    }

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return { passed, failed, errors };
}
