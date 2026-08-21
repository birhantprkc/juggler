//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for `splitToolsByStrategy` — the decision behind which tools a
 * thread offers the model, and the pure half of `buildToolInventory`.
 *
 * That function has two callers: the turn path, which sends `offered`, and the
 * System Prompt panel's Tools section, which shows it. The sharing is the whole
 * point. A transparency surface computed by a second, parallel implementation
 * can disagree with what was actually sent, and a panel that quietly lies about
 * the tool list is worse than no panel — so these tests pin that `offered` is
 * exactly the strategy's own output, and that `withheld` accounts for every tool
 * the strategy dropped instead of letting it vanish silently.
 * @module unit-tests/thread-tool-inventory-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  diffToolNames,
  formatToolDrift,
  splitToolsByStrategy,
  strategyDisplayName,
  toolDriftDetail,
} from '../../js/services/thread-tool-inventory.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** The tool set every test in here starts from. */
const ALL_TOOLS = [
  { name: 'read', category: 'read', description: 'Read a file' },
  { name: 'bash', category: 'write', description: 'Run a command' },
  { name: 'mcp__linear__list_issues', category: 'read', description: 'List issues' },
  { name: 'mcp__linear__create_issue', category: 'write', description: 'Create an issue' },
];

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

  await run('no strategy offers everything and withholds nothing', () => {
    const inv = splitToolsByStrategy(ALL_TOOLS.slice(), undefined);
    assert(inv.offered.length === ALL_TOOLS.length, `offered ${inv.offered.length} of ${ALL_TOOLS.length}`);
    assert(inv.withheld.length === 0, `withheld should be empty, got ${JSON.stringify(inv.withheld.map((t) => t.name))}`);
    assert(inv.strategyName === '', `strategyName should be empty, got ${JSON.stringify(inv.strategyName)}`);
  });

  await run('a null strategy is handled rather than thrown on', () => {
    const inv = splitToolsByStrategy(ALL_TOOLS.slice(), null);
    assert(inv.offered.length === ALL_TOOLS.length, `offered ${inv.offered.length}`);
    assert(inv.withheld.length === 0, 'withheld should be empty');
  });

  await run('a strategy without filterTools offers everything', () => {
    const inv = splitToolsByStrategy(ALL_TOOLS.slice(), { getApprovalPolicy: () => 'default' });
    assert(inv.offered.length === ALL_TOOLS.length, `offered ${inv.offered.length}`);
    assert(inv.withheld.length === 0, 'withheld should be empty');
  });

  // The read-only case is the one behind the original report: an MCP server that
  // annotates nothing has every tool classed as a write, so a read-only strategy
  // withholds the lot and the model behaves as though the server were not there.
  await run('a read-only strategy withholds writes, and they are accounted for', () => {
    class ReadOnlyish {
      static MANIFEST = { id: 'read-only', name: 'Read-only' };
      /**
       * @param {Array<any>} tools - Tools to filter
       * @returns {Array<any>} Only the reads
       */
      filterTools(tools) {
        return tools.filter((t) => t.category === 'read');
      }
    }
    const inv = splitToolsByStrategy(ALL_TOOLS.slice(), new ReadOnlyish());

    const offered = inv.offered.map((t) => t.name).sort();
    assert(
      JSON.stringify(offered) === JSON.stringify(['mcp__linear__list_issues', 'read']),
      `offered ${JSON.stringify(offered)}`
    );
    const withheld = inv.withheld.map((t) => t.name).sort();
    assert(
      JSON.stringify(withheld) === JSON.stringify(['bash', 'mcp__linear__create_issue']),
      `withheld ${JSON.stringify(withheld)}`
    );
    assert(inv.strategyName === 'Read-only', `strategyName was ${JSON.stringify(inv.strategyName)}`);
  });

  await run('offered plus withheld always accounts for every tool', () => {
    class DropsEverything {
      static MANIFEST = { id: 'paranoid', name: 'Paranoid' };
      /** @returns {Array<any>} Nothing at all */
      filterTools() { return []; }
    }
    const inv = splitToolsByStrategy(ALL_TOOLS.slice(), new DropsEverything());
    assert(inv.offered.length === 0, `offered should be empty, got ${inv.offered.length}`);
    assert(
      inv.offered.length + inv.withheld.length === ALL_TOOLS.length,
      `${inv.offered.length} + ${inv.withheld.length} should account for ${ALL_TOOLS.length}`
    );
  });

  await run('a strategy returning nothing is treated as withholding everything', () => {
    class ReturnsUndefined {
      static MANIFEST = { id: 'broken', name: 'Broken' };
      /** @returns {undefined} Nothing */
      filterTools() { return undefined; }
    }
    const inv = splitToolsByStrategy(ALL_TOOLS.slice(), new ReturnsUndefined());
    assert(inv.offered.length === 0, `offered should be empty, got ${inv.offered.length}`);
    assert(inv.withheld.length === ALL_TOOLS.length, `withheld ${inv.withheld.length}`);
  });

  await run('the offered array is the strategy own output, not a re-filtered copy', () => {
    const sentinel = [{ name: 'only-this' }];
    class ReturnsSentinel {
      static MANIFEST = { id: 'sentinel', name: 'Sentinel' };
      /** @returns {Array<any>} A list of its own choosing */
      filterTools() { return sentinel; }
    }
    const inv = splitToolsByStrategy(ALL_TOOLS.slice(), new ReturnsSentinel());
    assert(inv.offered === sentinel, 'offered must be passed through untouched');
  });

  // =========================================================================
  // Drift between a recorded tool list and the live one. Two surfaces make this
  // comparison — the System Prompt panel looking back at the last turn, the
  // transaction panel looking forward from an old one — and they share these
  // helpers precisely so they can't come to word the same fact differently.
  // =========================================================================

  await run('drift: identical lists report nothing', () => {
    const drift = diffToolNames(ALL_TOOLS.slice(), ALL_TOOLS.slice());
    assert(drift.added.length === 0 && drift.removed.length === 0, `drift was ${JSON.stringify(drift)}`);
    assert(formatToolDrift(drift) === '', `summary was ${JSON.stringify(formatToolDrift(drift))}`);
    assert(toolDriftDetail(drift) === '', 'matching lists should have no detail');
  });

  // The reported case: a server finishes connecting after the turn was sent, so
  // its tools are live but were never offered. Not a bug — but only visible if
  // the UI says it.
  await run('drift: a tool that arrived after the turn counts as added', () => {
    const sent = [{ name: 'read' }];
    const live = [{ name: 'read' }, { name: 'mcp__linear__create_issue' }];
    const drift = diffToolNames(sent, live);
    assert(JSON.stringify(drift.added) === JSON.stringify(['mcp__linear__create_issue']), `added ${JSON.stringify(drift.added)}`);
    assert(drift.removed.length === 0, `removed ${JSON.stringify(drift.removed)}`);
    assert(formatToolDrift(drift) === '1 added', `summary was ${JSON.stringify(formatToolDrift(drift))}`);
  });

  await run('drift: a tool that has since gone counts as removed', () => {
    const drift = diffToolNames([{ name: 'read' }, { name: 'bash' }], [{ name: 'read' }]);
    assert(JSON.stringify(drift.removed) === JSON.stringify(['bash']), `removed ${JSON.stringify(drift.removed)}`);
    assert(formatToolDrift(drift) === '1 gone', `summary was ${JSON.stringify(formatToolDrift(drift))}`);
  });

  await run('drift: both directions are counted, added first', () => {
    const drift = diffToolNames(
      [{ name: 'read' }, { name: 'bash' }, { name: 'glob' }],
      [{ name: 'read' }, { name: 'mcp__linear__list_issues' }]
    );
    assert(formatToolDrift(drift) === '1 added, 2 gone', `summary was ${JSON.stringify(formatToolDrift(drift))}`);
    const detail = toolDriftDetail(drift);
    assert(detail.includes('Added: mcp__linear__list_issues'), `detail was ${JSON.stringify(detail)}`);
    assert(detail.includes('Gone: bash, glob'), `detail was ${JSON.stringify(detail)}`);
  });

  await run('drift: comparison is by name, not by schema', () => {
    const drift = diffToolNames(
      [{ name: 'read', input_schema: { properties: { a: {} } } }],
      [{ name: 'read', input_schema: { properties: { a: {}, b: {} } } }]
    );
    assert(formatToolDrift(drift) === '', 'a re-shaped schema is not a tool appearing or disappearing');
  });

  await run('drift: a nameless entry does not masquerade as a change', () => {
    const drift = diffToolNames([{}], [{}]);
    assert(formatToolDrift(drift) === '', `summary was ${JSON.stringify(formatToolDrift(drift))}`);
  });

  await run('drift: null is tolerated by both formatters', () => {
    assert(formatToolDrift(null) === '', 'null drift should format to nothing');
    assert(toolDriftDetail(null) === '', 'null drift should have no detail');
  });

  await run('strategyDisplayName falls back through manifest name, id, then class', () => {
    class Named { static MANIFEST = { id: 'x', name: 'Proper Name' }; }
    class IdOnly { static MANIFEST = { id: 'just-an-id' }; }
    class Bare { }
    assert(strategyDisplayName(new Named()) === 'Proper Name', 'manifest name should win');
    assert(strategyDisplayName(new IdOnly()) === 'just-an-id', 'manifest id is the second choice');
    assert(strategyDisplayName(new Bare()) === 'Bare', 'class name is the last resort');
    assert(strategyDisplayName(null) === '', 'no strategy means no name');
  });

  return { passed, failed, errors };
}
