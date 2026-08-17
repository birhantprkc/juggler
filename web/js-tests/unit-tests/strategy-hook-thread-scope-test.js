//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy-hook thread scoping.
 *
 * Strategy is per-thread, and the run-strategy-hook the worker sends names the
 * thread it belongs to. The engine must run the hook on THAT thread: the root
 * MessageThread is a cached instance that lives as long as the conversation, and
 * nothing ever puts its strategy back, so a sub-agent strategy installed there
 * goes on deciding the user's own tool approvals — refusing every call that
 * needs approval with "a sub-agent has nobody to ask".
 * @module unit-tests/strategy-hook-thread-scope-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { handleRunStrategyHook } from '../../js/services/worker-manager-protocols.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run the hook as the engine would, in the engine realm the handler demands.
 * @param {any} wm - Stand-in WorkerManager (only _session is read)
 * @param {string} conversationId - Conversation the hook targets
 * @param {any} data - The run-strategy-hook payload
 * @returns {Promise<void>}
 */
async function runAsEngine(wm, conversationId, data) {
  const g = /** @type {any} */ (globalThis);
  const had = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
  const saved = g.JUGGLER_ENGINE;
  g.JUGGLER_ENGINE = true;
  try {
    await handleRunStrategyHook(wm, conversationId, data);
  } finally {
    if (had) g.JUGGLER_ENGINE = saved; else delete g.JUGGLER_ENGINE;
  }
}

/**
 * Run strategy-hook thread-scoping tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function t(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const wm = { _session: session };

  await t('a sub-thread onActivate leaves the root thread on its own strategy', async () => {
    const root = conversation.rootMessageThread;
    const rootStrategyId = root.currentStrategyId;
    const rootStrategy = root.strategy;
    const { threadId } = root.createSubThread({ goal: 'sub' });

    await runAsEngine(wm, conversation.id, {
      hook: 'onActivate',
      strategyId: 'read-only',
      threadItemId: threadId,
      requestId: '',
      previousStrategyId: 'default'
    });

    assert(root.currentStrategyId === rootStrategyId,
      `root strategy id must survive a sub-thread activation, got ${root.currentStrategyId}`);
    assert(root.strategy === rootStrategy,
      'root strategy instance must survive a sub-thread activation — a replaced one decides the user\'s approvals');
    const reminders = conversation.resolveMessageThread(threadId).getMessages()
      .filter((/** @type {any} */ item) => item.get('type') === 'system-reminder');
    assert(reminders.length === 1,
      `the activated strategy must run on the sub-thread and inject there, got ${reminders.length} reminders`);
  });

  await t('a root hook still aligns the root thread to the worker\'s strategy', async () => {
    const root = conversation.rootMessageThread;

    await runAsEngine(wm, conversation.id, {
      hook: 'onWorkerIdle',
      strategyId: 'read-only',
      threadItemId: '',
      previousStrategyId: 'default'
    });

    assert(root.currentStrategyId === 'read-only',
      `a root-targeted hook must align root to the worker's strategy, got ${root.currentStrategyId}`);
  });

  return { passed, failed, errors };
}
