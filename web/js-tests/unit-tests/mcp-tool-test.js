//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the MCP tool bridge's pure decision logic: LLM tool naming,
 * read/write category mapping from the read-only annotation, description
 * fallback/truncation, the escalating approval-suggestion ladder, and the
 * rule-matching that auto-approves calls. The live stdio round-trip (discovery,
 * tools/call, crash/restart) is covered by the Go manager tests.
 * @module unit-tests/mcp-tool-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  mcpLLMName,
  buildToolDefinition,
  mcpRuleValues,
  mcpApprovalSuggestions,
  mcpIsPermitted
} from '../../extensions/juggler-mcp/context-items/mcp-tool-context-item.js';

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

  /**
   * @param {boolean} ro - Read-only flag
   * @returns {import('../../extensions/juggler-mcp/context-items/mcp-tool-context-item.js').McpToolInfo} A discovered-tool fixture
   */
  const tool = (ro) => ({
    server: 'github', name: 'create_issue', title: 'Create Issue',
    description: 'Create a GitHub issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    readOnly: ro, destructive: !ro, schemaTokens: 10
  });

  await run('llm name is mcp__server__tool', () => {
    assert(mcpLLMName('github', 'create_issue') === 'mcp__github__create_issue', 'unexpected name');
  });

  await run('read-only tool maps to read category', () => {
    const def = buildToolDefinition(tool(true));
    assert(def.category === 'read', `want read, got ${def.category}`);
    assert(def.name === 'mcp__github__create_issue', 'name mismatch');
    assert(def.input_schema.type === 'object', 'schema not passed through');
  });

  await run('mutating tool maps to write category (destructive-by-default)', () => {
    assert(buildToolDefinition(tool(false)).category === 'write', 'want write');
  });

  await run('missing schema defaults to an object schema', () => {
    const def = buildToolDefinition({ server: 's', name: 't', title: '', description: 'd', inputSchema: null, readOnly: false, destructive: true, schemaTokens: 0 });
    assert(def.input_schema && def.input_schema.type === 'object', 'no default schema');
  });

  await run('empty description falls back to a synthesized one', () => {
    const def = buildToolDefinition({ server: 's', name: 't', title: 'T', description: '', inputSchema: {}, readOnly: false, destructive: true, schemaTokens: 0 });
    assert(def.description.includes('via MCP server "s"'), `weak fallback: ${def.description}`);
  });

  await run('overlong description is truncated with an ellipsis', () => {
    const def = buildToolDefinition({ server: 's', name: 't', title: 'T', description: 'x'.repeat(5000), inputSchema: {}, readOnly: false, destructive: true, schemaTokens: 0 });
    assert(def.description.endsWith('…'), 'not truncated');
    assert(def.description.length <= 1100, `too long: ${def.description.length}`);
  });

  await run('approval ladder: read-only tool offers exact → readonly → server', () => {
    const s = mcpApprovalSuggestions({ server: 'github', tool: 'get_issue', readOnly: true });
    assert(s.length === 3, `want 3 tiers, got ${s.length}`);
    assert(s.every((x) => x.itemType === 'mcp-tool'), 'wrong itemType');
    const values = s.map((x) => x.rules[0].value);
    assert(values[0] === 'github/get_issue', 'exact tier wrong');
    assert(values.includes('github/#readonly'), 'missing readonly tier');
    assert(values.includes('github/*'), 'missing server-wide tier');
  });

  await run('approval ladder: mutating tool omits the readonly tier', () => {
    const s = mcpApprovalSuggestions({ server: 'github', tool: 'create_issue', readOnly: false });
    assert(s.length === 2, `want 2 tiers, got ${s.length}`);
    const values = s.map((x) => x.rules[0].value);
    assert(!values.includes('github/#readonly'), 'readonly tier should be absent');
  });

  await run('each suggestion, once applied, makes isPermitted true (the contract)', () => {
    const target = { server: 'github', tool: 'get_issue', readOnly: true };
    for (const s of mcpApprovalSuggestions(target)) {
      const values = new Set(s.rules.map((r) => String(r.value)));
      assert(mcpIsPermitted(values, target), `suggestion ${[...values]} did not permit the call`);
    }
  });

  await run('isPermitted: exact and server-wide grants approve; readonly gated by annotation', () => {
    const rv = mcpRuleValues('github', 'create_issue');
    assert(mcpIsPermitted(new Set([rv.exact]), { server: 'github', tool: 'create_issue', readOnly: false }), 'exact should approve');
    assert(mcpIsPermitted(new Set([rv.all]), { server: 'github', tool: 'create_issue', readOnly: false }), 'server-wide should approve');
    // #readonly grant must NOT approve a non-read-only tool.
    assert(!mcpIsPermitted(new Set([rv.readonly]), { server: 'github', tool: 'create_issue', readOnly: false }), 'readonly grant leaked to a mutating tool');
    // ...but does approve a read-only one.
    assert(mcpIsPermitted(new Set([rv.readonly]), { server: 'github', tool: 'create_issue', readOnly: true }), 'readonly grant should approve a read-only tool');
    // Empty grants never approve.
    assert(!mcpIsPermitted(new Set(), { server: 'github', tool: 'create_issue', readOnly: true }), 'empty set should not approve');
    // A grant for a different server must not approve.
    assert(!mcpIsPermitted(new Set(['other/*']), { server: 'github', tool: 'create_issue', readOnly: false }), 'cross-server leak');
  });

  return { passed, failed, errors };
}
