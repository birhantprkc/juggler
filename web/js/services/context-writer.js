//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ContextWriter - Procedural API for plugins to add messages to LLM context.
 *
 * Instead of the framework auto-adding tool-use/tool-result pairs,
 * plugins call these methods to add exactly what they need.
 * @module context-writer
 */

import {
  createAssistantMessage,
  createUserMessage,
  createGuidanceMessage,
  createSystemReminderMessage,
  createToolActionMessage
} from '../../sdk/lib/message.js';

/**
 * Procedural API for plugins to add messages to LLM context.
 * @typedef {object} ContextWriter
 * @property {(content: string) => void} addAssistantMessage - Add assistant message to context
 * @property {(content: string) => void} addUserMessage - Add user message to context
 * @property {(content: string, source?: string) => void} addGuidance - Add guidance message (plugin/strategy context)
 * @property {(content: string, source?: string) => void} addSystemReminder - Add system reminder
 * @property {(toolUseId: string, toolName: string, input: Record<string, unknown>, result: string) => void} addToolPair - Add tool-action message
 * @property {boolean} handled - True if plugin called any ctx method (skip auto-add)
 */

/**
 * Create a ContextWriter for a tool execution.
 * Plugins use this to add messages to the message thread.
 * @param {import('../model/message-thread.js').default} messageThread - Message thread to add messages to
 * @returns {ContextWriter} Context writer with message-adding methods
 */
export function createContextWriter(messageThread) {
  /** @type {ContextWriter} */
  const ctx = {
    /**
     * Whether plugin called any ctx method.
     * If true, framework skips auto-adding tool messages.
     */
    handled: false,

    /**
     * Add an assistant message to the conversation context.
     * @param {string} content - Message content
     */
    addAssistantMessage(content) {
      ctx.handled = true;
      messageThread.addEvent(createAssistantMessage(content));
    },

    /**
     * Add a user message to the conversation context.
     * @param {string} content - Message content
     */
    addUserMessage(content) {
      ctx.handled = true;
      messageThread.addEvent(createUserMessage(content));
    },

    /**
     * Add a guidance message to the conversation context.
     * Use for plugin/strategy-injected context that should be encoded as user role for LLM.
     * @param {string} content - Guidance content
     * @param {string} [source] - Source of the guidance (plugin/strategy name)
     */
    addGuidance(content, source) {
      ctx.handled = true;
      messageThread.addEvent(createGuidanceMessage({ content, source }));
    },

    /**
     * Add a system reminder to the conversation context.
     * @param {string} content - Reminder content
     * @param {string} [source] - Source of the reminder
     */
    addSystemReminder(content, source) {
      ctx.handled = true;
      messageThread.addEvent(createSystemReminderMessage({ content, source }));
    },

    /**
     * Add a tool-action to the conversation context.
     * This is the standard format for tool invocations.
     * @param {string} toolUseId - Unique ID for this tool invocation
     * @param {string} toolName - Name of the tool
     * @param {Record<string, unknown>} input - Tool input (can be truncated/sanitized)
     * @param {string} result - Tool result content
     */
    addToolPair(toolUseId, toolName, input, result) {
      ctx.handled = true;
      messageThread.addEvent(createToolActionMessage({
        toolUseId,
        toolName,
        toolInput: input,
        result: {
          content: result,
          isError: false
        }
      }));
    }
  };
  return ctx;
}
