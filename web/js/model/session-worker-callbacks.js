//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker-callback wiring for Session. Two factory functions, one for the
 * engine role (handles context requests, tool definitions, and approvals)
 * and one for the viewer role (handles approvals only). Each takes the
 * Session instance and registers the appropriate handlers on workerManager.
 *
 * The shared helpers `updateToolActionApprovalOptions` and `formatToolInput`
 * live here too; they're called from both factories.
 * @module model/session-worker-callbacks
 */

import workerManager from '../services/worker-manager.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';
import { generateToolDefinitions } from '../services/tool-generator.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { buildApprovalButtons } from '../services/approval-options.js';
import { assembleSystemPrompt, systemPositionItems as systemPositionItemsOf } from '../services/system-prompt-builder.js';
import { buildExtensionSystemPromptContributions } from '../services/extensions.js';

/**
 * Format tool input for display in approval dialog.
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @returns {string} Formatted string
 */
export function formatToolInput(toolInput) {
  if ('command' in toolInput && toolInput.command) {
    return String(toolInput.command);
  }
  if ('path' in toolInput && toolInput.path) {
    return String(toolInput.path);
  }
  return JSON.stringify(toolInput, null, 2);
}

/**
 * Update tool-action in Yjs with approval options.
 * @param {any} conv - Conversation
 * @param {string} toolUseId - Tool use ID
 * @param {object} approvalOptions - Approval options
 */
export function updateToolActionApprovalOptions(conv, toolUseId, approvalOptions) {
  const messageThread = conv.findMessageThreadForToolUse(toolUseId);
  if (!messageThread) {
    console.warn(`[Session] Could not find tool-action ${toolUseId} to update approval options`);
    return;
  }
  // Find the index of this tool-action within its context
  const items = messageThread.items;
  for (let i = 0; i < items.length; i++) {
    if (items[i].get('type') === 'tool-action' && items[i].get('toolUseId') === toolUseId) {
      messageThread.updateItemField(i, 'approvalOptions', approvalOptions);
      return;
    }
  }
  console.warn(`[Session] Could not find tool-action ${toolUseId} to update approval options`);
}

/**
 * The one-shot Allow / Deny option set — a fresh array each call. Used on
 * fallback paths where there is no owning plugin to define a meaningful "don't
 * ask again" choice (unknown tool, error building the UI), so the framework
 * offers only the one-shot decision.
 * @returns {Array<{label: string, value: string, style: string}>} A fresh option array
 */
function allowDenyOptions() {
  return [
    { label: 'Allow', value: 'yes', style: 'primary' },
    { label: 'Deny', value: 'no', style: 'secondary' }
  ];
}

/**
 * Shared approval-request handler for BOTH the engine and viewer roles. The
 * worker broadcasts an approval request to every client; each builds the
 * approval options from the owning action plugin (which runs on the main
 * thread) and writes them onto the tool-action in Yjs. The two roles need
 * identical logic, so it lives here once and the engine/viewer setups can't
 * drift apart.
 * @param {any} session - Session instance
 * @param {*} request - Approval request from the worker
 * @param {string} conversationId - Conversation the request targets
 * @returns {Promise<void>} Resolves once approval options are written (or the action is auto-approved)
 */
async function handleApprovalRequest(session, request, conversationId) {
  /** @type {{toolUseId: string, toolName: string, toolInput: object, config?: object}} */
  const req = /** @type {*} */ (request);
  const conv = session.conversations.get(conversationId);

  if (!conv) {
    console.error(`[Session] Approval request for unknown conversation: ${conversationId}`);
    return;
  }

  try {
    const ActionClass = contextItemRegistry.getByToolName(req.toolName);
    if (!ActionClass) {
      console.warn(`[Session] No action class for tool ${req.toolName}`);
      updateToolActionApprovalOptions(conv, req.toolUseId, {
        title: `Approve: ${req.toolName}`,
        message: JSON.stringify(req.toolInput),
        options: allowDenyOptions()
      });
      return;
    }

    // Find the message thread containing this tool-action (fall back to root)
    const messageThread = conv.findMessageThreadForToolUse(req.toolUseId) || conv.rootMessageThread;

    /** @type {import('juggler/context-item').ItemContext} */
    const actionContext = {
      id: req.toolUseId,
      session,
      conversation: conv,
      messageThread,
      toolUseId: req.toolUseId
    };
    const action = new ActionClass(actionContext);

    const toolInput = /** @type {Record<string, unknown>} */ (req.toolInput);
    const validation = await action.validate(toolInput);
    if (!validation.valid) {
      updateToolActionApprovalOptions(conv, req.toolUseId, {
        title: `Invalid: ${action.getTitle()}`,
        message: validation.error || 'Invalid parameters',
        options: [{ label: 'Cancel', value: 'cancel', style: 'secondary' }]
      });
      return;
    }

    // Already permitted (wildcard patterns, write-file toggle, etc.) — auto-approve.
    if (action.isPermitted(toolInput)) {
      if (messageThread) {
        messageThread.resolveApproval(req.toolUseId, 'yes');
      }
      return;
    }

    const approvalConfig = await action.getApprovalConfig(validation.params || toolInput);
    updateToolActionApprovalOptions(conv, req.toolUseId, {
      title: approvalConfig?.title || action.getTitle(),
      message: approvalConfig?.message || formatToolInput(toolInput),
      options: approvalConfig?.options || buildApprovalButtons(action, validation.params || toolInput),
      display: approvalConfig?.display,
      customApproval: approvalConfig?.customApproval || false
    });
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    console.error(`[Session] Error building approval options for ${req.toolUseId}:`, errorMsg);
    updateToolActionApprovalOptions(conv, req.toolUseId, {
      title: req.toolName,
      message: 'Error building approval UI',
      options: allowDenyOptions()
    });
  }
}

/**
 * Install engine-role worker callbacks: context requests, tool definitions,
 * and approval requests. Idempotent w.r.t. the workerManager API — each
 * setter replaces any prior handler.
 * @param {any} session - Session instance
 */
export function setupWorkerCallbacks(session) {
  // Handle context requests from workers
  // Worker needs context text from context items (plugins on main thread)
  workerManager.setOnContextRequest(async (request, conversationId) => {
    /** @type {{requestId: string, itemIds?: string[], contextParams?: object}} */
    const req = /** @type {any} */ (request);
    const conv = session.conversations.get(conversationId);
    if (!conv) {
      // Don't respond if we don't own this conversation — another client
      // (the originator) has the authoritative state. Responding here wins
      // the worker's cap-1 reply channel and silently drops the originator's
      // full response, blanking the LLM context.
      console.debug(`[ContextCallback] bail: no local conversation ${conversationId} (req=${req.requestId})`);
      return;
    }
    // Same race-mitigation: if any requested context-item isn't in our
    // local contextItems yet (e.g. yjs-sync hasn't reached this view), bail
    // and let the originating client answer. Message items aren't context
    // items and are always skipped — both worker-minted ids (`msg_TIMESTAMP_NUM`)
    // and viewer-minted ids (`msg-TIMESTAMP-RANDOM`, from conversation._nextItemId,
    // e.g. a strategy-injected system-reminder). Both schemes are covered, or a
    // viewer-injected message id would fail this guard and wedge the turn.
    const requestedIds = req.itemIds || [];
    // Requested ids may name context items in any thread — a sub-thread turn
    // requests its own (and inherited) items, whose ids never live in root — so
    // resolve presence against every thread. Checking root alone would fail this
    // guard for a sub-thread item, bail, and wedge the turn.
    const allContextItems = conv.getAllMessageThreads().flatMap((/** @type {any} */ t) => t.contextItems);
    const localIds = new Set(allContextItems.map((/** @type {any} */ f) => f.id));
    for (const id of requestedIds) {
      if (id.startsWith('msg_') || id.startsWith('msg-')) continue;
      if (!localIds.has(id)) {
        console.debug(`[ContextCallback] bail: conv ${conversationId} missing context-item ${id} (req=${req.requestId}, have ${localIds.size} local items)`);
        return;
      }
    }

    try {
      // Build proper contextParams with helpers
      const contextParams = {
        contextWindowSize: conv.contextWindow || 128000,
        modelConfig: conv.modelConfig || null,
        helpers: FormattingHelpers,
        ...(req.contextParams || {})
      };

      const contextItems = conv.rootMessageThread.contextItems;

      // Assemble the system prompt via the shared builder — the single source
      // of truth shared with context-builder.js prepare(). Worker always
      // processes root context, so use the root thread's strategy.
      const systemPositionItems = systemPositionItemsOf(contextItems);
      const extensionContributions = await buildExtensionSystemPromptContributions();
      const systemPrompt = await assembleSystemPrompt({
        contextItems,
        contextParams,
        extensionContributions
      });

      // Get context from each context item via the conversation
      // Only include non-system-position context items (system-position ones are in systemPrompt)
      /** @type {Array<{itemId: string, content: string, tokens: number}>} */
      const contexts = [];
      const itemIds = req.itemIds || [];

      // Create a set of system-position context item IDs to exclude
      const systemItemIds = new Set(systemPositionItems.map((/** @type {any} */ f) => f.id));

      for (const itemId of itemIds) {
        // Skip system-position context items - their content is already in systemPrompt
        if (systemItemIds.has(itemId)) continue;

        // Resolve the item across all threads — a sub-thread turn's requested
        // ids include items that live on the sub-thread, not root.
        const item = allContextItems.find((/** @type {any} */ f) => f.id === itemId);
        if (item && typeof item.getContextText === 'function') {
          // getContextText is async
          const text = await item.getContextText(contextParams);
          // Estimate tokens (rough: 4 chars per token)
          const tokens = Math.ceil((text || '').length / 4);
          contexts.push({ itemId, content: text || '', tokens });
        }
      }

      workerManager.sendRenderContextItemsResponse(conversationId, req.requestId, contexts, systemPrompt);
    } catch (error) {
      console.error(`[Session] Error getting context for ${conversationId}:`, error);
      workerManager.sendRenderContextItemsResponse(conversationId, req.requestId, [], '');
    }
  });

  // DOCUMENT-DRIVEN FLOW: the worker creates tool-action items in the doc; the
  // frontend observes them via the Yjs observer and executes once approved.
  // There is deliberately no tool-execution message handler here.

  // Handle tool definitions requests from workers
  workerManager.setOnToolsRequest(async (request, conversationId) => {
    /** @type {{requestId: string}} */
    const req = /** @type {*} */ (request);

    try {
      let tools = await generateToolDefinitions();

      // Let the active strategy filter tools (e.g., plan strategy restricts to read-only during planning)
      const conv = session.conversations.get(conversationId);
      const strategy = conv?.rootMessageThread?.strategy;
      if (strategy?.filterTools) {
        tools = /** @type {typeof tools} */ (strategy.filterTools(tools));
      }

      workerManager.sendToolsResult(conversationId, req.requestId, tools);
    } catch (error) {
      console.error(`[Session] Error generating tools for ${conversationId}:`, error);
      workerManager.sendToolsResult(conversationId, req.requestId, []);
    }
  });

  // Handle subthread-spec build requests from workers (engine-only). For a
  // delegatesToSubthread tool call, instantiate the owning item, run
  // validate + buildSubthreadSpec, and reply with the spec (or null → the
  // worker runs the ordinary client-side tool-action).
  workerManager.setOnSubthreadSpecRequest(async (request, conversationId) => {
    /** @type {{requestId: string, toolUseId: string, toolName: string, toolInput?: Record<string, unknown>}} */
    const req = /** @type {*} */ (request);
    const conv = session.conversations.get(conversationId);
    // Engine-targeted (never broadcast), so replying null on a missing/failed
    // conversation is safe and fast — the worker falls back to normal execution
    // rather than stalling until the round-trip times out.
    if (!conv) {
      workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null);
      return;
    }
    try {
      const ItemClass = contextItemRegistry.getByToolName(req.toolName);
      if (!ItemClass) {
        workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null);
        return;
      }
      const messageThread = conv.findMessageThreadForToolUse(req.toolUseId) || conv.rootMessageThread;
      /** @type {import('juggler/context-item').ItemContext} */
      const itemContext = {
        id: req.toolUseId,
        session,
        conversation: conv,
        messageThread,
        toolUseId: req.toolUseId
      };
      const item = new (/** @type {any} */ (ItemClass))(itemContext);
      const toolInput = /** @type {Record<string, unknown>} */ (req.toolInput || {});
      const validation = await item.validate(toolInput);
      if (!validation.valid) {
        // Invalid input: don't delegate — let the normal tool path surface the
        // validation error to the LLM.
        workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null);
        return;
      }
      const spec = await item.buildSubthreadSpec(validation.params || toolInput, {
        conversation: conv,
        session,
        signal: item.signal
      });
      workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, spec || null);
    } catch (error) {
      const errorMsg = extractErrorMessage(error);
      console.error(`[Session] Error building subthread spec for ${req.toolName}:`, errorMsg);
      workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null, errorMsg);
    }
  });

  // Handle subthread-error fallback requests from workers (engine-only). When a
  // delegated child ended without a result, give the owning tool a chance to
  // degrade gracefully via onSubthreadError; reply with the fallback text (or
  // '' → the worker writes a default error result).
  workerManager.setOnSubthreadErrorRequest(async (request, conversationId) => {
    /** @type {{requestId: string, toolName: string, toolInput?: Record<string, unknown>, reason?: string}} */
    const req = /** @type {*} */ (request);
    const conv = session.conversations.get(conversationId);
    if (!conv) {
      workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
      return;
    }
    try {
      const ItemClass = contextItemRegistry.getByToolName(req.toolName);
      if (!ItemClass) {
        workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
        return;
      }
      /** @type {import('juggler/context-item').ItemContext} */
      const itemContext = {
        id: req.requestId,
        session,
        conversation: conv,
        messageThread: conv.rootMessageThread
      };
      const item = new (/** @type {any} */ (ItemClass))(itemContext);
      if (typeof item.onSubthreadError !== 'function') {
        workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
        return;
      }
      const error = new Error(req.reason || 'the delegated sub-agent failed');
      const fallback = await item.onSubthreadError(error, /** @type {Record<string, unknown>} */ (req.toolInput || {}));
      const result = fallback && typeof fallback.result === 'string' ? fallback.result : '';
      workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, result);
    } catch (error) {
      console.error(`[Session] Error running onSubthreadError for ${req.toolName}:`, extractErrorMessage(error));
      workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
    }
  });

  // Handle approval requests from workers (shared engine/viewer logic).
  // Worker needs approval options from action plugins (which run on main thread).
  workerManager.setOnApprovalRequest((request, conversationId) =>
    handleApprovalRequest(session, request, conversationId));
}

/**
 * Install viewer-role worker callbacks. Viewer only handles approval
 * requests — context rendering and tool definitions are owned by the engine.
 * @param {any} session - Session instance
 */
export function setupViewerWorkerCallbacks(session) {
  // Same approval logic as the engine role — shared so the two can't drift.
  workerManager.setOnApprovalRequest((request, conversationId) =>
    handleApprovalRequest(session, request, conversationId));
}
