//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tool-name resolution unit tests.
 *
 * `resolveToolName` is the single point at which the frontend turns a raw
 * tool-call name (as received from any provider) into the canonical Juggler
 * tool key used by the registry. It must:
 *
 *   1. Strip the `mcp__juggler__` prefix the Claude CLI adds to MCP tools,
 *      in case a tool_use block reached us without the provider-side strip
 *      having run (history replay, a non-streaming path, a malformed event).
 *   2. Map capitalised native names (Bash, Read, BatchGrep, …) to their
 *      lowercase Juggler equivalents.
 *   3. Compose those two: a prefixed-and-capitalised name like
 *      `mcp__juggler__BatchGrep` must canonicalise all the way to
 *      `batch_grep`.
 *   4. Be a no-op on names that are already canonical.
 *
 * It also pins the registry lookup that depends on all of the above: a
 * tool-action stores the tool name it ran under, so every stored name a tool
 * has been advertised under must still resolve to that tool's class.
 * @module unit-tests/tool-name-resolution-test
 */

import { assert, initializeRegistries } from '../utilities/test-helpers.js';
import { resolveToolName } from '../../js/services/tool-generator.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

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
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  run('strips mcp__juggler__ prefix from a registered tool', () => {
    assert(resolveToolName('mcp__juggler__batch_grep') === 'batch_grep',
      `expected batch_grep, got ${resolveToolName('mcp__juggler__batch_grep')}`);
  });

  run('strips mcp__juggler__ prefix when name is also a capitalized alias', () => {
    // Pre-strip the name would alias-lookup miss; post-strip it must hit.
    assert(resolveToolName('mcp__juggler__bash') === 'bash',
      `expected bash, got ${resolveToolName('mcp__juggler__bash')}`);
  });

  run('strips prefix AND applies capitalised alias', () => {
    // `BatchGrep` aliases to `batch_grep`; prefix must come off first.
    assert(resolveToolName('mcp__juggler__BatchGrep') === 'batch_grep',
      `expected batch_grep, got ${resolveToolName('mcp__juggler__BatchGrep')}`);
  });

  run('strips prefix AND applies Read→read alias', () => {
    assert(resolveToolName('mcp__juggler__Read') === 'read',
      `expected read, got ${resolveToolName('mcp__juggler__Read')}`);
  });

  run('idempotent on already-canonical names', () => {
    assert(resolveToolName('batch_grep') === 'batch_grep',
      `expected batch_grep, got ${resolveToolName('batch_grep')}`);
    assert(resolveToolName('bash') === 'bash',
      `expected bash, got ${resolveToolName('bash')}`);
  });

  run('idempotent on unknown unprefixed names (passes through unchanged)', () => {
    assert(resolveToolName('some_unknown_tool') === 'some_unknown_tool',
      `expected pass-through, got ${resolveToolName('some_unknown_tool')}`);
  });

  run('leaves bare server name `mcp__juggler` alone (not our tool)', () => {
    // `mcp__juggler` (no trailing __ + name) is not a valid CLI emission
    // — but if it ever shows up, we must NOT silently truncate it to ''
    // and then look up the empty string.
    assert(resolveToolName('mcp__juggler') === 'mcp__juggler',
      `expected pass-through, got ${resolveToolName('mcp__juggler')}`);
  });

  run('handles a doubly-prefixed name safely', () => {
    // If a past bug ever advertised tools pre-prefixed, the CLI would
    // add its own prefix on top. Strip both so the registry lookup wins
    // rather than reporting "Unknown tool" for `mcp__juggler__bash`.
    assert(resolveToolName('mcp__juggler__mcp__juggler__bash') === 'bash',
      `expected bash, got ${resolveToolName('mcp__juggler__mcp__juggler__bash')}`);
  });

  // The registry lookup is the load-bearing half of the alias map. Roughly a
  // dozen render sites call getByToolName with the toolName read straight off a
  // stored tool-action, never passing it through resolveToolName first. A stored
  // name is whatever the tool was advertised as when the action ran, so unless
  // the registry resolves aliases itself, reopening a conversation strands every
  // one of those tiles without a renderer — no icon, no type name, no details.
  // Deliberately asserted through getByToolName rather than resolveToolName: it
  // is the lookup, not the mapping, that the render sites depend on.
  await initializeRegistries();

  run('a superseded tool name resolves to the same class as the current one', () => {
    const current = contextItemRegistry.getByToolName('query_code');
    assert(current !== undefined, 'query_code must be registered');
    assert(contextItemRegistry.getByToolName('explore_code') === current,
      'a tool-action stored as explore_code must still resolve to the query_code item');
    assert(contextItemRegistry.getByToolName('ExploreCode') === current,
      'the capitalised form must resolve to the same item');
  });

  run('an unknown tool name still resolves to nothing', () => {
    // The alias fallback must stay additive: it may rescue a superseded name,
    // never invent a class for a name no plugin claims.
    assert(contextItemRegistry.getByToolName('no_such_tool_at_all') === undefined,
      'an unclaimed tool name must not resolve');
  });

  return { passed, failed, errors };
}
