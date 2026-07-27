//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the MCP servers Settings tab's pure helpers: the token-cost
 * formatter, server-name validation, the form-state → ServerConfig builder, and
 * the whole-scope-map producers for add / edit / delete / enable-toggle plus the
 * scope-of-a-listed-server lookup. The live round-trip (config write, reconcile,
 * status) is covered by the Go MCP-manager tests; this pins the browser-side
 * decision logic the tab depends on.
 * @module unit-tests/mcp-settings-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  configFormToConfig as mcpFormToConfig,
  upsertConfigEntry as mcpUpsertMap,
  deleteConfigEntry as mcpDeleteMap,
  setConfigEntryEnabled as mcpSetEnabledMap,
  configScopeOf as mcpScopeOf,
  isRemoteTransport,
} from '../../js/components/config-tab.js';
import {
  formatMcpTokenCost,
  validateMcpServerName,
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

  // --- formatMcpTokenCost ---------------------------------------------------

  await run('token cost: pluralizes tools and shows k-tokens', () => {
    assert(formatMcpTokenCost({ toolCount: 3, schemaTokens: 1234 }) === '3 tools · ~1.2k tokens/request', 'multi-tool format wrong');
  });

  await run('token cost: singular tool', () => {
    assert(formatMcpTokenCost({ toolCount: 1, schemaTokens: 400 }) === '1 tool · ~400 tokens/request', 'singular format wrong');
  });

  await run('token cost: drops the token clause when zero', () => {
    assert(formatMcpTokenCost({ toolCount: 0, schemaTokens: 0 }) === '0 tools', 'zero-token clause not dropped');
  });

  await run('token cost: tolerates missing fields', () => {
    assert(formatMcpTokenCost({}) === '0 tools', 'empty status not handled');
  });

  // --- validateMcpServerName ------------------------------------------------

  await run('name validation: accepts a normal name', () => {
    assert(validateMcpServerName('github', []) === '', 'valid name rejected');
  });

  await run('name validation: rejects blank', () => {
    assert(validateMcpServerName('   ', []) !== '', 'blank accepted');
  });

  await run('name validation: rejects whitespace', () => {
    assert(validateMcpServerName('my server', []) !== '', 'whitespace accepted');
  });

  await run('name validation: rejects slash', () => {
    assert(validateMcpServerName('a/b', []) !== '', 'slash accepted');
  });

  await run('name validation: rejects the reserved "juggler"', () => {
    assert(validateMcpServerName('juggler', []) !== '', 'reserved name accepted');
  });

  await run('name validation: enforces uniqueness within scope', () => {
    assert(validateMcpServerName('github', ['github', 'fs']) !== '', 'duplicate accepted');
    assert(validateMcpServerName('github', ['fs']) === '', 'non-duplicate rejected');
  });

  // --- mcpFormToConfig ------------------------------------------------------

  await run('form→config: trims command, keeps args verbatim, omits empties', () => {
    const entry = mcpFormToConfig({ command: '  npx ', args: ['-y', 'pkg with space'], env: {}, enabled: true });
    assert(entry.command === 'npx', 'command not trimmed');
    assert(Array.isArray(entry.args) && entry.args.length === 2, 'args count wrong');
    assert(entry.args[1] === 'pkg with space', 'arg with space was split/altered');
    assert(!('env' in entry), 'empty env should be omitted');
    assert(entry.enabled === true, 'enabled not set');
  });

  await run('form→config: omits empty args, includes non-empty env', () => {
    const entry = mcpFormToConfig({ command: 'run', args: [], env: { TOKEN: 'secret' }, enabled: false });
    assert(!('args' in entry), 'empty args should be omitted');
    assert(entry.env && entry.env.TOKEN === 'secret', 'env not preserved');
    assert(entry.enabled === false, 'enabled=false not coerced');
  });

  await run('form→config: drops blank env keys and filters blank args', () => {
    const entry = mcpFormToConfig({ command: 'run', args: ['a', '', 'b'], env: { '': 'x', OK: 'y' } });
    assert(entry.args.length === 2 && entry.args[0] === 'a' && entry.args[1] === 'b', 'blank arg not filtered');
    assert(entry.env && !('' in entry.env) && entry.env.OK === 'y', 'blank env key not dropped');
    assert(entry.enabled === true, 'enabled should default true');
  });

  await run('form→config: stdio omits transport/url/headers', () => {
    const entry = mcpFormToConfig({ command: 'run', enabled: true });
    assert(!('transport' in entry), 'stdio should not carry transport');
    assert(!('url' in entry), 'stdio should not carry url');
    assert(!('headers' in entry), 'stdio should not carry headers');
  });

  // --- isRemoteTransport ----------------------------------------------------

  await run('isRemoteTransport: http/streamable/sse are remote, stdio is not', () => {
    assert(isRemoteTransport('http'), 'http should be remote');
    assert(isRemoteTransport('streamable'), 'streamable should be remote');
    assert(isRemoteTransport('sse'), 'sse should be remote');
    assert(!isRemoteTransport('stdio'), 'stdio should not be remote');
    assert(!isRemoteTransport(undefined), 'undefined should not be remote');
  });

  // --- mcpFormToConfig (remote transports) ----------------------------------

  await run('form→config: http entry carries transport + url, omits command/args/env', () => {
    const entry = mcpFormToConfig({
      transport: 'http', url: '  https://scite.ai/mcp  ',
      command: 'ignored', args: ['x'], env: { A: 'b' }, enabled: true,
    });
    assert(entry.transport === 'http', 'transport not set');
    assert(entry.url === 'https://scite.ai/mcp', 'url not trimmed/set');
    assert(!('command' in entry), 'remote entry should not carry command');
    assert(!('args' in entry), 'remote entry should not carry args');
    assert(!('env' in entry), 'remote entry should not carry env');
    assert(entry.enabled === true, 'enabled not set');
  });

  await run('form→config: remote keeps non-blank headers, drops blank keys', () => {
    const entry = mcpFormToConfig({
      transport: 'sse', url: 'https://x/mcp',
      headers: { Authorization: 'Bearer t', '': 'skip' },
    });
    assert(entry.transport === 'sse', 'sse transport not set');
    assert(entry.headers && entry.headers.Authorization === 'Bearer t', 'header not preserved');
    assert(!('' in entry.headers), 'blank header key not dropped');
  });

  await run('form→config: remote omits empty headers and blank url', () => {
    const entry = mcpFormToConfig({ transport: 'http', url: '   ', headers: {} });
    assert(entry.transport === 'http', 'transport not set');
    assert(!('url' in entry), 'blank url should be omitted');
    assert(!('headers' in entry), 'empty headers should be omitted');
  });

  // --- whole-scope-map producers -------------------------------------------

  await run('upsert map: adds without touching siblings', () => {
    const src = { fs: { command: 'fs-server' } };
    const out = mcpUpsertMap(src, 'github', { command: 'gh' });
    assert(out.fs && out.fs.command === 'fs-server', 'sibling lost on add');
    assert(out.github && out.github.command === 'gh', 'new entry missing');
    assert(src.github === undefined, 'source mutated (not cloned)');
  });

  await run('upsert map: replaces an existing entry', () => {
    const src = { github: { command: 'old' } };
    const out = mcpUpsertMap(src, 'github', { command: 'new' });
    assert(out.github.command === 'new', 'entry not replaced');
  });

  await run('delete map: removes one, keeps the rest, clones', () => {
    const src = { fs: { command: 'fs' }, github: { command: 'gh' } };
    const out = mcpDeleteMap(src, 'github');
    assert(!('github' in out), 'target not deleted');
    assert(out.fs && out.fs.command === 'fs', 'sibling lost on delete');
    assert('github' in src, 'source mutated (not cloned)');
  });

  await run('set-enabled map: flips flag, preserves other config, clones', () => {
    const src = { github: { command: 'gh', args: ['-y'], enabled: true } };
    const out = mcpSetEnabledMap(src, 'github', false);
    assert(out.github.enabled === false, 'flag not applied');
    assert(out.github.command === 'gh' && out.github.args[0] === '-y', 'other config lost');
    assert(src.github.enabled === true, 'source mutated (not cloned)');
  });

  await run('set-enabled map: works for a name not yet in the map', () => {
    const out = mcpSetEnabledMap({}, 'new', true);
    assert(out.new && out.new.enabled === true, 'missing-key case not handled');
  });

  // --- mcpScopeOf -----------------------------------------------------------

  await run('scope-of: project overrides global', () => {
    const cfg = { global: { github: {} }, project: { github: {} } };
    assert(mcpScopeOf(cfg, 'github') === 'project', 'project override not detected');
  });

  await run('scope-of: falls back to global', () => {
    const cfg = { global: { github: {} }, project: {} };
    assert(mcpScopeOf(cfg, 'github') === 'global', 'global not detected');
  });

  await run('scope-of: unknown name defaults to global', () => {
    assert(mcpScopeOf({ global: {}, project: {} }, 'nope') === 'global', 'unknown should default global');
  });

  return { passed, failed, errors };
}
