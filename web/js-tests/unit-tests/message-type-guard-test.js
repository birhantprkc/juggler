//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Message Type Guard Tests
 *
 * Verifies that message type guards correctly identify messages of each type,
 * even when those messages have an itemId (as assigned by _insertEventAt).
 *
 * Key invariant: isErrorMessage must identify error messages regardless of itemId,
 * so they never fall through to a "context item" default branch.
 * @module unit-tests/message-type-guard-test
 */

import {
  isUserMessage,
  isAssistantMessage,
  isThinkingMessage,
  isProviderStateMessage,
  isConversationalItemType,
  isToolActionMessage,
  isErrorMessage,
  isGuidanceMessage,
  isSystemReminderMessage,
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  createErrorMessage,
  createGuidanceMessage,
  createSystemReminderMessage,
  MESSAGE_TYPES
} from '../../sdk/lib/message.js';

import { assert } from '../utilities/test-helpers.js';
import { positionElements } from '../../js/components/conversation-area-rendering.js';
import { dispatchItemRenderer } from '../../js/services/renderers/item-renderers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run message type guard tests.
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
   * @param {() => void} fn
   */
  function test(name, fn) {
    try {
      fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  // Create messages of every type, each with an itemId (simulating _insertEventAt)
  const userMsg = { ...createUserMessage('hello'), itemId: 'MSG_1' };
  const assistantMsg = { ...createAssistantMessage('world'), itemId: 'MSG_2' };
  const thinkingMsg = /** @type {any} */ ({ type: MESSAGE_TYPES.THINKING, content: 'hmm', itemId: 'MSG_3' });
  const providerStateMsg = /** @type {any} */ ({ type: MESSAGE_TYPES.PROVIDER_STATE, providerData: { secret: 'opaque' }, itemId: 'MSG_PROVIDER' });
  const toolActionMsg = { ...createToolActionMessage({ toolUseId: 'tu_1', toolName: 'read', toolInput: {} }), itemId: 'MSG_4' };
  const errorMsg = { ...createErrorMessage({ message: 'something broke' }), itemId: 'MSG_5' };
  const guidanceMsg = { ...createGuidanceMessage({ content: 'guidance' }), itemId: 'MSG_6' };
  const reminderMsg = { ...createSystemReminderMessage({ content: 'reminder' }), itemId: 'MSG_7' };
  // A plugin marker (context item) — has itemId but no toolUseId and unknown type
  const pluginMarker = /** @type {any} */ ({ type: 'memory', itemId: 'MEM_1' });

  test('isUserMessage identifies user messages with itemId', () => {
    assert(isUserMessage(userMsg), 'should be true for user message');
    assert(!isUserMessage(errorMsg), 'should be false for error message');
    assert(!isUserMessage(pluginMarker), 'should be false for plugin marker');
  });

  test('isAssistantMessage identifies assistant messages with itemId', () => {
    assert(isAssistantMessage(assistantMsg), 'should be true for assistant message');
    assert(!isAssistantMessage(userMsg), 'should be false for user message');
  });

  test('isThinkingMessage identifies thinking messages with itemId', () => {
    assert(isThinkingMessage(thinkingMsg), 'should be true for thinking message');
    assert(!isThinkingMessage(assistantMsg), 'should be false for assistant message');
  });

  test('isProviderStateMessage identifies durable hidden provider state', () => {
    assert(isProviderStateMessage(providerStateMsg), 'should be true for provider-state message');
    assert(!isProviderStateMessage(thinkingMsg), 'should be false for thinking message');
    assert(isConversationalItemType(MESSAGE_TYPES.PROVIDER_STATE), 'provider-state should be conversation history');
  });

  test('provider-state is hidden from conversation and properties rendering', () => {
    const hidden = {
      get: (key) => providerStateMsg[key],
      toJSON: () => providerStateMsg,
    };
    const messageList = document.createElement('div');
    const footer = document.createElement('div');
    messageList.appendChild(footer);
    positionElements({}, messageList, footer, [hidden], new Map());
    assert(messageList.children.length === 1 && messageList.firstElementChild === footer,
      'provider-state should create no conversation element');

    const properties = document.createElement('div');
    dispatchItemRenderer(/** @type {any} */ ({}), properties, hidden);
    assert(properties.childElementCount === 0 && !properties.textContent?.includes('opaque'),
      'provider-state properties should expose nothing');
  });

  test('isToolActionMessage identifies tool-action messages with itemId', () => {
    assert(isToolActionMessage(toolActionMsg), 'should be true for tool-action message');
    assert(!isToolActionMessage(userMsg), 'should be false for user message');
  });

  test('isErrorMessage identifies error messages with itemId — NOT treated as plugin markers', () => {
    assert(isErrorMessage(errorMsg), 'should be true for error message');
    assert(!isErrorMessage(userMsg), 'should be false for user message');
    assert(!isErrorMessage(pluginMarker), 'should be false for plugin marker');
  });

  test('isGuidanceMessage identifies guidance messages with itemId', () => {
    assert(isGuidanceMessage(guidanceMsg), 'should be true for guidance message');
    assert(!isGuidanceMessage(userMsg), 'should be false for user message');
  });

  test('isSystemReminderMessage identifies system-reminder messages with itemId', () => {
    assert(isSystemReminderMessage(reminderMsg), 'should be true for system-reminder message');
    assert(!isSystemReminderMessage(userMsg), 'should be false for user message');
  });


  test('system type no longer exists in MESSAGE_TYPES', () => {
    assert(!('SYSTEM' in MESSAGE_TYPES), 'MESSAGE_TYPES should not have SYSTEM key');
  });

  return { passed, failed, errors };
}
