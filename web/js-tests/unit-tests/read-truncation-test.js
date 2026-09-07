//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a read tells the model about itself must be true.
 *
 * A read is bounded twice — the backend caps lines, the item caps characters —
 * and the footer is written between the two. These tests hold the invariant
 * that makes the pair safe to have: the lines a read delivers are a contiguous
 * run, and the footer names exactly that run, so following the footer's own
 * offset walks the whole file without a hole.
 * @module unit-tests/read-truncation
 */

import { DEFAULT_TRUNCATION_BUDGET } from 'juggler/context-item';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  executeToolsAndGetContext,
  createToolCall,
  assert
} from '../utilities/test-helpers.js';

/** The 3000-line fixture, past the backend's 2000-line cap. */
const BIG_FILE = 'large-file.txt';
/** 1000 lines: inside the line cap, past the character budget. */
const PAGES_FILE = 'truncation-pages.txt';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * The line numbers a formatted read actually delivered, in order. Reads the
 * `cat -n` prefix the formatter writes, so it counts what the model can cite
 * rather than what the footer claims.
 * @param {string} text - Formatted read output
 * @returns {number[]} Delivered line numbers
 */
function deliveredLineNumbers(text) {
  /** @type {number[]} */
  const nums = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\t/.exec(line);
    if (m) nums.push(Number(m[1]));
  }
  return nums;
}

/**
 * The first hole in a run of line numbers, or null when it is contiguous.
 * @param {number[]} nums - Delivered line numbers
 * @returns {{after: number, before: number}|null} The gap, if any
 */
function firstGap(nums) {
  for (let i = 1; i < nums.length; i++) {
    const prev = /** @type {number} */ (nums[i - 1]);
    const cur = /** @type {number} */ (nums[i]);
    if (cur !== prev + 1) return { after: prev, before: cur };
  }
  return null;
}

/**
 * Parse the footer a read appends. Returns the resumable form when the read was
 * partial, the total-only form when it claims the whole file, or null.
 * @param {string} text - Formatted read output
 * @returns {{partial: true, start: number, end: number, total: number, next: number}
 *          |{partial: false, total: number}|null} Parsed footer
 */
function parseFooter(text) {
  const range = /\(Showing lines (\d+)-(\d+) of (\d+)\. Use offset=(\d+) to read more\.\)/.exec(text);
  if (range) {
    return {
      partial: true,
      start: Number(range[1]),
      end: Number(range[2]),
      total: Number(range[3]),
      next: Number(range[4])
    };
  }
  const total = /\((\d+) lines total\)/.exec(text);
  if (total) return { partial: false, total: Number(total[1]) };
  return null;
}

/**
 * Run one tool call in a fresh conversation and return its tool-result text.
 * @param {any} session - Test session
 * @param {string} toolName - Tool to call
 * @param {Record<string, unknown>} input - Tool input
 * @returns {Promise<string>} The tool-result content the model would see
 */
async function toolResultText(session, toolName, input) {
  const conversation = await createTestConversation(session);
  const { context } = await executeToolsAndGetContext(
    conversation, session, [createToolCall(toolName, input)]
  );
  const result = /** @type {{content?: string}} */ (context.messages[2]);
  return result.content || '';
}

/**
 * Run all read truncation tests.
 * @param {any} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: a read delivers a contiguous run of lines.
  // The character budget cuts the middle out of the line-capped block, so the
  // model is handed line 1..N and line M..2000 with nothing joining them.
  try {
    const content = await toolResultText(session, 'read', { file_path: BIG_FILE });
    const nums = deliveredLineNumbers(content);
    assert(nums.length > 0, 'Read should deliver numbered lines');
    assert(nums[0] === 1, `Read should start at line 1, started at ${nums[0]}`);
    const gap = firstGap(nums);
    assert(
      gap === null,
      `Read delivered a hole: line ${gap?.after} is followed by line ${gap?.before}`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`contiguous read: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: the footer names exactly the lines that arrived. A footer that
  // over-claims is worse than a short read: it tells the model to resume past
  // content it never saw.
  try {
    const content = await toolResultText(session, 'read', { file_path: BIG_FILE });
    const nums = deliveredLineNumbers(content);
    const footer = parseFooter(content);
    assert(footer !== null, 'Read should carry a footer');
    const lastDelivered = nums[nums.length - 1];
    const claimedEnd = footer?.partial ? footer.end : footer?.total;
    assert(
      claimedEnd === lastDelivered,
      `Footer claims lines through ${claimedEnd} but the last line delivered was ${lastDelivered}`
    );
    if (footer?.partial) {
      assert(
        footer.next === lastDelivered + 1,
        `Footer resumes at ${footer.next}, which skips line ${lastDelivered + 1}`
      );
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`footer matches content: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: the property that matters. Following the footer's own offset from
  // the top must visit every line of the file exactly once.
  try {
    /** @type {Set<number>} */
    const seen = new Set();
    let offset = 1;
    let pages = 0;
    let total = 0;
    while (pages < 30) {
      const content = await toolResultText(session, 'read', { file_path: BIG_FILE, offset });
      pages++;
      for (const n of deliveredLineNumbers(content)) seen.add(n);
      const footer = parseFooter(content);
      assert(footer !== null, `Page ${pages} carried no footer`);
      total = /** @type {number} */ (footer?.total);
      if (!footer?.partial || footer.end >= total) break;
      assert(footer.next > offset, `Page ${pages} did not advance past offset ${offset}`);
      offset = footer.next;
    }
    assert(total > 0, 'Should have learned the file total');
    /** @type {number[]} */
    const missing = [];
    for (let n = 1; n <= total; n++) if (!seen.has(n)) missing.push(n);
    assert(
      missing.length === 0,
      `Paging the file by its own offsets missed ${missing.length} of ${total} lines ` +
      `(first missing: ${missing[0]}, last: ${missing[missing.length - 1]})`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`paging is lossless: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: a file inside the backend's line cap must not be announced as whole
  // when the character budget cut it. This is the common case — most oversized
  // source files are under 2000 lines — and the footer's "(N lines total)" is
  // read by the model as "you have all of it".
  try {
    const content = await toolResultText(session, 'read', { file_path: PAGES_FILE });
    const nums = deliveredLineNumbers(content);
    const footer = parseFooter(content);
    assert(footer !== null, 'Read should carry a footer');
    const lastDelivered = nums[nums.length - 1];
    assert(firstGap(nums) === null, 'Read of a sub-cap file delivered a hole');
    if (!footer?.partial) {
      assert(
        lastDelivered === footer?.total,
        `Footer announces the whole file (${footer?.total} lines) but the read stopped at line ${lastDelivered}`
      );
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`sub-cap file honesty: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: batch_read shares one budget across every file it read, cutting the
  // joined string head-and-tail — so a file in the middle can vanish outright,
  // leaving the model to read it again on its own.
  try {
    const content = await toolResultText(session, 'batch_read', {
      files: [
        { file_path: PAGES_FILE },
        { file_path: 'config.json' },
        { file_path: BIG_FILE }
      ]
    });
    assert(
      content.includes('<file path="config.json">'),
      'batch_read dropped the middle file entirely'
    );
    assert(
      content.includes('"name": "test-project"'),
      'batch_read kept the middle file\'s header but not its content'
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`batch_read keeps every file: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: every block in a batch_read is itself honest, on the same terms as
  // a single read.
  try {
    const content = await toolResultText(session, 'batch_read', {
      files: [{ file_path: PAGES_FILE }, { file_path: BIG_FILE }]
    });
    for (const block of content.split('<file path=').slice(1)) {
      const path = /^"([^"]+)"/.exec(block)?.[1] || '?';
      const gap = firstGap(deliveredLineNumbers(block));
      assert(
        gap === null,
        `batch_read block for ${path} has a hole: line ${gap?.after} then ${gap?.before}`
      );
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`batch_read blocks contiguous: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 7: the per-result character budget follows the model's context window.
  // A fixed 30k budget spends a 200k window's worth of caution on a model with
  // five times the room, turning one read into a paging session.
  try {
    const conversation = await createTestConversation(session);

    conversation.contextWindow = 200000;
    const small = conversation.truncationBudget;
    assert(
      small >= DEFAULT_TRUNCATION_BUDGET,
      `A 200k window should keep at least the default budget, got ${small}`
    );

    conversation.contextWindow = 1000000;
    const large = conversation.truncationBudget;
    assert(
      large > small,
      `A 1M window should raise the budget above a 200k window's ${small}, got ${large}`
    );

    conversation.contextWindow = null;
    assert(
      conversation.truncationBudget === DEFAULT_TRUNCATION_BUDGET,
      'An unknown window should fall back to the default budget'
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`budget follows the window: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
