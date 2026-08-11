//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The `compacting` busy frame reaches the spinner.
 *
 * A summarizer run (/compact, /handoff, or context recovery) makes only hidden
 * LLM calls: nothing streams, no item lands, and the run can take a minute. The
 * worker's `processingState.status = "compacting"` frame is therefore the whole
 * of the user's evidence that anything is happening, and LLMState is where that
 * frame becomes a spinner and a label. A status the switch does not map falls to
 * its `default` — a console warning and no spinner — so the mapping is pinned
 * here rather than left to the browser suite, where a hidden-call run offers
 * nothing to synchronise a DOM assertion on.
 * @module unit-tests/compaction-status-test
 */

import LLMState from '../../js/services/llm-state.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Passing assertion count
 * @property {number} failed - Failing assertion count
 * @property {string[]} errors - Collected error messages
 */

/**
 * Run compaction-status tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => void} fn - Assertions to run
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (/** @type {any} */ e) { failed++; errors.push(`${name}: ${e.message}`); }
  }

  const convId = 'conv-compacting';
  const llmState = new LLMState();
  /**
   * Feed a worker processingState frame through the mapping under test.
   * @param {object} state - A worker processingState frame
   * @returns {void}
   */
  const publish = (state) => (/** @type {any} */ (llmState))._handleProcessingStateChange(convId, state);

  test('compacting frame is a processing state', () => {
    publish({ status: 'compacting', message: 'Summarizing conversation', threadItemId: 'thread-1', startedAt: Date.now() - 3000 });
    assert(llmState.isConversationProcessing(convId), 'compacting must read as processing — otherwise no spinner is drawn');
  });

  test('compacting frame carries the worker\'s label', () => {
    const message = llmState.getStatusMessage(convId);
    assert(message.includes('Summarizing conversation'), `status message = "${message}", want the worker's label`);
  });

  test('compacting frame targets the summary thread column', () => {
    assert(llmState.getStatusThreadId(convId) === 'thread-1', `status thread = ${llmState.getStatusThreadId(convId)}, want the fold thread`);
  });

  test('a compacting frame without a message still labels the spinner', () => {
    publish({ status: 'compacting', threadItemId: 'thread-1', startedAt: Date.now() });
    assert(llmState.getStatusMessage(convId).trim() !== '', 'an unlabelled compacting frame must fall back to a default label, never an empty spinner');
  });

  test('idle ends the compaction spinner', () => {
    publish({ status: 'idle' });
    assert(!llmState.isConversationProcessing(convId), 'idle must stop processing so the spinner clears');
  });

  return { passed, failed, errors };
}
