//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import actionExecutor from './action-executor.js';
import { generateToolDefinitions, getBlockedToolReason, resolveToolName } from './tool-generator.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { extractErrorInfo, extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { createContextWriter } from './context-writer.js';
import { buildApprovalButtons } from './approval-options.js';
import { RESULT_TYPES, ACTION_STATES, TOOL_STATES } from '../../sdk/lib/message.js';
import { INTERACTION_KIND } from '../../sdk/context-item.js';
import { hashString } from '../utils/hash.js';
import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';
import toolExecutor from './tool-executor.js';
import workerManager from './worker-manager.js';
import wsService from './websocket.js';
import { APPROVAL_POLICY } from 'juggler/strategy-type';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('./action-executor.js').ActionStatus} ActionStatus
 */

/**
 * @typedef {object} ContextItemResult
 * @property {string} itemId - Context item ID that was used
 * @property {string} [toolUseId] - Tool use ID from LLM
 * @property {boolean} success - Whether context item execution succeeded
 * @property {object} [result] - Context item result details
 * @property {string} [summary] - Context item summary
 * @property {string} [error] - Error message if failed
 */

/**
 * Result status for tool execution - matches backend ResultStatus type.
 * @typedef {'success' | 'error' | 'cancelled'} ResultStatus
 */

/**
 * @typedef {object} ToolExecutionResult
 * @property {string} toolName - Name of the tool that was executed
 * @property {boolean} success - Whether the tool executed successfully
 * @property {ResultStatus} resultStatus - Outcome status (success, error, cancelled)
 * @property {unknown} [result] - Tool-specific result details (for UI/debugging)
 * @property {string} [content] - Human-readable result content for LLM (preferred over JSON.stringify of result)
 */

/**
 * Result returned by tool executor functions (internal to ResponseHandler)
 * @typedef {object} ToolExecutorResult
 * @property {boolean} success - Whether the tool executed successfully
 * @property {ResultStatus} resultStatus - Outcome status (success, error, cancelled)
 * @property {string} content - Message content for LLM
 * @property {ToolExecutorMetadata} metadata - Event metadata
 * @property {unknown} [data] - Tool-specific result data
 */

/**
 * Metadata for tool executor results
 * @typedef {object} ToolExecutorMetadata
 * @property {string} [resultType] - Override result type (e.g., 'drop', 'strategy-tool')
 * @property {string} [actionId] - Action ID for action tools
 * @property {string} [itemId] - Context item ID for context item tools
 * @property {string} [itemType] - Context item type for context item tools
 * @property {string} [strategyId] - Strategy ID for strategy tools
 * @property {string} [toolName] - Tool name
 * @property {string[]} [itemIds] - Context item IDs for drop operations
 * @property {object|unknown} [fullResult] - Full result object for UI
 * @property {boolean} [includeInConversation] - Whether to include in LLM context
 */


/**
 * ResponseHandler
 *
 * Handles LLM response processing with clear separation of concerns.
 * Breaks down complex response handling into focused methods.
 *
 * Each conversation owns its own ResponseHandler instance.
 * @class
 */
class ResponseHandler {
  /**
   * @param {object} options - Configuration options
   * @param {import('../model/conversation.js').default} options.conversation - Conversation instance
   */
  constructor(options) {
    /** @type {import('../model/conversation.js').default} @private */
    this._conversation = options.conversation;
  }

  /**
   * Get the conversation instance (used by ToolExecutor for tool routing).
   * @returns {import('../model/conversation.js').default} The conversation instance
   */
  get conversation() {
    return this._conversation;
  }

  // ========== STRATEGY PRIMITIVE SUPPORT ==========

  /**
   * Execute tool calls and return outcomes (for strategy.executeTools primitive).
   * Delegates to ToolExecutor for routing and execution coordination.
   * @param {Array<{id: string, name: string, input: object}>} toolCalls - Tool calls to execute
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @param {Array<{name: string, category?: string}>} [toolDefinitions] - Tool definitions for category lookup (includes strategy-provided tools)
   * @returns {Promise<import('juggler/strategy-type').ToolOutcome[]>} Outcomes for each tool
   */
  async executeToolCalls(toolCalls, messageThread, toolDefinitions) {
    return toolExecutor.executeToolCalls(toolCalls, this, messageThread, { toolDefinitions });
  }

  // ========== TOOL EXECUTOR API ==========
  // These public methods are called by ToolExecutor for actual tool execution.
  // ToolExecutor handles routing; ResponseHandler handles execution and messages.

  /**
   * Execute a context item tool. Called by ToolExecutor.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {{itemType: string, class: unknown}} itemDetails - Context item details from registry
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutionResult>} Execution result
   */
  async executeContextItem(toolCall, itemDetails, messageThread) {
    return this._executeToolWithEvent(toolCall, 'context-item', messageThread, (ctx) => this._doContextItemTool(itemDetails, toolCall, ctx, messageThread));
  }

  /**
   * Execute a built-in meta tool. Called by ToolExecutor.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutionResult>} Execution result
   */
  async executeMetaTool(toolCall, messageThread) {
    return this._executeToolWithEvent(toolCall, 'meta-tool', messageThread, (ctx) => this._doMetaTool(toolCall, ctx, messageThread));
  }

  // ========== END TOOL EXECUTOR API ==========

  /**
   * Validate tool calls without executing them.
   * Checks tool existence, blocked status, and parameter validity.
   * @param {Array<{id: string, name: string, input: object}>} toolCalls - Tool calls to validate
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {Array<{name: string, category?: string, input_schema?: object}>} [toolDefinitions] - Tool definitions
   * @returns {Promise<import('juggler/strategy-type').ToolsValidationResult>} Validation results
   */
  async validateToolCalls(toolCalls, messageThread, toolDefinitions) {
    // Empty input is valid
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return { allValid: true, results: [], hasLLMErrors: false };
    }

    // Get all tool definitions to determine categories and schemas
    const allTools = await generateToolDefinitions();
    /** @type {Map<string, string>} */
    const toolCategories = new Map(allTools.map((/** @type {any} */ t) => [t.name, t.category]));
    /** @type {Map<string, object>} */
    const toolSchemas = new Map(allTools.map((/** @type {any} */ t) => [t.name, t.input_schema]));

    // Include strategy-provided tools
    if (toolDefinitions) {
      for (const t of toolDefinitions) {
        if (t.name) {
          if (t.category && !toolCategories.has(t.name)) {
            toolCategories.set(t.name, t.category);
          }
          if (t.input_schema && !toolSchemas.has(t.name)) {
            toolSchemas.set(t.name, t.input_schema);
          }
        }
      }
    }

    // Validate each tool call
    /** @type {import('juggler/strategy-type').ToolValidationResult[]} */
    const results = await Promise.all(toolCalls.map(async (tc) => {
      // Check malformed
      if (!tc || typeof tc !== 'object') {
        return { toolId: '', toolName: '', valid: false, errorType: /** @type {const} */ ('malformed'), error: 'Tool call is not an object' };
      }
      if (!tc.name || typeof tc.name !== 'string') {
        return { toolId: tc.id || '', toolName: '', valid: false, errorType: /** @type {const} */ ('malformed'), error: 'Missing or invalid tool name' };
      }
      if (!tc.id || typeof tc.id !== 'string') {
        return { toolId: '', toolName: tc.name, valid: false, errorType: /** @type {const} */ ('malformed'), error: 'Missing or invalid tool id' };
      }
      if (tc.input === undefined || tc.input === null || typeof tc.input !== 'object') {
        return { toolId: tc.id, toolName: tc.name, valid: false, errorType: /** @type {const} */ ('malformed'), error: 'Missing or invalid tool input' };
      }

      // Resolve aliases (e.g., 'Bash' -> 'bash') for backwards compatibility
      const resolvedName = resolveToolName(tc.name);
      const category = toolCategories.get(resolvedName);

      // Check unknown tool
      if (!category) {
        const blockedReason = getBlockedToolReason(resolvedName);
        if (blockedReason) {
          return { toolId: tc.id, toolName: tc.name, valid: false, errorType: /** @type {const} */ ('blocked_tool'), error: blockedReason };
        }
        return { toolId: tc.id, toolName: tc.name, valid: false, errorType: /** @type {const} */ ('unknown_tool'), error: `Unknown tool: ${tc.name}` };
      }

      // Validate against schema required fields
      const schema = toolSchemas.get(resolvedName);
      if (schema && /** @type {any} */ (schema).required) {
        const required = /** @type {string[]} */ (/** @type {any} */ (schema).required);
        for (const field of required) {
          if (!(field in tc.input)) {
            return { toolId: tc.id, toolName: tc.name, valid: false, errorType: /** @type {const} */ ('invalid_params'), error: `Missing required parameter: ${field}` };
          }
        }
      }

      // For action tools, also validate via prepareParameters
      if (category === 'write') {
        const itemDetails = this._findContextItemForTool(resolvedName);
        if (!itemDetails) {
          // It's an action - validate params
          const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName(resolvedName));
          if (!ActionClass) {
            const blockedReason = getBlockedToolReason(resolvedName);
            return {
              toolId: tc.id,
              toolName: tc.name,
              valid: false,
              errorType: blockedReason ? /** @type {const} */ ('blocked_tool') : /** @type {const} */ ('unknown_tool'),
              error: blockedReason || `Unknown action: ${tc.name}`
            };
          }

          const action = new ActionClass({
            id: ActionClass.MANIFEST.id,
            session: this._conversation.session,
            conversation: this._conversation,
            messageThread
          });
          const prepared = await action.prepare(tc.input);
          if (!prepared.valid) {
            return { toolId: tc.id, toolName: tc.name, valid: false, errorType: /** @type {const} */ ('invalid_params'), error: prepared.error || 'Validation failed' };
          }
        }
      }

      return { toolId: tc.id, toolName: tc.name, valid: true, errorType: null };
    }));

    const allValid = results.every(r => r.valid);

    return {
      allValid,
      results,
      hasLLMErrors: !allValid
    };
  }

  // ========== CENTRALIZED TOOL EXECUTION WRAPPER ==========

  /**
   * Execute a tool with guaranteed event emission.
   * CRITICAL INVARIANT: Tool-use and tool-result messages are ALWAYS added
   * synchronously with NO async calls between them. This ensures they remain
   * adjacent in the conversation items array, with nothing inserted between.
   * Pattern: 1) Add tool-use, 2) Add tool-result (running state), 3) Execute,
   * 4) Update tool-result in place with final result.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call object
   * @param {string} resultType - Type for metadata: 'meta-tool', 'context-item', 'action', 'strategy-tool', 'drop'
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {(ctx: import('./context-writer.js').ContextWriter) => Promise<ToolExecutorResult>} executor - Async function that executes the tool, receives ContextWriter
   * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
   * @private
   */
  async _executeToolWithEvent(toolCall, resultType, messageThread, executor) {
    // This method handles context item tools and meta tools.
    // Actions use executeAction which adds tool-use/tool-result pairs.
    //
    // For context items: We do NOT add tool-use/tool-result because they are represented by
    // context-item messages (added by conversation.executeContextItem), not tool-use/result pairs.
    // Context items appear in the context panel, not as tool invocations in conversation.
    //
    // For meta tools (drop_context_items): We add tool-use + tool-result pairs
    // because tool-use is skipped in handleResponse (to be added here with tool-result).

    try {
      // Create ContextWriter for plugin to add messages
      const ctx = createContextWriter(messageThread);
      const result = await executor(ctx);

      // Check if plugin used ContextWriter - if so, skip auto-add
      const ctxHandled = ctx.handled;

      // Extract content for both UI message and return value
      const content = typeof result.content === 'string'
        ? result.content
        : extractErrorMessage(result.content) || 'Tool executed.';

      // DOCUMENT-DRIVEN FLOW: Worker created the tool-action item.
      // We just need to update it with the result via completeToolAction.
      // Check if this result should be included in conversation (tool-action message)
      // Context items set includeInConversation=false because they're rendered separately by ContextBuilder
      const shouldIncludeInConversation = result.metadata?.includeInConversation !== false;

      if (!ctxHandled && shouldIncludeInConversation) {
        // Update existing tool-action created by worker
        const itemId = result.metadata?.itemId;

        // For context item tools, render full content and compute hash for cache optimization
        // This enables OpenAI prefix caching by keeping context items at stable positions
        let toolResultContent = content;
        /** @type {number|undefined} */
        let contentHash;
        if (itemId) {
          const contextItem = messageThread.getContextItem(itemId);
          if (!contextItem) {
            throw new Error(`Context item ${itemId} not found in message thread after tool result`);
          }
          // Get rendered content from context item
          const contextParams = {
            contextWindowSize: 0,
            modelConfig: this._conversation.modelConfig || null,
            helpers: FormattingHelpers
          };
          const renderedContent = await contextItem.getContextText(contextParams);
          toolResultContent = typeof renderedContent === 'string'
            ? renderedContent
            : JSON.stringify(renderedContent);
          contentHash = hashString(toolResultContent);
        }

        // Update existing tool-action with result
        // Note: itemId is already set on the message by the worker, not on the result
        messageThread.completeToolAction(toolCall.id, {
          content: toolResultContent,
          isError: !result.success,
          resultType: resultType,
          fullResult: /** @type {import('../../sdk/lib/message.js').ActionFullResult|undefined} */ (result.metadata?.fullResult),
          lastContentHash: contentHash
        });
      }

      return {
        toolName: toolCall.name,
        success: result.success,
        resultStatus: result.resultStatus,
        result: result.data,
        content: content
      };
    } catch (error) {
      const { message, stack } = extractErrorInfo(error);
      // DOCUMENT-DRIVEN FLOW: Update existing tool-action created by worker
      // (Without this, the conversation is unchanged and LLM will retry the same thing)
      const errorContent = `Error: ${message}`;
      if (stack) console.error(`[ResponseHandler] Tool error stack:\n${stack}`);
      messageThread.completeToolAction(toolCall.id, {
        content: errorContent,
        isError: true,
        resultType: resultType,
        fullResult: { state: 'error', success: false, error: message }
      });

      return {
        toolName: toolCall.name,
        success: false,
        resultStatus: /** @type {ResultStatus} */ ('error'),
        result: { error: message },
        content: errorContent
      };
    }
  }

  // ========== END CENTRALIZED WRAPPER ==========

  /**
   * Process drop commands
   * @param {Array<{itemIds: string[], rawMatch?: string}>} drops - Drop commands to process
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @private
   */
  _processDrops(drops, messageThread) {
    /** @type {string[]} */
    const allDroppedIds = [];

    drops.forEach(drop => {
      drop.itemIds.forEach(id => {
        const contextItem = messageThread.getContextItem(id);

        if (!contextItem) {
          console.warn(`[ESSENTIAL] [ResponseHandler] Context item not found for drop: ${id}`);
          return;
        }

        messageThread.removeContextItem(id);
        allDroppedIds.push(id);
      });
    });

    // Log dropped context items for debugging.
    if (allDroppedIds.length > 0) {
      console.log(`[ResponseHandler] Context items dropped: ${allDroppedIds.join(', ')}`);
    }
  }

  /**
   * Execute a meta tool (drop_context_items, or strategy-specific tools).
   * Returns ToolExecutorResult - wrapper handles event emission and exceptions.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('./context-writer.js').ContextWriter} _ctx - ContextWriter for adding messages
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutorResult>} Result for wrapper to emit as event
   * @private
   */
  async _doMetaTool(toolCall, _ctx, messageThread) {
    /** @type {any} */
    const input = toolCall.input;

    // ========== BUILT-IN META TOOLS ==========
    if (toolCall.name === 'drop_context_items' && input && input.itemIds) {
      // Ensure itemIds is an array (could be JSON string from some providers)
      let itemIds = input.itemIds;
      if (typeof itemIds === 'string') {
        try {
          itemIds = JSON.parse(itemIds);
        } catch (e) {
          // If parse fails, treat as single item ID
          itemIds = [itemIds];
        }
      }
      if (!Array.isArray(itemIds)) {
        // Wrap single item ID in array (defensive coding)
        itemIds = [itemIds];
      }

      const drops = [{
        itemIds: itemIds,
        rawMatch: '(from drop_context_items tool)'
      }];
      this._processDrops(drops, messageThread);

      const itemCount = itemIds.length;
      return {
        success: true,
        resultStatus: /** @type {ResultStatus} */ ('success'),
        content: `Successfully dropped ${itemCount} context item${itemCount !== 1 ? 's' : ''}.`,
        metadata: {
          resultType: RESULT_TYPES.DROP,
          itemIds: itemIds
        },
        data: input
      };
    }

    // Strategy-provided tools (if a strategy adds any) are handled in
    // strategy.executeTools() before reaching the response handler.

    // No handler found - unknown meta tool
    return {
      success: false,
      resultStatus: /** @type {ResultStatus} */ ('error'),
      content: `Unknown meta tool: ${toolCall.name}`,
      metadata: {
        resultType: RESULT_TYPES.META_TOOL,
        toolName: toolCall.name,
        fullResult: { success: false, error: `Unknown meta tool: ${toolCall.name}` }
      },
      data: { error: `Unknown meta tool: ${toolCall.name}` }
    };
  }

  /**
   * Create error result for an unknown tool with user feedback. Called by
   * ToolExecutor. Adds tool-use and tool-result messages to show the error in UI.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call that failed
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {ToolExecutionResult} Error result
   */
  createUnknownToolResult(toolCall, messageThread) {
    const errorMsg = `Unknown tool: "${toolCall.name}". This tool is not registered with any handler.`;
    // DOCUMENT-DRIVEN FLOW: Update existing tool-action created by worker
    messageThread.completeToolAction(toolCall.id, {
      content: errorMsg,
      isError: true,
      resultType: RESULT_TYPES.META_TOOL,
      fullResult: { success: false, error: errorMsg, unknownTool: true }
    });

    return {
      toolName: toolCall.name,
      success: false,
      resultStatus: /** @type {ResultStatus} */ ('error'),
      result: errorMsg
    };
  }

  /**
   * Execute a context item-provided tool.
   * Returns ToolExecutorResult - wrapper handles event emission and exceptions.
   * @param {{itemType: string, class: unknown}} itemDetails - Context item details from registry
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('./context-writer.js').ContextWriter} ctx - ContextWriter for adding messages
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutorResult>} Result for wrapper to emit as event
   * @private
   */
  async _doContextItemTool(itemDetails, toolCall, ctx, messageThread) {
    const itemResult = await this._executeContextItemToolCall(itemDetails, toolCall, ctx, messageThread);

    const content = itemResult?.message || (itemResult?.success ? 'Context item updated successfully.' : 'Context item update failed.');
    /** @type {ResultStatus} */
    const resultStatus = itemResult?.success ? 'success' : 'error';

    return {
      success: itemResult?.success ?? true,
      resultStatus,
      content: content,
      metadata: {
        resultType: RESULT_TYPES.CONTEXT,
        itemType: itemDetails.itemType,
        itemId: itemResult?.itemId,
        includeInConversation: itemResult?.includeInConversation ?? false,
        fullResult: itemResult?.result
      },
      data: itemResult
    };
  }

  /**
   * Execute an action tool with declarative state-driven pattern. Called by
   * ToolExecutor. Message state drives UI rendering - NO DOM manipulation here.
   * States: waiting_for_approval → running → completed/cancelled/error
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {{onApproved?: () => void}} [outerOptions] - Callbacks
   * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
   */
  async executeAction(toolCall, messageThread, outerOptions = {}) {
    const toolInput = /** @type {Record<string, unknown>} */ (toolCall.input || {});

    // Common tool-use data for all exit paths
    const toolUseData = { toolUseId: toolCall.id, toolName: toolCall.name, toolInput };

    // Wrap entire function in try-catch to ensure loop continues on any error
    try {
      return await this._executeActionCore(toolCall, toolInput, toolUseData, messageThread, { onApproved: outerOptions.onApproved });
    } catch (error) {
      // Catch any uncaught errors and return a result that continues the loop
      const { message, stack } = extractErrorInfo(error);
      // DOCUMENT-DRIVEN FLOW: Update existing tool-action created by worker
      const errorContent = `Error: ${message}`;
      if (stack) console.error(`[ResponseHandler] Action error stack:\n${stack}`);
      messageThread.completeToolAction(toolCall.id, {
        content: errorContent,
        isError: true,
        resultType: RESULT_TYPES.ACTION,
        fullResult: { state: ACTION_STATES.ERROR, success: false, error: message }
      });

      return {
        toolName: toolCall.name,
        success: false,
        resultStatus: /** @type {ResultStatus} */ ('error'),
        result: { error: errorContent }
      };
    }
  }

  /**
   * Build approval options from action and prepared parameters.
   * Public for use by session.js worker flow.
   * @param {any} action - Action instance
   * @param {any} prepared - Prepared parameters from action.prepareParameters()
   * @returns {import('../components/action-confirmation.js').ActionConfirmationOptions} Approval options
   */
  buildApprovalOptions(action, prepared) {
    const manifest = action.getManifest();
    const approval = prepared.approval || {};

    // A plugin can supply a fully custom button set via getApprovalConfig;
    // honour it verbatim. Otherwise build the standard, plugin-driven set
    // (Yes, one "Don't Ask Again" per suggestion, No) — see buildApprovalButtons.
    const options = approval.options || buildApprovalButtons(action, prepared.params || {});

    return {
      title: approval.title || `Approve: ${manifest.name}`,
      message: approval.message || '',
      options,
      ...approval.display // Extra display data (diffs, previews, etc.)
    };
  }

  /**
   * Core action execution logic - handles both approval and non-approval paths.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @param {{toolUseId: string, toolName: string, toolInput: Record<string, unknown>}} toolUseData - Common tool-use data
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {{isRetry?: boolean, existingApprovalOptions?: import('../components/action-confirmation.js').ActionConfirmationOptions, onApproved?: () => void}} [options] - Options for retry flow
   * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
   * @private
   */
  async _executeActionCore(toolCall, toolInput, toolUseData, messageThread, options = {}) {
    const { existingApprovalOptions, onApproved } = options;

    const prep = await this._prepareAction(toolCall, toolInput, messageThread);
    if (prep.result) return prep.result;
    const { ActionClass, action, actionId, prepared, resolvedName } = prep;

    const needsApproval = this._determineApprovalNeeded(
      toolCall, toolInput, resolvedName, ActionClass, action, messageThread, existingApprovalOptions
    );

    if (needsApproval) {
      const approvalOutcome = await this._handleApprovalFlow(
        toolCall, action, prepared, messageThread, existingApprovalOptions
      );
      if (approvalOutcome) return approvalOutcome;
    }

    // Signal that the tool is now running (approval complete or not needed).
    // Allows the server to start its execution timeout from this point.
    onApproved?.();

    return this._runActionAndComplete(toolCall, actionId, toolInput, messageThread);
  }

  /**
   * Resolve the action class and prepare its parameters. Returns `{result}`
   * to short-circuit (unknown/blocked tool or invalid params — after updating
   * the tool-action with the error), otherwise the prepared action context.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {Promise<{result: ToolExecutionResult} | {result?: undefined, ActionClass: any, action: any, actionId: string, prepared: any, resolvedName: string}>} Short-circuit result or prepared action context
   * @private
   */
  async _prepareAction(toolCall, toolInput, messageThread) {
    // ========== 1. GET ACTION CLASS ==========
    // Resolve aliases (e.g., 'Bash' -> 'bash') for registry lookup
    const resolvedName = resolveToolName(toolCall.name);
    const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName(resolvedName));
    if (!ActionClass) {
      const blockedReason = getBlockedToolReason(resolvedName);
      const errorMessage = blockedReason
        ? `Tool "${toolCall.name}" is not available: ${blockedReason}`
        : `Unknown action: ${toolCall.name}`;

      // DOCUMENT-DRIVEN FLOW: Worker created tool-action, we update it with error
      messageThread.completeToolAction(toolCall.id, {
        content: errorMessage,
        isError: true,
        resultType: RESULT_TYPES.ACTION,
        fullResult: { state: ACTION_STATES.ERROR, success: false, error: errorMessage, blocked: !!blockedReason }
      });

      return {
        result: {
          toolName: toolCall.name,
          success: false,
          resultStatus: /** @type {ResultStatus} */ ('error'),
          result: { error: errorMessage, blocked: !!blockedReason }
        }
      };
    }
    const actionId = ActionClass.MANIFEST.id;

    // ========== 2. CREATE ACTION AND PREPARE PARAMETERS ==========
    const action = new ActionClass({
      id: actionId,
      session: this._conversation.session,
      conversation: this._conversation,
      messageThread,
      toolName: resolvedName  // Lets a multi-tool class route validate/approval to the invoked tool
    });

    const prepared = await action.prepare(toolInput);

    if (!prepared.valid) {
      const errorMessage = prepared.error || 'Validation failed';

      // DOCUMENT-DRIVEN FLOW: Worker created tool-action, we update it with error
      messageThread.completeToolAction(toolCall.id, {
        content: errorMessage,
        isError: true,
        resultType: RESULT_TYPES.ACTION,
        fullResult: { state: ACTION_STATES.ERROR, success: false, error: errorMessage, actionId }
      });

      return {
        result: {
          toolName: toolCall.name,
          success: false,
          resultStatus: /** @type {ResultStatus} */ ('error'),
          result: { error: errorMessage }
        }
      };
    }

    return { ActionClass, action, actionId, prepared, resolvedName };
  }

  /**
   * Determine whether this action requires user approval, consulting the
   * action's own policy and the strategy's master approval policy.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @param {string} resolvedName - Alias-resolved tool name
   * @param {any} ActionClass - Resolved action class
   * @param {any} action - Action instance
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {import('../components/action-confirmation.js').ActionConfirmationOptions} [existingApprovalOptions] - Approval options from an existing tool-use message (retry)
   * @returns {boolean} Whether approval is needed
   * @private
   */
  _determineApprovalNeeded(toolCall, toolInput, resolvedName, ActionClass, action, messageThread, existingApprovalOptions) {
    // ========== 3. CHECK IF APPROVAL NEEDED ==========
    // Check if this is a retry (already has approval options)
    const isRetry = !!existingApprovalOptions;
    const defaultApproval = isRetry || (action.requiresApproval() && !action.isPermitted(toolInput));

    // Consult strategy approval policy (strategy has master control)
    const toolDefs = ActionClass.getToolDefinitions?.() || [];
    const toolDef = toolDefs.find((/** @type {{name: string}} */ t) => t.name === resolvedName);
    const strategyPolicy = messageThread.strategy?.getApprovalPolicy?.({
      toolName: toolCall.name,
      toolInput,
      category: toolDef?.category,
      defaultApproval
    });

    let needsApproval;
    if (strategyPolicy === APPROVAL_POLICY.APPROVE) {
      needsApproval = false;
    } else if (strategyPolicy === APPROVAL_POLICY.REQUIRE_APPROVAL) {
      needsApproval = true;
    } else {
      needsApproval = defaultApproval;
    }
    return needsApproval;
  }

  /**
   * Run the approval path: wait for user approval if needed, then either
   * short-circuit (rejection, or an already-executed result) or fall through
   * to execution.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {any} action - Action instance
   * @param {any} prepared - Prepared parameters from action.prepare()
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {import('../components/action-confirmation.js').ActionConfirmationOptions} [existingApprovalOptions] - Approval options from an existing tool-use message (retry)
   * @returns {Promise<ToolExecutionResult|null>} Result to return, or null to continue to execution
   * @private
   */
  async _handleApprovalFlow(toolCall, action, prepared, messageThread, existingApprovalOptions) {
    // ========== 4. HANDLE APPROVAL PATH ==========
    // Check if approval is already done (observer flow - called after user approved)
    const existingAction = messageThread.getToolAction(toolCall.id);
    const existingState = existingAction?.get('state');
    const approvalAlreadyDone = existingState === TOOL_STATES.APPROVED ||
                                      existingState === TOOL_STATES.RUNNING ||
                                      existingState === TOOL_STATES.COMPLETED ||
                                      existingState === TOOL_STATES.CANCELLED;

    let approvalResult = 'yes';  // Default for already-approved case

    if (!approvalAlreadyDone) {
      // Need to wait for user approval
      const approvalOptions = existingApprovalOptions || this.buildApprovalOptions(action, prepared);

      // DOCUMENT-DRIVEN FLOW: For retries, approval state is already set by observer.
      // For initial execution, observer's handleNewToolAction sets state to 'pending'.
      // Create promise BEFORE updating message (prevents race condition)
      // waitForApproval polls message state - no options needed (they're on the message)
      const approvalPromise = messageThread.waitForApproval(toolCall.id);

      // Update existing tool-action with approval options (both first-time and retry)
      // Worker created the item, we add the UI-specific approval options
      workerManager.updateToolActionForRetry(
        this._conversation.id,
        toolCall.id,
        approvalOptions,
        prepared.displayData
      );

      approvalResult = await approvalPromise;
    } else if (existingState === TOOL_STATES.CANCELLED) {
      approvalResult = 'cancel';
    }

    // resolveApproval already executed/added tool-result for all cases
    // We just need to read the result and return

    // Handle rejection (no or cancel) - both use 'cancelled' now
    if (approvalResult === 'no' || approvalResult === 'cancel') {
      return {
        toolName: toolCall.name,
        success: false,
        resultStatus: /** @type {ResultStatus} */ ('cancelled'),
        result: { cancelled: true }
      };
    }

    // Check if tool-action already exists (approval path creates it)
    // CRITICAL: Check existence first to prevent duplication bug
    const existingToolAction = messageThread.getToolAction(toolCall.id);

    if (existingToolAction) {
      // Tool-action already exists from approval flow
      // Check if already executed (result set with actual content)
      // Note: Yjs sync can result in {} when result is unset, so check for content
      const existingResult = existingToolAction.get('result');
      const hasRealResult = existingResult !== null &&
                  existingResult !== undefined &&
                  (existingResult.get?.('content') !== undefined ||
                   existingResult.get?.('cancelled') === true);
      if (hasRealResult) {
        // Already executed by resolveApproval - return result
        const result = existingResult.toJSON ? existingResult.toJSON() : existingResult;

        return {
          toolName: toolCall.name,
          success: !result.isError,
          resultStatus: result.isError
            ? /** @type {ResultStatus} */ ('error')
            : /** @type {ResultStatus} */ ('success'),
          content: result.content,
          result: result.fullResult
        };
      }

      // Exists but not executed yet (approval just resolved)
      // Fall through to execution - don't create duplicate
    }
    // Tool-action was already created when approval was requested, but Yjs sync
    // delay can make getToolAction() return undefined. DO NOT create a duplicate
    // here — just fall through to execution.
    return null;
  }

  /**
   * Fold an elicitation tool's captured answer (its approval response) into the
   * tool input before execution. A gate tool's approval response is a bare
   * verdict carrying no data, so it passes through unchanged.
   *
   * Kind-driven, not name-driven: the tool declares `interaction: 'elicitation'`
   * and owns the parse via its static `applyApprovalResponse` — there is no
   * per-tool special-casing here.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {Record<string, unknown>} Final tool input for execution
   * @private
   */
  _resolveFinalToolInput(toolCall, toolInput, messageThread) {
    const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolCall.name));
    if (ActionClass?.interactionKind?.() !== INTERACTION_KIND.ELICITATION) {
      return toolInput;
    }
    const approvalResponse = messageThread.getToolAction(toolCall.id)?.get('approvalResponse');
    if (!approvalResponse) return toolInput;
    return ActionClass.applyApprovalResponse(toolInput, approvalResponse);
  }

  /**
   * Execute the action and update the tool-action with the final result,
   * handling the success, cancellation (no Yjs write), and error paths.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {string} actionId - Resolved action manifest id
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
   * @private
   */
  async _runActionAndComplete(toolCall, actionId, toolInput, messageThread) {
    // ========== 6. EXECUTE ACTION (SHARED - NO DUPLICATION!) ==========
    try {
      const finalToolInput = this._resolveFinalToolInput(toolCall, toolInput, messageThread);

      const result = await actionExecutor.execute(
        actionId,
        finalToolInput,
        {
          session: this._conversation.session,
          conversation: this._conversation,
          messageThread,
          toolUseId: toolCall.id,
          toolName: resolveToolName(toolCall.name),  // route multi-tool classes to the invoked tool
          _approvalHandled: true
        }
      );

      // Build content from result
      let content = typeof result.formatted?.summary === 'string'
        ? result.formatted.summary
        : extractErrorMessage(result.formatted?.summary) || 'Action completed.';
      if (result.formatted?.feedbackForLLM) {
        const feedback = typeof result.formatted.feedbackForLLM === 'string'
          ? result.formatted.feedbackForLLM
          : extractErrorMessage(result.formatted.feedbackForLLM);
        content += '\n\n' + feedback;
      }

      // On cancellation, do NOT write to the Yjs doc. The Go worker
      // is the sole writer of cancellation state (via CancelStaleToolActions
      // in the strategy loop defer). Having the frontend also write creates
      // a CRDT merge conflict that can overwrite a rerun's state='approved'
      // back to 'cancelled', causing an infinite restart loop.
      if (result.cancelled) {
        // Diagnostic breadcrumb: this is the one exit that leaves the
        // tool-action without a result on purpose. If the worker isn't
        // about to stamp 'cancelled' (e.g. a rerun whose execution got
        // spuriously aborted), the tool wedges at running-with-no-result
        // — surface the decision on every viewer's tape.
        wsService.sendEngineBridge('juggler-tool-exec', {
          toolUseId: toolCall.id,
          toolName: toolCall.name,
          conversationId: /** @type {any} */ (this._conversation)?.id,
          phase: 'cancelled-no-write'
        });
        return {
          toolName: toolCall.name,
          success: false,
          resultStatus: /** @type {ResultStatus} */ ('cancelled'),
          content,
          result: result.result
        };
      }

      // Determine state
      let state = 'completed';
      if (!result.success) {
        state = 'error';
      }

      // Extract llmFeedback if present
      const resultData = /** @type {{llmFeedback?: string}} */ (result.result);
      const llmFeedback = resultData?.llmFeedback;

      // Strip large arrays from result: UI renders `content` (same as the LLM
      // sees), so duplicating them in fullResult is wasted storage.
      const minimalResult = this._stripLargeArrays(result.result);

      // Update tool-action with final result (summary omitted — redundant with content)
      /** @type {import('../../sdk/lib/message.js').ActionFullResult} */
      const fullResult = {
        state,
        actionId: result.actionId,
        success: result.success,
        result: minimalResult,
        displayData: result.displayData,
        error: result.error,
        llmFeedback,
        durationMs: result.durationMs
      };
      messageThread.completeToolAction(toolCall.id, {
        content,
        isError: !result.success,
        resultType: RESULT_TYPES.ACTION,
        fullResult
      });

      // Determine result status
      /** @type {ResultStatus} */
      let resultStatus = 'success';
      if (!result.success) {
        resultStatus = 'error';
      }

      return {
        toolName: toolCall.name,
        success: result.success,
        resultStatus,
        content,
        result: result.result
      };
    } catch (error) {
      const { message, stack } = extractErrorInfo(error);
      const errorContent = `Error: ${message}`;
      if (stack) console.error(`[ResponseHandler] Action error stack:\n${stack}`);
      messageThread.completeToolAction(toolCall.id, {
        content: errorContent,
        isError: true,
        resultType: RESULT_TYPES.ACTION,
        fullResult: { state: ACTION_STATES.ERROR, success: false, error: message, actionId }
      });

      return {
        toolName: toolCall.name,
        success: false,
        resultStatus: /** @type {ResultStatus} */ ('error'),
        content: errorContent,
        result: { error: message }
      };
    }
  }

  /**
   * Check if a tool is provided by a context item
   * @param {string} toolName - Tool name to check
   * @returns {{itemType: string, class: unknown}|null} Context item details if found, null otherwise
   * @private
   */
  _findContextItemForTool(toolName) {
    const allItems = contextItemRegistry.getAll();
    for (const { class: ItemClass } of allItems) {
      if (ItemClass.getToolDefinitions) {
        const tools = ItemClass.getToolDefinitions();
        if (tools.some((/** @type {{name: string}} */ t) => t.name === toolName)) {
          return {
            itemType: ItemClass.MANIFEST?.id || 'unknown',
            class: ItemClass
          };
        }
      }
    }
    return null;
  }

  /**
   * Execute a context item-provided tool.
   * Always routes through executeContextItem() which handles mergeOrReplace correctly:
   * - For multi-instance items (file-content): creates new item if path differs
   * - For singleton items (todo, plan): reuses existing item
   * - Handles deduplication via mergeOrReplace
   * @param {{itemType: string, class: unknown}} itemDetails - Context item details from _findContextItemForTool
   * @param {any} toolCall - Tool call object
   * @param {import('./context-writer.js').ContextWriter} _ctx - ContextWriter (unused - executeContextItem handles execution)
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<import('juggler/context-item').ToolCallResult>} Result of context item tool call execution
   * @private
   */
  async _executeContextItemToolCall(itemDetails, toolCall, _ctx, messageThread) {
    // Go through executeContextItem which handles mergeOrReplace and calls handleToolCall.
    // This ensures multi-instance items (file-content) create new instances for
    // different content, while singleton items (todo, plan) reuse existing and
    // get their handleToolCall invoked with the correct tool name.
    const result = await messageThread.executeContextItem(
      itemDetails.itemType,
      toolCall.input,
      { toolName: toolCall.name }
    );

    // Check if context item creation/reuse failed
    if (result.error || result.created === false) {
      return {
        success: false,
        shouldContinue: true,
        message: undefined,
        error: result.error || 'Context item creation failed'
      };
    }

    // Get the context item instance (either newly created or reused)
    const targetItem = messageThread.getContextItem(/** @type {string} */ (result.id));
    if (!targetItem) {
      throw new Error(`Context item ${result.id} not found after executeContextItem`);
    }

    // Return result - executeContextItem already called handleToolCall for new items
    // and refreshed for reused items
    return {
      success: true,
      shouldContinue: true,
      includeInConversation: false,
      message: targetItem.getBriefSummary?.() || `Updated ${targetItem.getTitle?.() || result.id}`,
      itemId: result.id || undefined,
      result: targetItem.getToolResult?.() || {}
    };
  }

  /**
   * Strip large arrays from result object for storage efficiency.
   * UI renders `content` (same as the LLM sees), so large data needn't be
   * duplicated in fullResult. Keeps counts and metadata.
   * @param {unknown} result - Raw result from action
   * @returns {unknown} Result with large arrays stripped
   * @private
   */
  _stripLargeArrays(result) {
    if (!result || typeof result !== 'object') {
      return result;
    }

    const stripped = /** @type {Record<string, unknown>} */ ({});
    for (const [key, value] of Object.entries(result)) {
      if (Array.isArray(value) && value.length > 5) {
        // Replace large arrays with count
        stripped[key + 'Count'] = value.length;
      } else {
        stripped[key] = value;
      }
    }
    return stripped;
  }

  /**
   * Execute an action retry - runs the EXACT same flow as first time,
   * just skips creating the tool-use message (it already exists).
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {import('../components/action-confirmation.js').ActionConfirmationOptions} [existingApprovalOptions] - Approval options from the existing tool-use message
   */
  async executeActionRetry(toolCall, messageThread, existingApprovalOptions) {
    const toolInput = /** @type {Record<string, unknown>} */ (toolCall.input || {});
    const toolUseData = { toolUseId: toolCall.id, toolName: toolCall.name, toolInput };

    // Use unified _executeActionCore with isRetry flag
    await this._executeActionCore(toolCall, toolInput, toolUseData, messageThread, {
      isRetry: true,
      existingApprovalOptions
    });
  }
}

export default ResponseHandler;
