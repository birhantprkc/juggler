//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Text Section Renderer - Renders context as plain text with section metadata
 *
 * Used for context preview UI.
 * Produces {text: string, sections: ContextSection[]} format with offset tracking.
 */

import {
  isUserMessage,
  isAssistantMessage,
  isThinkingMessage,
  isToolUseMessage,
  isToolResultMessage
} from '../../../sdk/lib/message.js';

/**
 * @typedef {object} ContextSection
 * @property {string} type - Section type (system, context-items-header, context-item, conversation-message, current-header, current, next-steps)
 * @property {string} label - Human-readable label for navigation
 * @property {number} offset - Character offset where section starts
 * @property {number} length - Length of section content in characters
 * @property {string} [role] - Message role (user, assistant, etc.) for conversation messages
 * @property {number} [itemIndex] - Index of context item (for context item sections)
 */

export class TextSectionRenderer {
  /**
   * @param {import('../context-builder.js').ContextBuilder} builder - ContextBuilder instance
   */
  constructor(builder) {
    if (!builder) {
      throw new Error('[TextSectionRenderer] ContextBuilder is required');
    }
    this._builder = builder;
  }

  /**
   * Create a markdown heading
   * @param {string} text - Heading text
   * @param {number} level - Heading level (1-6)
   * @returns {string} Markdown heading
   * @private
   */
  _heading(text, level) {
    const hashes = '#'.repeat(level);
    return `${hashes} ${text}`;
  }

  /**
   * Render ContextBuilder data as plain text with section metadata
   * @param {import('../context-builder.js').ContextBuilder} builder - ContextBuilder instance with assembled data
   * @returns {Promise<{text: string, sections: ContextSection[]}>} Rendered text with section metadata
   */
  async renderTextWithSections(builder) {
    /** @type {ContextSection[]} */
    const sections = [];
    /** @type {string[]} */
    const parts = [];
    let currentOffset = 0;

    /**
     * Helper to add a section and track offset
     * @param {string} type
     * @param {string} label
     * @param {string} content
     * @param {string} [role]
     * @param {number} [itemIndex]
     */
    const addSection = (type, label, content, role = undefined, itemIndex = undefined) => {
      const startOffset = currentOffset;
      parts.push(content);
      const length = content.length;
      /** @type {ContextSection} */
      const section = { type, label, offset: startOffset, length };
      if (role) {
        section.role = role;
      }
      if (itemIndex !== undefined) {
        section.itemIndex = itemIndex;
      }
      sections.push(section);
      currentOffset += length;
    };

    // 1. System Prompt
    const systemPrompt = await builder.getSystemPrompt();
    if (systemPrompt) {
      addSection('system', 'System Prompt', systemPrompt);
      addSection('separator', '', '\n---\n');
    }

    // 2. Prepare context to get rendered messages
    // Skip validation for UI preview - show what we can even with pending actions
    const { messages } = await builder.prepare({ skipPendingValidation: true });

    // 3. Separate context item tool-results from other messages
    // Context item content is now in tool-result messages with contextItemId
    const contextItemToolResults = messages.filter(msg => {
      if (!isToolResultMessage(msg)) return false;
      return !!msg.contextItemId;
    });
    const conversationMessages = messages.filter(msg =>
      isUserMessage(msg) || isAssistantMessage(msg) || isToolResultMessage(msg) ||
			isThinkingMessage(msg) || isToolUseMessage(msg)
    );

    // 4. Context Items Section
    const itemsHeader = '\n' + this._heading('Current Context Items', 2) + '\n';
    addSection('context-items-header', 'Current Context Items', itemsHeader);

    if (contextItemToolResults.length === 0) {
      addSection('context-items-empty', '(No active context items)', '(No active context items)');
    } else {
      let itemIndex = 0;
      for (const ciMsg of contextItemToolResults) {
        const typedMsg = /** @type {import('../../../sdk/lib/message.js').ToolResultMessage} */ (ciMsg);
        const itemId = typedMsg.contextItemId;
        if (!itemId) continue;

        const contextItem = builder.messageThread.getContextItem(itemId);
        if (contextItem) {
          // Get rendered content from the tool-result (already rendered by prepare())
          const itemContent = typedMsg.content || '';
          const itemLabel = contextItem.getTitle ? contextItem.getTitle() : itemId;
          addSection('context-item', itemLabel, `\n${itemContent}\n`, undefined, itemIndex);
        }
        itemIndex++;
      }
    }

    // 5. Conversation History
    if (conversationMessages.length > 0) {
      const conversationHeader = '\n' + this._heading('Conversation History', 2) + '\n';
      addSection('conversation-header', 'Conversation History', conversationHeader);

      conversationMessages.forEach((msg, index) => {
        let messageContent = '';

        if (isUserMessage(msg)) {
          messageContent = `\nUser: ${msg.content || ''}\n`;
          addSection('conversation-message', `Message ${index + 1} (user)`, messageContent, 'user');
        } else if (isAssistantMessage(msg)) {
          messageContent = `\nAssistant: ${msg.content || ''}\n`;
          addSection('conversation-message', `Message ${index + 1} (assistant)`, messageContent, 'assistant');
        } else if (isThinkingMessage(msg)) {
          messageContent = `\n<thinking>${msg.content || ''}</thinking>\n`;
          addSection('conversation-message', `Message ${index + 1} (thinking)`, messageContent, 'assistant');
        } else if (isToolUseMessage(msg)) {
          const toolInput = JSON.stringify(msg.toolInput, null, 2);
          messageContent = `\n<tool_use name="${msg.toolName}">\n${toolInput}\n</tool_use>\n`;
          addSection('conversation-message', `Message ${index + 1} (tool-use: ${msg.toolName})`, messageContent, 'assistant');
        } else if (isToolResultMessage(msg)) {
          const resultType = msg.isError ? 'error' : 'result';
          messageContent = `\n<tool_result type="${resultType}">\n${msg.content || ''}\n</tool_result>\n`;
          addSection('conversation-message', `Message ${index + 1} (tool-result)`, messageContent, 'tool-result');
        }
      });
    }

    return {
      text: parts.join(''),
      sections: sections.filter((s) => s.type !== 'separator'), // Filter separators from nav
    };
  }
}
