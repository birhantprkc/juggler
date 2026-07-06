//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * SystemPromptContextItem tests.
 *
 * Pins the env block's date to the conversation's creation timestamp so the
 * assembled system prompt is a pure function of durable conversation state. A
 * live clock would make a conversation resumed across midnight rebuild a
 * different prompt for the same meaningful state — a spurious cold start that
 * busts claudecode's warm prompt cache.
 * @module unit-tests/system-prompt-context-item-test
 */

import SystemPromptContextItem from '../../extensions/juggler-core/context-items/system-prompt-context-item.js';
import { getDefaultIdentityText } from '../../sdk/lib/system-prompt-registry.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run system-prompt-context-item tests.
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

  // A fixed PAST creation timestamp: the env block's date must reflect this,
  // never the live clock, so the assembled prompt is byte-stable across turns
  // and across a resume that crosses midnight.
  const FIXED_CREATED = '2020-01-01T08:30:00.000Z';

  /**
   * Construct a SystemPromptContextItem against minimal fakes — the item only
   * reads session.projectPath/platform and conversation.created.
   * @param {string} [created] - Conversation creation ISO timestamp
   * @returns {SystemPromptContextItem} Item under test
   */
  function makeItem(created = FIXED_CREATED) {
    return new SystemPromptContextItem({
      id: 'SYSTEM_test',
      session: /** @type {any} */ ({ projectPath: '/proj', platform: 'darwin' }),
      conversation: /** @type {any} */ ({ created }),
      messageThread: /** @type {any} */ ({})
    });
  }

  await test('buildPrompt pins the env date to conversation.created (full prompt)', () => {
    const item = makeItem();
    const prompt = item.buildPrompt();
    // With no stored text, the body is the built-in default preset content;
    // derive it from the registry so this test tracks wording changes.
    const expected =
      getDefaultIdentityText() + '\n\n' +
			'<env>\n' +
			'Working directory: /proj\n' +
			'Platform: darwin\n' +
			"Today's date: 2020-01-01\n" +
			'</env>';
    assert(prompt === expected, `assembled prompt should pin the date to conversation.created:\n--- got ---\n${prompt}\n--- want ---\n${expected}`);
  });

  await test('buildPrompt does not leak the live clock date', () => {
    const item = makeItem();
    const prompt = item.buildPrompt();
    const todayLive = new Date().toISOString().split('T')[0];
    // The pinned date is in the distant past, so the live date cannot match it.
    assert(todayLive !== '2020-01-01', 'precondition: test must not be run on 2020-01-01');
    assert(!prompt.includes(`Today's date: ${todayLive}`), `live clock date must not appear in the prompt:\n${prompt}`);
  });

  await test('buildPrompt is byte-identical across successive calls', () => {
    const item = makeItem();
    const a = item.buildPrompt();
    const b = item.buildPrompt();
    assert(a === b, `two successive builds must be byte-identical:\n--- a ---\n${a}\n--- b ---\n${b}`);
  });

  await test('falls back to live date only when conversation.created is absent', () => {
    const item = new SystemPromptContextItem({
      id: 'SYSTEM_test_nocreated',
      session: /** @type {any} */ ({ projectPath: '/proj', platform: 'darwin' }),
      conversation: /** @type {any} */ ({}),
      messageThread: /** @type {any} */ ({})
    });
    const prompt = item.buildPrompt();
    const todayLive = new Date().toISOString().split('T')[0];
    assert(prompt.includes(`Today's date: ${todayLive}`), `with no conversation.created the fallback live date should appear:\n${prompt}`);
  });

  return { passed, failed, errors };
}
