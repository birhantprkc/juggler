//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { extractErrorInfo } from '../../sdk/lib/error-utils.js';
import ContextItem from 'juggler/context-item';
import { OpsError } from './ops-api.js';
import wsService from './websocket.js';

/**
 * Class names already warned about an empty success summary, so the advisory
 * fires at most once per context-item type per session rather than per tool call.
 * @type {Set<string>}
 */
const _emptySummaryWarned = new Set();

/**
 * Warn (once per class) when a SUCCESSFUL tool produced an empty getSummary line.
 *
 * This is the observable symptom of the most common context-item authoring
 * mistake: execute() must return RAW result data, which the framework wraps into
 * the outcome `{ success, result, prepared, error }`. getSummary(outcome) must
 * therefore read its data from `outcome.result` — reading `outcome.foo` directly
 * yields `undefined`, so the `summary` (which is BOTH the UI line and the
 * tool_result text the model sees) comes back empty. We detect the empty summary
 * rather than guessing at execute()'s shape, so legitimate results that carry
 * their own `success` field (e.g. shell output) never false-positive.
 * @param {import('juggler/context-item').ItemSummary} rawSummary - getSummary()'s return, pre-validation
 * @param {string} className - the context item class name (for the once-key)
 */
function warnOnEmptySuccessSummary(rawSummary, className) {
  const s = rawSummary && /** @type {any} */ (rawSummary).summary;
  const empty = s === undefined || s === null || s === '' || s === 'undefined';
  if (!empty || _emptySummaryWarned.has(className)) return;
  _emptySummaryWarned.add(className);
  console.warn(
    `[ContextItem] ${className}.getSummary() returned an empty summary for a ` +
    `successful result, so the model receives an empty tool_result. Did you read ` +
    `your data from outcome.result (not outcome directly)? Remember execute() returns ` +
    `RAW data and the framework wraps it as { success, result, prepared, error }. ` +
    `See docs/extension_guide.md (the execute → outcome → getSummary contract).`);
}

/**
 * Base properties shared by all ActionStatus variants
 * @typedef {object} ActionStatusBase
 * @property {string} actionId - Action type ID
 * @property {string} [toolUseId] - Tool use ID from LLM (for protocol compliance)
 * @property {object} [displayData] - UI display context (from prepared.displayData)
 * @property {boolean} [pending] - True if action is pending/running (checked before success is known)
 * @property {boolean} [cancelled] - True if action was cancelled (checked before success is known)
 * @property {object} [result] - Result data (may exist on failure for partial results)
 * @property {number} [durationMs] - How long the action took in milliseconds
 */

/**
 * Successful action status
 * @typedef {ActionStatusBase & {success: true, result: object, formatted: FormattedActionResult, error?: undefined}} ActionStatusSuccess
 */

/**
 * Failed action status - error is REQUIRED (not optional)
 * @typedef {ActionStatusBase & {success: false, error: string, errorStack?: string, formatted?: FormattedActionResult, denied?: boolean, blocked?: boolean}} ActionStatusFailure
 */

/**
 * ActionStatus - discriminated union enforces error field when success=false
 * @typedef {ActionStatusSuccess | ActionStatusFailure} ActionStatus
 */

/**
 * @typedef {object} FormattedActionResult
 * @property {string} summary - Short summary for conversation
 * @property {string} [details] - Detailed information
 * @property {string} [icon] - Icon/emoji for display
 * @property {boolean} success - Whether action succeeded
 * @property {string} [feedbackForLLM] - Optional feedback message for LLM
 */

/**
 * Progress event emitted during action execution
 * @typedef {object} ActionProgressEvent
 * @property {'stdout'|'stderr'|'status'|'percent'} type - Type of progress event
 * @property {string} [content] - Content for stdout/stderr types
 * @property {string} [message] - Message for status type
 * @property {number} [percent] - Progress percentage (0-100) for percent type
 */

/**
 * @typedef {object} ExecutionContext
 * @property {import('../model/session.js').default} session - Current session
 * @property {import('../model/conversation.js').default} conversation - Current conversation
 * @property {import('../model/message-thread.js').MessageThread} messageThread - Message thread for scoped operations
 * @property {string} [toolUseId] - Tool use ID for progress event correlation
 * @property {string} [toolName] - Resolved tool name being executed; forwarded to the item so multi-tool classes can route (see ItemContext.toolName)
 * @property {AbortSignal} [signal] - Abort signal for cancellation
 * @property {(event: ActionProgressEvent) => void} [onProgress] - Progress callback
 * @property {boolean} [_approvalHandled] - INTERNAL: Set only by ResponseHandler/Conversation after approval was shown to user
 */

/**
 * @typedef {object} ActionManifest
 * @property {string} id - Action ID
 * @property {string} name - Action name
 * @property {string} version - Action version
 * @property {string} description - Action description
 * @property {boolean} requiresApproval - Whether action requires approval
 */

/**
 * Running action tracking info
 * @typedef {object} RunningAction
 * @property {AbortController} controller - Abort controller for cancellation
 * @property {import('juggler/context-item').default} action - Action instance (source of truth for accumulated output)
 * @property {string} actionId - Action type ID
 * @property {string} [toolUseId] - Tool use ID for progress event correlation
 * @property {string} [conversationId] - Conversation ID owning this action
 * @property {number} startTime - Start timestamp
 */

/**
 * Action Executor Service
 *
 * Orchestrates action execution including approval, validation, and backend calls.
 * Uses plugin's prepare() to get PreparedAction - framework is agnostic
 * to what the parameters contain (diffs, previews, etc.).
 *
 * Supports cancellation via AbortController - actions receive context.signal and
 * should check signal.aborted or listen for 'abort' events during long operations.
 * @class
 */

// Cross-window bridge for test instrumentation. action-progress events fire
// on the engine document; viewers mirror them on their own document so
// test-page capture listeners observe them. Engine sends a single WS
// `engine-bridge` envelope; the server forwards it to every viewer, whose
// `websocket.js` handler replays it onto a same-window BroadcastChannel of
// this name. One transport, one delivery per peer — no duplicate events.
const __ACTION_PROGRESS_CHANNEL = 'juggler-action-progress';

class ActionExecutor {
  constructor() {
    /**
     * Map of execution ID to running action info
     * @type {Map<string, RunningAction>}
     * @private
     */
    this._runningActions = new Map();

    /**
     * Counter for generating unique execution IDs
     * @type {number}
     * @private
     */
    this._executionIdCounter = 0;
  }

  /**
   * Execute an action - completely agnostic to plugin internals
   *
   * Flow: prepare → validate → approve → perform → format
   * Framework knows nothing about plugin internals (diffs, recovery, etc.)
   *
   * Actions receive context.signal (AbortSignal) for cancellation support.
   * Long-running actions should check signal.aborted periodically.
   * @param {string} actionId
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM tool call
   * @param {ExecutionContext} context
   * @returns {Promise<ActionStatus>} Result of action execution including success/failure status
   */
  async execute(actionId, toolInput, context) {
    const contextItemRegistry = (await import('../registries/context-item-registry.js')).default;

    /** @type {typeof import('juggler/context-item').default | undefined} */
    const ActionClass = /** @type {any} */ (contextItemRegistry.get(actionId));

    if (!ActionClass) {
      return {
        actionId,
        success: false,
        error: `Unknown action: ${actionId}`
      };
    }

    const { controller, action, executionId } = this._createTrackedAction(actionId, ActionClass, context);

    const startTime = Date.now();

    // _runningActions was populated above (before prepare) so that an in-flight
    // prepare() can be cancelled. Every exit path from here on — success,
    // validation-failure early return, prepare() throw, approval throw,
    // execute() throw — MUST delete the entry. Wrap the whole post-register
    // block in try/finally; the inner try/catch around execute() handles
    // result-shaping and is preserved as-is.
    try {
    // Step 1: Prepare (includes validation - plugin returns valid: true/false)
    // Context is now available on the action instance (this.session, this.conversation, etc.)
    /** @type {import('juggler/context-item').PreparedItem} */
      const prepared = await action.prepare(toolInput);

      // Check validation result
      if (!prepared.valid) {
        return this._buildValidationFailure(actionId, action, prepared, startTime);
      }

      // Step 2: Check approval requirement
      // Approval MUST be handled by the caller (ResponseHandler or session.js).
      // If we get here without _approvalHandled and approval is needed, throw an error.
      // This ensures ALL tool execution goes through the proper approval flow.
      if (!context._approvalHandled && action.requiresApproval() && !action.isPermitted(toolInput)) {
        throw new Error(`Action "${actionId}" requires approval. Use ResponseHandler.executeToolCalls() for proper approval flow.`);
      }

      // Step 3: Execute - plugin handles its own recovery internally if desired
      // Signal and onProgress are already on the action instance from construction
      const actionResult = await this._performAction(actionId, action, prepared, controller);

      // Stamp duration on every result
      actionResult.durationMs = Date.now() - startTime;
      return actionResult;
    } finally {
      // Always clean up tracking — covers prepare()/approval throws and the
      // validation-failed early return in addition to the inner execute path.
      this._runningActions.delete(executionId);
    }
  }

  /**
   * Create the action instance with full execution context and register it in
   * _runningActions so it can be cancelled and correlated with progress events.
   * @param {string} actionId
   * @param {typeof import('juggler/context-item').default} ActionClass
   * @param {ExecutionContext} context
   * @returns {{controller: AbortController, action: import('juggler/context-item').default, executionId: string}} The tracked action handle.
   * @private
   */
  _createTrackedAction(actionId, ActionClass, context) {
    // Create abort controller for this execution (BEFORE action creation so signal is available)
    const controller = new AbortController();
    const executionId = `exec-${++this._executionIdCounter}`;

    // Create action instance with full context (single object for easy subclass pass-through)
    const action = new ActionClass(/** @type {any} */ ({
      id: actionId,
      session: context.session,
      conversation: context.conversation,
      messageThread: context.messageThread,
      toolUseId: context.toolUseId,  // For filtering self from items during validation
      toolName: context.toolName,    // Lets a multi-tool class route to the invoked tool
      signal: controller.signal,
      onProgress: (/** @type {ActionProgressEvent} */ event) => this._emitProgress(executionId, event)
    }));

    // Track this running action for cancellation and progress correlation.
    // conversationId is carried into _emitProgress so multi-tab (and the
    // multi-iframe test pool) listeners can filter out events belonging to
    // OTHER conversations — without it, every BroadcastChannel subscriber
    // in the same browsing context sees every conversation's tool-progress.
    this._runningActions.set(executionId, {
      controller,
      action,
      actionId,
      toolUseId: context.toolUseId,
      conversationId: /** @type {any} */ (context.conversation)?.id,
      startTime: Date.now()
    });

    return { controller, action, executionId };
  }

  /**
   * Format the error result for a prepare() that reported valid: false.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {number} startTime
   * @returns {ActionStatus} The validation-failure result.
   * @private
   */
  _buildValidationFailure(actionId, action, prepared, startTime) {
    // Validation failed - format and return error
    const formatted = ContextItem.validateSummary(action.getSummary({
      success: false,
      error: prepared.error || 'Validation failed',
      prepared
    }));
    /** @type {ActionStatus} */
    const errorResult = {
      actionId,
      success: false,
      error: prepared.error || 'Validation failed',
      formatted,
      displayData: prepared.displayData
    };
    errorResult.durationMs = Date.now() - startTime;
    return errorResult;
  }

  /**
   * Run the prepared action's execute() and shape its raw result (or a thrown
   * error) into an ActionStatus. Honours cancellation throughout.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {AbortController} controller
   * @returns {Promise<ActionStatus>} The shaped execution result.
   * @private
   */
  async _performAction(actionId, action, prepared, controller) {
    try {
      // Check if already aborted before starting
      if (controller.signal.aborted) {
        const formatted = ContextItem.validateSummary(action.getSummary({ success: false, error: 'Action cancelled', cancelled: true, prepared }));
        return /** @type {ActionStatus} */ ({
          actionId,
          success: false,
          error: 'Action cancelled',
          cancelled: true,
          formatted,
          displayData: prepared.displayData
        });
      }

      const result = await this._raceExecuteAgainstAbort(action, prepared, controller);
      return this._formatExecutionResult(actionId, action, prepared, result);
    } catch (error) {
      return this._handleExecutionError(actionId, action, prepared, error);
    }
  }

  /**
   * Race action.execute() against the abort signal so a non-cooperative tool
   * still settles the instant the controller aborts. Returns the raw result, or
   * rejects with an AbortError if the abort wins.
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {AbortController} controller
   * @returns {Promise<any>} The raw execute() result.
   * @private
   */
  async _raceExecuteAgainstAbort(action, prepared, controller) {
    // Robustness backstop: a tool whose execute() ignores its abort signal —
    // a non-cooperative tool, or a backend op that genuinely can't be
    // interrupted — must STILL settle the instant the controller aborts, or
    // it wedges the turn (its read-tool Promise.all never resolves and every
    // later tool in the conversation queues behind it forever). Race
    // execute() against an abort-rejection: if abort wins, the race rejects
    // with an AbortError that flows into the shared catch below and produces
    // the cancelled result. The orphaned execute() promise is detached with a
    // no-op catch so a late rejection can't surface as unhandled; its
    // eventual value is discarded and can't overwrite the cancelled state.
    // Cooperative tools that honour the signal settle first, so this race is
    // invisible to them.
    /** @type {() => void} */
    let onAbortRace = () => {};
    const abortRace = new Promise((_resolve, reject) => {
      onAbortRace = () => {
        // A plain Error tagged with name='AbortError' — the shared catch
        // below dispatches on the name alone (DOMException isn't reliably
        // instanceof Error and isn't an eslint global in this layer).
        const abortErr = new Error('Action cancelled');
        abortErr.name = 'AbortError';
        reject(abortErr);
      };
      controller.signal.addEventListener('abort', onAbortRace, { once: true });
    });
    const execPromise = action.execute(prepared.params || {});
    execPromise.catch(() => {}); // detach orphan: swallow any late rejection
    const result = await Promise.race([execPromise, abortRace]);
    // execute() won the race; drop the abort listener (the once:true handler
    // already self-removes if abort fired and the race rejected instead).
    controller.signal.removeEventListener('abort', onAbortRace);
    return result;
  }

  /**
   * Shape a raw execute() result into an ActionStatus: cancelled-during-execution,
   * a backend structured error, or success.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {any} result
   * @returns {ActionStatus} The shaped success/error result.
   * @private
   */
  _formatExecutionResult(actionId, action, prepared, result) {
    // Check if action was cancelled during execution (streaming actions)
    if (result && result.cancelled) {
      const formatted = ContextItem.validateSummary(action.getSummary({ success: false, error: 'Action cancelled', cancelled: true, result, prepared }));
      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: 'Action cancelled',
        cancelled: true,
        result,
        formatted,
        displayData: prepared.displayData
      });
    } else if (result && typeof result === 'object' && result.success === false && result.errorCode) {
      // Check if backend returned structured error (success: false with errorCode)
      // This allows backends to return detailed error data instead of throwing
      // Get dual messages from action if formatError() is implemented
      let userMessage = /** @type {string} */ (result.error) || 'Operation failed';
      /** @type {string|null} */
      let llmFeedback = null;

      // Get tool name from action's tool definitions
      const toolDefs = /** @type {any} */ (action.constructor).getToolDefinitions?.() || [];
      const toolName = toolDefs[0]?.name || actionId;
      const formatted = action.formatError(result, toolName);
      if (formatted) {
        userMessage = formatted.userMessage;
        llmFeedback = formatted.llmMessage;
      }

      const formattedSummary = ContextItem.validateSummary(action.getSummary({ success: false, error: userMessage, result, prepared }));
      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: userMessage,
        result: llmFeedback ? { ...result, llmFeedback } : result,
        formatted: formattedSummary,
        displayData: prepared.displayData
      });
    } else {
      // Success - format result
      const rawSummary = action.getSummary({ success: true, result, prepared });
      warnOnEmptySuccessSummary(rawSummary, action.constructor.name);
      const formatted = ContextItem.validateSummary(rawSummary);
      return /** @type {ActionStatus} */ ({
        actionId,
        success: true,
        result,
        formatted,
        displayData: prepared.displayData
      });
    }
  }

  /**
   * Shape a thrown error from execution into an ActionStatus, distinguishing an
   * abort (cancelled result, partial output preserved) from a genuine failure.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {unknown} error
   * @returns {ActionStatus} The shaped error result.
   * @private
   */
  _handleExecutionError(actionId, action, prepared, error) {
    // Check if this was an abort error. A fetch() abort rejects with a
    // DOMException whose name is 'AbortError'; DOMException is not reliably
    // `instanceof Error` across engines, so match on the name alone.
    if (/** @type {any} */ (error)?.name === 'AbortError') {
      // Try to preserve any partial output (e.g., streamed stdout before cancellation)
      const partialOutput = /** @type {any} */ (action).output || undefined;

      const partialResult = partialOutput
        ? { stdout: partialOutput, cancelled: true }
        : undefined;

      const formatted = ContextItem.validateSummary(action.getSummary({
        success: false,
        error: 'Action cancelled',
        cancelled: true,
        result: partialResult,
        prepared
      }));

      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: 'Action cancelled',
        cancelled: true,
        result: partialResult,
        formatted,
        displayData: prepared.displayData
      });
    } else {
      // Execution failed - capture full error including stack trace
      const { message: errorMessage, stack: errorStack } = extractErrorInfo(error);

      // Only log unexpected errors (actual bugs), not backend operational errors
      if (!(error instanceof OpsError)) {
        console.error(`[ActionExecutor] Action failed: ${actionId} - ${errorMessage}`);
        if (errorStack) {
          console.error(`[ActionExecutor] Stack trace:\n${errorStack}`);
        }
      }

      const formatted = ContextItem.validateSummary(action.getSummary({
        success: false,
        error: errorMessage,
        prepared
      }));

      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: errorMessage,
        errorStack: errorStack || undefined,
        formatted,
        displayData: prepared.displayData
      });
    }
  }

  /**
   * Emit a progress event for a running action
   * @param {string} executionId - Execution ID
   * @param {ActionProgressEvent} event - Progress event
   * @private
   */
  _emitProgress(executionId, event) {
    const runningAction = this._runningActions.get(executionId);
    if (!runningAction) return;

    // Emit progress event - UI elements can listen to this for streaming display
    // Include accumulated output so listeners display current state instead of reassembling chunks
    const detail = {
      executionId,
      actionId: runningAction.actionId,
      toolUseId: runningAction.toolUseId, // For UI element correlation
      conversationId: runningAction.conversationId,
      event,
      accumulatedOutput: /** @type {any} */ (runningAction.action).output || '',
      startTime: runningAction.startTime
    };
    // The local document event drives same-process UI; the engine worker has
    // no document, so progress reaches viewers solely via the engine bridge.
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('action-progress', { detail }));
    }
    wsService.sendEngineBridge(__ACTION_PROGRESS_CHANNEL, detail);
  }

  /**
   * Cancel a running action by its tool-use ID, scoped to one conversation.
   *
   * Used by the engine's tool-action observer: when the Go worker (the sole
   * writer of cancellation state) flips a tool-action to `state='cancelled'`,
   * the engine aborts the matching in-flight action here. Without this the
   * action's op fetch runs to completion and the reducer overwrites the
   * worker's `cancelled` with `completed`, so the strategy loop continues as
   * if no cancel happened.
   *
   * The conversationId match is load-bearing: this executor is an engine-wide
   * singleton running actions for EVERY conversation, and tool-use IDs are
   * only unique within one provider conversation (OpenAI-style `call_1`
   * recurs constantly; the mock LLM reuses ids across tests). Matching on
   * toolUseId alone let a cancel in conversation A abort an identically-named
   * in-flight tool in conversation B — whose worker never stamps a result, so
   * B's tool wedged at running-with-no-result forever.
   * @param {string} toolUseId - Tool use ID to cancel
   * @param {string} conversationId - Conversation the cancel belongs to
   * @returns {boolean} True if a matching running action was found and aborted
   */
  cancelByToolUseId(toolUseId, conversationId) {
    for (const runningAction of this._runningActions.values()) {
      if (runningAction.toolUseId === toolUseId &&
          runningAction.conversationId === conversationId) {
        runningAction.controller.abort();
        return true;
      }
    }
    return false;
  }

  /**
   * Report whether an execution is currently in flight for a tool-use ID in a
   * specific conversation. The liveness oracle for the worker's stuck-tool
   * backstop: a tool-action the doc flags `running` but that has no entry here is
   * the running-with-no-result wedge (the engine claimed it but the execution
   * aborted without writing, or was orphaned by a reload). Conversation-scoped for
   * the same reason as {@link cancelByToolUseId} — tool-use IDs are unique only
   * within one conversation.
   * @param {string} toolUseId - Tool use ID to check
   * @param {string} conversationId - Conversation the tool belongs to
   * @returns {boolean} True if a matching action is currently executing
   */
  isExecutingToolUse(toolUseId, conversationId) {
    for (const runningAction of this._runningActions.values()) {
      if (runningAction.toolUseId === toolUseId &&
          runningAction.conversationId === conversationId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cancel all currently running actions
   */
  cancelAllActions() {
    for (const [executionId, runningAction] of this._runningActions) {
      runningAction.controller.abort();
      console.log(`[ActionExecutor] Cancelled action: ${runningAction.actionId} (${executionId})`);
    }
    // Map will be cleaned up by finally blocks in execute()
  }


  /**
   * Check if there are any running actions
   * @returns {boolean} True if there are running actions
   */
  hasRunningActions() {
    return this._runningActions.size > 0;
  }

}

// Export singleton instance
const actionExecutor = new ActionExecutor();
export default actionExecutor;
