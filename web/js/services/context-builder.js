//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Context Builder - Renders context items and prepares messages for LLM
 *
 * Simplified architecture:
 * - Takes Message[] from messageThread.getMessages()
 * - Renders context items (looks up instance, populates content)
 * - Filters UI-only messages (error, unknown types)
 * - Returns { systemPrompt, messages } for Go providers
 *
 * Go providers handle all API-specific transformation (message merging, SDK conversion).
 */

import { TextSectionRenderer } from './renderers/text-section-renderer.js';
import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';
import { assembleSystemPrompt } from './system-prompt-builder.js';
import { buildExtensionSystemPromptContributions } from './extensions.js';
import {
  createSystemReminderMessage,
  MESSAGE_TYPES,
  isToolActionMessage,
  isThreadMessage,
  isErrorMessage,
  isUserMessage,
  isAssistantMessage,
  isGuidanceMessage,
  isSystemReminderMessage,
  isThinkingMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * @typedef {object} PreparedContext
 * @property {string|null} systemPrompt - System prompt extracted from system-prompt context item
 * @property {any[]} messages - Messages with context items rendered (plain objects for LLM)
 */

export class ContextBuilder {
  /**
   * @param {object} options - Configuration options
   * @param {import('../model/message-thread.js').default} options.messageThread - Message thread for message access
   * @param {import('../model/session.js').default} options.session - Session instance
   * @param {number} [options.contextWindow] - Context window size for usage calculation
   */
  constructor({ messageThread, session, contextWindow = 0 }) {
    /** @type {import('../model/message-thread.js').default} */
    this.messageThread = messageThread;
    /** @type {import('../model/conversation.js').default} */
    this.conversation = messageThread.conversation;
    this.session = session;
    this.contextWindow = contextWindow;

    // Model config for context item rendering
    this.modelConfig = this.conversation.modelConfig || null;
  }

  /**
   * Prepare messages for sending to LLM
   * - Renders context items (populates content from context item instances)
   * - Filters UI-only messages (error, unknown types)
   * - Extracts system prompt from system-prompt context item
   * @param {{skipPendingValidation?: boolean}} [options] - Options
   * @returns {Promise<PreparedContext>} Prepared context with systemPrompt and messages
   */
  async prepare(options = {}) {
    const { skipPendingValidation = false } = options;

    // INVARIANT: All tool-actions must be completed/cancelled before building context for LLM
    // Every tool-use MUST have a corresponding tool-result (Claude API requirement)
    // For token counting (skipPendingValidation=true), we allow incomplete state
    if (!skipPendingValidation) {
      const incompleteActions = this.messageThread.items.filter(
        item => isToolActionMessage(/** @type {import('../../sdk/lib/message.js').Message} */ (item)) &&
					item.get('state') !== TOOL_STATES.COMPLETED && item.get('state') !== TOOL_STATES.CANCELLED
      );
      if (incompleteActions.length > 0) {
        const ids = incompleteActions.map(a =>
        /** @type {import('../../sdk/lib/message.js').ToolActionMessage} */ (a).get('toolUseId')
        ).join(', ');
        throw new Error(`Cannot build context with incomplete tool-actions: ${ids}`);
      }
    }

    /** @type {PreparedContext} */
    const result = {
      systemPrompt: null,
      messages: []
    };

    // Context params for context item rendering
    const contextParams = {
      contextWindowSize: this.contextWindow,
      modelConfig: this.modelConfig,
      helpers: FormattingHelpers
    };

    // The system prompt is assembled from the thread being prepared: root owns
    // its own, and a sub-thread owns its cloned copy (seeded at creation by the
    // worker). Fall back to root's items when this thread carries no
    // system-prompt item yet (first-turn sync race, or a not-yet-seeded thread)
    // so the prompt is never empty — matching the worker's own fallback in
    // session-worker-callbacks.js.
    const ownItems = this.messageThread.contextItems;
    const contextItems = ownItems.some((/** @type {any} */ f) => f.type === 'system-prompt')
      ? ownItems
      : this.conversation.rootMessageThread.contextItems;

    // Assemble the system prompt via the shared builder (single source of
    // truth shared with the worker context-request callback).
    const extensionContributions = await buildExtensionSystemPromptContributions();
    const systemPrompt = await assembleSystemPrompt({
      contextItems,
      contextParams,
      extensionContributions
    });

    result.systemPrompt = systemPrompt || null;

    const allMessages = this.messageThread.getMessages();

    // Process messages - filter UI-only messages, handle known types explicitly
    for (const msg of allMessages) {
      // Filter UI-only messages
      if (isErrorMessage(msg)) {
        continue;
      }

      // Handle thread messages - completed threads with results appear as condensed context
      if (isThreadMessage(msg)) {
        const threadResult = msg.get('result');
        if (threadResult) {
          result.messages.push(createSystemReminderMessage({
            content: `[Completed Thread: ${msg.get('goal')}]\nThis work has been completed by a sub-thread — do not repeat it:\n\n${threadResult}`,
            source: 'thread'
          }));
        }
        continue;
      }

      // Handle tool-action messages (unified format - split into tool-use + tool-result for LLM)
      if (isToolActionMessage(msg)) {
        // Always emit tool-use (assistant requested this tool)
        result.messages.push({
          type: MESSAGE_TYPES.TOOL_USE,
          toolUseId: msg.get('toolUseId'),
          toolName: msg.get('toolName'),
          toolInput: msg.get('toolInput')?.toJSON ? msg.get('toolInput').toJSON() : msg.get('toolInput')
        });

        // Emit tool-result only if action is complete (result !== null/undefined)
        const msgResult = msg.get('result');
        if (msgResult !== null && msgResult !== undefined) {
          let content = msgResult.get('content') || '';

          // Check for llmFeedback in result
          const fullResult = msgResult.get('fullResult');
          const llmFeedback = fullResult?.get('llmFeedback');
          if (llmFeedback) {
            content = `${content}\n\n<llm-context>\n${llmFeedback}\n</llm-context>`;
          }

          result.messages.push({
            type: MESSAGE_TYPES.TOOL_RESULT,
            toolUseId: msg.get('toolUseId'),
            content,
            isError: msgResult.get('isError') || false
          });
        }
        continue;
      }

      // Pass through known LLM-relevant message types
      if (isUserMessage(msg) || isAssistantMessage(msg) || isThinkingMessage(msg)
				|| isGuidanceMessage(msg) || isSystemReminderMessage(msg)) {
        result.messages.push(msg.toJSON());
        continue;
      }
      // Plugin markers and any other unknown types: skip
    }

    return result;
  }

  /**
   * Get system prompt
   * @returns {string} The system prompt
   */
  getSystemPrompt() {
    // Assemble from the thread being prepared; fall back to root when it owns no
    // system-prompt item yet (see prepare()).
    const ownItems = this.messageThread.contextItems;
    const systemPromptItem = ownItems.find(item => item.type === 'system-prompt')
      || this.conversation.rootMessageThread.contextItems.find(item => item.type === 'system-prompt');
    if (systemPromptItem) {
      return /** @type {any} */ (systemPromptItem).buildPrompt();
    }
    return '';
  }

  /**
   * Render context as text with section metadata for UI preview
   * @returns {Promise<{text: string, sections: Array<unknown>}>} Text and section metadata
   */
  async renderTextWithSections() {
    const textRenderer = new TextSectionRenderer(this);
    return await textRenderer.renderTextWithSections(this);
  }

}
