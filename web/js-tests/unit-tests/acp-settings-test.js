//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the ACP agents Settings tab's pure helpers: agent-name
 * validation, the form-state → AgentConfig builder, the whole-scope-map
 * producers for add / edit / delete / enable-toggle, the scope-of-a-listed-agent
 * lookup, and the status→dot-class mapping. The live round-trip (config write,
 * agent resolution, availability) is covered by the Go acp config/ops tests;
 * this pins the browser-side decision logic the tab depends on.
 * @module unit-tests/acp-settings-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  configFormToConfig as acpFormToConfig,
  upsertConfigEntry as acpUpsertMap,
  deleteConfigEntry as acpDeleteMap,
  setConfigEntryEnabled as acpSetEnabledMap,
  configScopeOf as acpScopeOf,
} from '../../js/components/config-tab.js';
import {
  validateAcpAgentName,
  acpDotClass,
} from '../../js/components/settings/subprocess-tabs.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label
   * @param {() => (void | Promise<void>)} fn - Test body
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

  // --- validateAcpAgentName -------------------------------------------------

  await run('name validation: accepts a normal name', () => {
    assert(validateAcpAgentName('gemini', []) === '', 'valid name rejected');
  });

  await run('name validation: rejects blank', () => {
    assert(validateAcpAgentName('   ', []) !== '', 'blank accepted');
  });

  await run('name validation: rejects whitespace', () => {
    assert(validateAcpAgentName('my agent', []) !== '', 'whitespace accepted');
  });

  await run('name validation: rejects slash (would break the model id)', () => {
    assert(validateAcpAgentName('a/b', []) !== '', 'slash accepted');
  });

  await run('name validation: does NOT reserve "juggler" (unlike MCP)', () => {
    assert(validateAcpAgentName('juggler', []) === '', 'agent names are model ids, not tool prefixes');
  });

  await run('name validation: enforces uniqueness within scope', () => {
    assert(validateAcpAgentName('gemini', ['gemini', 'zed']) !== '', 'duplicate accepted');
    assert(validateAcpAgentName('gemini', ['zed']) === '', 'non-duplicate rejected');
  });

  // --- acpFormToConfig ------------------------------------------------------

  await run('form→config: trims command, keeps args verbatim, omits empties', () => {
    const entry = acpFormToConfig({ command: '  gemini ', args: ['--experimental-acp', 'a b'], env: {}, enabled: true });
    assert(entry.command === 'gemini', 'command not trimmed');
    assert(Array.isArray(entry.args) && entry.args.length === 2, 'args count wrong');
    assert(entry.args[1] === 'a b', 'arg with space was split/altered');
    assert(!('env' in entry), 'empty env should be omitted');
    assert(entry.enabled === true, 'enabled not set');
  });

  await run('form→config: omits empty args, includes non-empty env', () => {
    const entry = acpFormToConfig({ command: 'run', args: [], env: { API_KEY: 'secret' }, enabled: false });
    assert(!('args' in entry), 'empty args should be omitted');
    assert(entry.env && entry.env.API_KEY === 'secret', 'env not preserved');
    assert(entry.enabled === false, 'enabled=false not coerced');
  });

  await run('form→config: drops blank env keys and filters blank args', () => {
    const entry = acpFormToConfig({ command: 'run', args: ['a', '', 'b'], env: { '': 'x', OK: 'y' } });
    assert(entry.args.length === 2 && entry.args[0] === 'a' && entry.args[1] === 'b', 'blank arg not filtered');
    assert(entry.env && !('' in entry.env) && entry.env.OK === 'y', 'blank env key not dropped');
    assert(entry.enabled === true, 'enabled should default true');
  });

  // --- whole-scope-map producers -------------------------------------------

  await run('upsert map: adds without touching siblings, clones', () => {
    const src = { zed: { command: 'zed' } };
    const out = acpUpsertMap(src, 'gemini', { command: 'gemini' });
    assert(out.zed && out.zed.command === 'zed', 'sibling lost on add');
    assert(out.gemini && out.gemini.command === 'gemini', 'new entry missing');
    assert(src.gemini === undefined, 'source mutated (not cloned)');
  });

  await run('upsert map: replaces an existing entry', () => {
    const out = acpUpsertMap({ gemini: { command: 'old' } }, 'gemini', { command: 'new' });
    assert(out.gemini.command === 'new', 'entry not replaced');
  });

  await run('delete map: removes one, keeps the rest, clones', () => {
    const src = { zed: { command: 'zed' }, gemini: { command: 'gemini' } };
    const out = acpDeleteMap(src, 'gemini');
    assert(!('gemini' in out), 'target not deleted');
    assert(out.zed && out.zed.command === 'zed', 'sibling lost on delete');
    assert('gemini' in src, 'source mutated (not cloned)');
  });

  await run('set-enabled map: flips flag, preserves other config, clones', () => {
    const src = { gemini: { command: 'gemini', args: ['--experimental-acp'], enabled: true } };
    const out = acpSetEnabledMap(src, 'gemini', false);
    assert(out.gemini.enabled === false, 'flag not applied');
    assert(out.gemini.command === 'gemini' && out.gemini.args[0] === '--experimental-acp', 'other config lost');
    assert(src.gemini.enabled === true, 'source mutated (not cloned)');
  });

  await run('set-enabled map: works for a name not yet in the map', () => {
    const out = acpSetEnabledMap({}, 'new', true);
    assert(out.new && out.new.enabled === true, 'missing-key case not handled');
  });

  // --- acpScopeOf -----------------------------------------------------------

  await run('scope-of: project overrides global', () => {
    assert(acpScopeOf({ global: { gemini: {} }, project: { gemini: {} } }, 'gemini') === 'project', 'project override not detected');
  });

  await run('scope-of: falls back to global', () => {
    assert(acpScopeOf({ global: { gemini: {} }, project: {} }, 'gemini') === 'global', 'global not detected');
  });

  await run('scope-of: unknown name defaults to global', () => {
    assert(acpScopeOf({ global: {}, project: {} }, 'nope') === 'global', 'unknown should default global');
  });

  // --- acpDotClass ----------------------------------------------------------

  await run('dot class: maps status to the shared MCP dot classes', () => {
    assert(acpDotClass('available') === 'running', 'available should be green (running)');
    assert(acpDotClass('unavailable') === 'failed', 'unavailable should be red (failed)');
    assert(acpDotClass('disabled') === 'stopped', 'disabled should be grey (stopped)');
    assert(acpDotClass('anything-else') === 'stopped', 'unknown should default to stopped');
  });

  return { passed, failed, errors };
}
