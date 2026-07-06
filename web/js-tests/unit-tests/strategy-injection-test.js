//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy guidance-injection tests.
 *
 * Strategies no longer author system-prompt text; they steer the model by
 * injecting durable system-reminder messages into the conversation. These tests
 * pin that mechanism end-to-end against a real Yjs-backed message thread:
 *
 *  1. StrategyType.injectGuidance writes a system-reminder item (sourced from
 *     the strategy id) that lands in the thread's messages.
 *  2. Read-only's onActivate injects the read-only notice.
 *
 * The worker-path delivery of these items to the LLM is pinned separately by
 * the Go tests TestInjectedSystemReminderReachesMessages / ...Guidance.
 * @module unit-tests/strategy-injection-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Collect the system-reminder messages on a message thread.
 * @param {any} messageThread - The thread to inspect
 * @returns {Array<{content: string, source: string|undefined}>} System-reminder messages
 */
function systemReminders(messageThread) {
  return messageThread.getMessages()
    .filter((/** @type {any} */ m) => m.get('type') === 'system-reminder')
    .map((/** @type {any} */ m) => ({ content: m.get('content'), source: m.get('source') }));
}

/**
 * Run strategy-injection tests.
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
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  await initializeRegistries();
  const session = await createTestSession();

  await test('injectGuidance writes a system-reminder sourced from the strategy id', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const strategy = strategyRegistry.createStrategy('default', mt);
    strategy.injectGuidance('PROBE-GUIDANCE-TEXT');

    const reminders = systemReminders(mt);
    const probe = reminders.find(r => r.content === 'PROBE-GUIDANCE-TEXT');
    assert(!!probe, `injected system-reminder should be present; reminders=${JSON.stringify(reminders)}`);
    assert(probe.source === 'default', `source should default to the strategy id 'default', got '${probe.source}'`);
  });

  await test('injectGuidance honours an explicit source', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const strategy = strategyRegistry.createStrategy('default', mt);
    strategy.injectGuidance('SOURCED', { source: 'custom-src' });

    const probe = systemReminders(mt).find(r => r.content === 'SOURCED');
    assert(!!probe, 'sourced reminder should be present');
    assert(probe.source === 'custom-src', `explicit source should win, got '${probe.source}'`);
  });

  await test('read-only onActivate injects the read-only notice', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const strategy = strategyRegistry.createStrategy('read-only', mt);
    strategy.onActivate('default');

    const reminders = systemReminders(mt);
    const notice = reminders.find(r => /READ-ONLY MODE/.test(r.content) && /read-only/.test(r.content));
    assert(!!notice, `read-only notice should be injected; reminders=${JSON.stringify(reminders)}`);
    assert(notice.source === 'read-only', `notice source should be 'read-only', got '${notice.source}'`);
  });

  await test('base onActivate is a no-op (injects nothing)', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const strategy = strategyRegistry.createStrategy('default', mt);
    strategy.onActivate('read-only');
    assert(systemReminders(mt).length === 0, 'default strategy onActivate must inject nothing');
  });

  return { passed, failed, errors };
}
