//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the transaction panel's tool list — the record of which tools
 * a round-trip actually offered the model.
 *
 * This is the surface that answers "was my MCP server's tool even in the
 * request?", which is otherwise unanswerable: a tool absent from this list never
 * reached the model, whatever the model then said about it. The list is built
 * from the persisted blob, so it is ground truth rather than a reconstruction —
 * these tests pin the grouping (built-ins together, one group per MCP server),
 * the ordering (servers alphabetical, expensive schemas first within a group),
 * and that every tool in the blob reaches the DOM.
 * @module unit-tests/transaction-tool-list-test
 */

import { assert } from '../utilities/test-helpers.js';
import { renderTransactionDetail } from '../../js/components/transaction-detail-renderer.js';
import { parseMcpToolName, groupToolsByOrigin } from '../../js/services/thread-tool-inventory.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * One tool definition in the shape the worker records (worker/messages.go
 * ToolDefinition): name, description, input_schema, optional category.
 * @param {string} name - LLM-facing tool name
 * @param {number} [schemaProps] - How many properties to give the schema, to vary its token cost
 * @param {string} [category] - 'read' | 'write' | 'meta'
 * @returns {Record<string, unknown>} Tool entry
 */
function tool(name, schemaProps = 1, category = 'read') {
  /** @type {Record<string, unknown>} */
  const properties = {};
  for (let i = 0; i < schemaProps; i++) {
    properties[`field_${i}`] = { type: 'string', description: 'x'.repeat(40) };
  }
  return {
    name,
    description: `Description of ${name}.\nSecond line that must not reach the label.`,
    input_schema: { type: 'object', properties },
    category,
  };
}

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

  // =========================================================================
  // Name parsing — the grouping keys off this, so a mis-parse silently files
  // an MCP tool under the built-ins.
  // =========================================================================
  await run('parseMcpToolName splits server from tool', () => {
    const parts = parseMcpToolName('mcp__linear__create_issue');
    assert(parts?.server === 'linear', `server was ${JSON.stringify(parts?.server)}`);
    assert(parts?.tool === 'create_issue', `tool was ${JSON.stringify(parts?.tool)}`);
  });

  await run('parseMcpToolName keeps underscores inside a tool name', () => {
    const parts = parseMcpToolName('mcp__linear__list__issues');
    assert(parts?.server === 'linear', `server was ${JSON.stringify(parts?.server)}`);
    assert(parts?.tool === 'list__issues', `tool was ${JSON.stringify(parts?.tool)}`);
  });

  await run('parseMcpToolName rejects anything that is not an MCP tool', () => {
    for (const name of ['bash', 'mcp__', 'mcp__server__', 'mcp__server', 'read_file', '']) {
      assert(parseMcpToolName(name) === null, `expected null for ${JSON.stringify(name)}`);
    }
  });

  // =========================================================================
  // Grouping and ordering.
  // =========================================================================
  await run('built-ins group first, then MCP servers alphabetically', () => {
    const groups = groupToolsByOrigin([
      tool('mcp__zulip__send'),
      tool('bash'),
      tool('mcp__linear__create_issue'),
      tool('read'),
    ]);
    const titles = groups.map((g) => g.title);
    assert(
      JSON.stringify(titles) === JSON.stringify(['Juggler tools', 'MCP · linear', 'MCP · zulip']),
      `groups were ${JSON.stringify(titles)}`
    );
  });

  await run('a request with no built-in tools still groups its servers', () => {
    const groups = groupToolsByOrigin([tool('mcp__linear__create_issue')]);
    assert(groups.length === 1, `expected one group, got ${groups.length}`);
    assert(groups[0].title === 'MCP · linear', `title was ${groups[0].title}`);
    assert(groups[0].server === 'linear', `server was ${JSON.stringify(groups[0].server)}`);
  });

  await run('the most expensive schema sorts first within its group', () => {
    const groups = groupToolsByOrigin([
      tool('mcp__linear__small', 1),
      tool('mcp__linear__huge', 12),
      tool('mcp__linear__medium', 5),
    ]);
    const names = groups[0].tools.map((t) => t.name);
    assert(
      JSON.stringify(names) === JSON.stringify(['mcp__linear__huge', 'mcp__linear__medium', 'mcp__linear__small']),
      `order was ${JSON.stringify(names)}`
    );
  });

  await run('a group reports the total cost of its tools', () => {
    const groups = groupToolsByOrigin([tool('mcp__linear__a', 3), tool('mcp__linear__b', 3)]);
    const [g] = groups;
    assert(g.tokens > 0, 'group token total should be positive');
    const summed = g.tools.length;
    assert(summed === 2, `expected 2 tools in the group, got ${summed}`);
  });

  await run('grouping an empty tool list yields no groups', () => {
    assert(groupToolsByOrigin([]).length === 0, 'expected no groups for no tools');
  });

  // =========================================================================
  // Rendering — every tool must reach the DOM, because the whole point is that
  // a missing tool is visibly missing.
  // =========================================================================
  await run('every tool in the blob is rendered, under its server heading', () => {
    const tools = [
      tool('bash', 2, 'write'),
      tool('read', 2, 'read'),
      tool('mcp__linear__create_issue', 6, 'write'),
      tool('mcp__linear__list_issues', 3, 'read'),
    ];
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_1',
      input: { systemPrompt: 'You are a test.', messages: [], tools },
    });

    const toolsRow = /** @type {HTMLDetailsElement|null} */ (host.querySelector('.tx-row'));
    assert(toolsRow, 'no input rows rendered');

    // Rows build their body on first open, matching how a long history stays
    // cheap until asked for.
    const rows = [...host.querySelectorAll('.tx-row')];
    const row = rows.find((r) => r.querySelector('.tx-row-kind')?.textContent === 'tools');
    assert(row, `no tools row; kinds were ${JSON.stringify(rows.map((r) => r.querySelector('.tx-row-kind')?.textContent))}`);

    const label = row.querySelector('.tx-row-label')?.textContent || '';
    assert(label === '4 tools · 2 from MCP', `label was ${JSON.stringify(label)}`);

    /** @type {HTMLDetailsElement} */ (row).open = true;
    row.dispatchEvent(new Event('toggle'));

    const headings = [...row.querySelectorAll('.tx-tool-group-title')].map((e) => e.textContent);
    assert(
      JSON.stringify(headings) === JSON.stringify(['Juggler tools', 'MCP · linear']),
      `headings were ${JSON.stringify(headings)}`
    );

    const names = [...row.querySelectorAll('.tx-tool-name')].map((e) => e.getAttribute('title'));
    assert(names.length === 4, `expected 4 tool rows, got ${names.length}: ${JSON.stringify(names)}`);
    for (const t of tools) {
      assert(names.includes(String(t.name)), `${t.name} missing from the rendered list`);
    }
  });

  await run('an MCP tool is shown without its redundant server prefix', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_2',
      input: { systemPrompt: '', messages: [], tools: [tool('mcp__linear__create_issue')] },
    });
    const row = [...host.querySelectorAll('.tx-row')]
      .find((r) => r.querySelector('.tx-row-kind')?.textContent === 'tools');
    assert(row, 'no tools row rendered');
    /** @type {HTMLDetailsElement} */ (row).open = true;
    row.dispatchEvent(new Event('toggle'));

    const nameEl = row.querySelector('.tx-tool-name');
    assert(nameEl?.textContent === 'create_issue', `displayed name was ${JSON.stringify(nameEl?.textContent)}`);
    assert(
      nameEl?.getAttribute('title') === 'mcp__linear__create_issue',
      'the full LLM-facing name must stay available in the tooltip'
    );
  });

  await run('a tool description is reduced to its first line', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_3',
      input: { systemPrompt: '', messages: [], tools: [tool('bash')] },
    });
    const row = [...host.querySelectorAll('.tx-row')]
      .find((r) => r.querySelector('.tx-row-kind')?.textContent === 'tools');
    assert(row, 'no tools row rendered');
    /** @type {HTMLDetailsElement} */ (row).open = true;
    row.dispatchEvent(new Event('toggle'));

    const desc = row.querySelector('.tx-tool-desc')?.textContent || '';
    assert(desc === 'Description of bash.', `description line was ${JSON.stringify(desc)}`);
  });

  await run('a blob with no tools renders no tools row', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_4',
      input: { systemPrompt: 'prompt', messages: [], tools: [] },
    });
    const kinds = [...host.querySelectorAll('.tx-row-kind')].map((e) => e.textContent);
    assert(!kinds.includes('tools'), `expected no tools row, kinds were ${JSON.stringify(kinds)}`);
  });

  return { passed, failed, errors };
}
