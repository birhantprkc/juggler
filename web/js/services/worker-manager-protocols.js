//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker-manager sub-protocols: three request/response pairs (context items,
 * tool definitions, approval) plus the approval-adjacent tool-action mutation
 * helpers.
 *
 * Each function takes the WorkerManager instance (`wm`) as its first argument,
 * so the WorkerManager class methods delegate here in one line and its
 * message-handler switch cases dispatch here in one line.
 * @module services/worker-manager-protocols
 */

import { isEngine } from '../../sdk/lib/client-role.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import strategyRegistry from '../registries/strategy-registry.js';
import {
  handleNewToolAction,
  executeToolAction,
  claimRunning,
  saveAutoApprovalPermission,
} from '../model/conversation-tool-actions.js';

// ── render-context-items ─────────────────────────────────────────────

/**
 * Dispatch a render-context-items-request from the worker to the registered
 * callback (set via setOnContextRequest — engine-only; viewers never set it).
 *
 * Like every other engine command handler (handleExecuteTool, handleCancelTool,
 * handleRunStrategyHook), this first ensures the engine has actually LOADED the
 * conversation. The context callback bails without responding when the
 * conversation isn't in session.conversations yet, and — because context
 * rendering is engine-only — that bail has no other client to fall back to, so
 * it would wedge the worker's requestContextAndTools for the whole turn. A
 * freshly-created conversation (e.g. /thread) or a cold engine can have its
 * first context request arrive before the auto-load finishes; awaiting the load
 * here closes that race.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {any} data - Worker message payload
 * @returns {Promise<void>}
 */
export async function handleRenderContextItemsRequest(wm, conversationId, data) {
  if (!wm._onContextRequest) return;
  const c = await ensureEngineConversationLoaded(wm, conversationId);
  // Apply any batched/deferred syncs before rendering so the callback sees the
  // turn's items (e.g. the just-synced user message / context items). Without
  // this the callback's "requested context-item not in local view" guard bails
  // without responding — and, context being engine-only, that wedges the turn.
  // Mirrors handleExecuteTool's ensure-load + flushPendingSyncs.
  if (c) flushPendingSyncs(c);
  wm._onContextRequest(data, conversationId);
}

/**
 * Send the rendered context items back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {Array<{itemId: string, content: string, tokens: number}>} contexts
 * @param {string} [systemPrompt]
 */
export function sendRenderContextItemsResponse(wm, conversationId, requestId, contexts, systemPrompt = '') {
  wm.sendToWorker(conversationId, {
    type: 'render-context-items-response',
    requestId,
    contexts,
    systemPrompt
  });
}

// ── request-tools ────────────────────────────────────────────────────

/**
 * Dispatch a request-tools message from the worker to the registered
 * callback (set via setOnToolsRequest).
 * @param {any} wm
 * @param {string} conversationId
 * @param {any} data
 */
export function handleRequestTools(wm, conversationId, data) {
  if (wm._onToolsRequest) {
    wm._onToolsRequest(data, conversationId);
  }
}

/**
 * Send tool definitions back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {Array<object>} tools
 */
export function sendToolsResult(wm, conversationId, requestId, tools) {
  wm.sendToWorker(conversationId, {
    type: 'tools-result',
    requestId,
    tools
  });
}

// ── approval-request + tool-action mutations ─────────────────────────

/**
 * Dispatch an approval-request from the worker to the registered callback
 * (set via setOnApprovalRequest).
 * @param {any} wm
 * @param {string} conversationId
 * @param {any} data
 */
export function handleApprovalRequest(wm, conversationId, data) {
  if (wm._onApprovalRequest) {
    wm._onApprovalRequest(data, conversationId);
  }
}

// ── run-strategy-hook (worker-driven; engine-only) ───────────────────

/**
 * Run a strategy lifecycle hook (onActivate / onWorkerIdle) on the engine's
 * loaded copy of the conversation, on behalf of the worker. The worker is the
 * single decider of WHEN a hook fires; the engine is the single place this
 * session-wide flow runs. For onActivate (which carries a requestId) the engine
 * reports the ids of the items the hook injected, so the worker can block until
 * that durable guidance has synced into its doc before building the turn.
 *
 * This is the ONLY sanctioned place these hooks fire. Running them in a viewer —
 * elected via the old strategyOwnerIframeId — is the regression we deleted, so
 * the engine role is hard-asserted here.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {any} data - {hook, strategyId, requestId?, previousStrategyId?}
 * @returns {Promise<void>} Resolves once the hook has run (and, for onActivate, the response is sent)
 */
export async function handleRunStrategyHook(wm, conversationId, data) {
  if (!isEngine()) {
    throw new Error('run-strategy-hook received in a viewer — strategy flow runs only in the engine');
  }
  const hook = /** @type {string} */ (data.hook);
  const requestId = /** @type {string|undefined} */ (data.requestId);

  const conversation = await ensureEngineConversationLoaded(wm, conversationId);
  const root = conversation?._rootMessageThread;

  // Run the hook on the WORKER's authoritative strategy. The engine's synced
  // copy of currentStrategyId can lag (it auto-loaded an earlier snapshot, or
  // the switch update hasn't applied yet), so align root.strategy to the id the
  // worker sent before invoking — otherwise we'd run the stale strategy's hook
  // (e.g. default's no-op) and silently inject nothing.
  const strategyId = /** @type {string|undefined} */ (data.strategyId);
  if (root && strategyId && root.currentStrategyId !== strategyId) {
    root.currentStrategyId = strategyId;
    root.strategy = strategyRegistry.createStrategy(strategyId, root);
  }
  const strategy = root?.strategy;

  if (requestId) {
    // onActivate: CAPTURE the guidance rather than writing it to the doc. The
    // worker is the single writer of these durable items (it appends them after
    // the already-promoted user message), so the order is deterministic with no
    // CRDT race between the engine and the worker over where the guidance lands.
    // injectGuidance is the strategy's only doc-writing action in onActivate, so
    // intercepting it captures the hook's full effect.
    /** @type {Array<{content: string, source?: string}>} */
    const guidance = [];
    const original = strategy?.injectGuidance?.bind(strategy);
    if (strategy && original) {
      strategy.injectGuidance = (/** @type {string} */ content, /** @type {{source?: string}} */ opts = {}) => {
        // Preserve injectGuidance's default source tag (the active strategy id)
        // so worker-written guidance keeps the same provenance as before.
        if (content) guidance.push({ content, source: opts.source ?? strategyId });
      };
    }
    try {
      await strategy?.[hook]?.(data.previousStrategyId || null);
    } catch (err) {
      console.error(`[worker-manager] strategy ${hook} threw for ${conversationId}:`, err);
    } finally {
      if (strategy && original) strategy.injectGuidance = original;
    }
    sendStrategyHookResponse(wm, conversationId, requestId, guidance);
    return;
  }

  // onWorkerIdle (fire-and-forget): runs normally. Its effects — e.g. plan
  // execution spawning sub-threads — re-enter through the worker, so there is
  // nothing to capture or reply.
  try {
    await strategy?.[hook]?.(data.previousStrategyId || null);
  } catch (err) {
    console.error(`[worker-manager] strategy ${hook} threw for ${conversationId}:`, err);
  }
}

/**
 * The worker's tool commands are the ONLY driver of the tool lifecycle (the
 * engine has no reactive tool observer), so the engine must read the freshest
 * doc before resolving a command's toolUseId: flush batched-but-unapplied syncs
 * (applySyncUpdate defers behind a setTimeout) so the tool-action the command
 * refers to — pushed ahead of the command through the same ordered mailbox, but
 * not yet applied — is visible. This is the engine half of the command-driven
 * ordering invariant (the worker pushes state ahead of the command; the engine
 * applies pending syncs before acting).
 * @param {any} c - Conversation instance
 */
function flushPendingSyncs(c) {
  c?._doc?.flushPendingUpdates?.();
}

/**
 * Find the message thread (root or nested) that holds a given tool-action.
 * The worker addresses tool-commands by toolUseId only; the engine resolves
 * which thread owns it.
 * @param {any} c - Conversation instance
 * @param {string} toolUseId
 * @returns {any} The owning MessageThread, or null
 */
function findThreadForTool(c, toolUseId) {
  for (const mt of c.getAllMessageThreads()) {
    if (mt.getToolAction(toolUseId)) return mt;
  }
  return null;
}

/**
 * Engine handler for the worker's `evaluate-tool` command: evaluate a newly
 * created tool-action (approval-gate or auto-approve) by id. The
 * command-driven counterpart to the reactive reducer's empty-state branch.
 * Idempotent with that branch via the shared `_handlingNewToolAction` guard.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @returns {Promise<boolean>} true if handled (ack ok), false if it could not act (re-drive)
 */
export async function handleEvaluateTool(wm, conversationId, toolUseId) {
  if (!isEngine()) {
    throw new Error('evaluate-tool received in a viewer — tool execution runs only in the engine');
  }
  // The boolean return is the ack outcome the worker gates its dedup on:
  // false → "could not act, re-drive me"; true → "handled, latch it".
  const c = await ensureEngineConversationLoaded(wm, conversationId);
  if (!c) return false;
  flushPendingSyncs(c);
  const mt = findThreadForTool(c, toolUseId);
  if (!mt) return false;
  // Synchronous guard shared with the reactive reducer: don't launch a second
  // concurrent evaluation while one is in flight for this tool. The in-flight
  // evaluation will produce the result, so this is "handled", not a retry.
  if (c._handlingNewToolAction.has(toolUseId)) return true;
  c._handlingNewToolAction.add(toolUseId);
  try {
    await handleNewToolAction(mt, toolUseId, c);
  } finally {
    c._handlingNewToolAction.delete(toolUseId);
  }
  return true;
}

/**
 * Engine handler for the worker's `execute-tool` command: claim an approved
 * tool-action (approved→running) and run its side effect by id. The
 * command-driven counterpart to the reactive reducer's approved branch; the
 * claimRunning compare-and-set makes it idempotent with that branch (only one
 * caller wins the claim, so the tool executes exactly once).
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @returns {Promise<boolean>} true if handled (ack ok), false if it could not act (re-drive)
 */
export async function handleExecuteTool(wm, conversationId, toolUseId) {
  if (!isEngine()) {
    throw new Error('execute-tool received in a viewer — tool execution runs only in the engine');
  }
  // The boolean return is the ack outcome the worker gates its dedup on:
  // false → "could not act (conv/tool not loaded yet), re-drive me"; true →
  // "handled" — claimed and ran to a terminal result, or already running/terminal
  // (claimRunning lost the CAS), neither of which should be re-driven.
  const c = await ensureEngineConversationLoaded(wm, conversationId);
  if (!c) { sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'conv-not-loaded' }); return false; }
  flushPendingSyncs(c);
  const mt = findThreadForTool(c, toolUseId);
  if (!mt) { sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'no-thread' }); return false; }
  const ymap = mt.getToolAction(toolUseId);
  if (!ymap) { sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'no-ymap' }); return false; }
  // 'yes-always' persists the auto-approval permission. resolveApproval writes
  // approvalResponse='yes-always' and state='approved' in one transaction, so
  // by the time the worker commands execute-tool the response is already set.
  // Save it here (move, not duplicate) before claiming → running.
  if (ymap.get('approvalResponse') === 'yes-always') {
    saveAutoApprovalPermission(c, ymap, mt);
  }
  // Trace the execution lifecycle so the "tool stuck in running" wedge is
  // diagnosable: claim → execute-start → execute-done. A wedge appears in the
  // log as execute-start with no following execute-done/execute-error — the tool
  // claimed running but stalled inside executeToolAction (e.g. a bash awaiting a
  // shell-output 'done' that never arrives). See handleEngineTrace (worker).
  const claimed = claimRunning(c, ymap);
  sendEngineTrace(wm, conversationId, 'execute-claim', { toolUseId, toolName: ymap.get('toolName'), claimed });
  if (claimed) {
    sendEngineTrace(wm, conversationId, 'execute-start', { toolUseId });
    try {
      await executeToolAction(mt, toolUseId, c);
      sendEngineTrace(wm, conversationId, 'execute-done', { toolUseId });
    } catch (err) {
      sendEngineTrace(wm, conversationId, 'execute-error', { toolUseId, error: extractErrorMessage(err) });
      throw err;
    }
  }
  return true;
}

/**
 * Send a tool-command ack back to the worker so it can gate its dedup on a
 * confirmed outcome rather than fire-and-forget. ok=true → the engine handled the
 * command (latch it); ok=false → it could not act (un-latch and re-drive).
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} action - the command acked ('evaluate-tool' | 'execute-tool')
 * @param {string} toolUseId
 * @param {boolean} ok
 */
export function sendToolCommandAck(wm, conversationId, action, toolUseId, ok) {
  wm.sendToWorker(conversationId, { type: 'tool-command-ack', action, toolUseId, ok });
}

/**
 * Emit a diagnostic trace event from the engine to the worker, which logs it to
 * the per-project server log (handleEngineTrace). The engine's WebView console
 * isn't captured anywhere, so this is the only durable record of the engine-side
 * tool-execution lifecycle — used to diagnose the "tool stuck in running" wedge.
 * Fire-and-forget and purely diagnostic; never gate behaviour on it.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} event - short event name (e.g. 'execute-start', 'cancel')
 * @param {Record<string, any>} [fields] - extra correlation fields (toolUseId, etc.)
 */
export function sendEngineTrace(wm, conversationId, event, fields = {}) {
  wm.sendToWorker(conversationId, { type: 'engine-trace', event, ...fields });
}

/**
 * Engine handler for the worker's `cancel-tool` command: abort an in-flight
 * execution by id. Idempotent — a no-op unless this engine has the action
 * running.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @returns {Promise<void>}
 */
export async function handleCancelTool(wm, conversationId, toolUseId) {
  if (!isEngine()) {
    throw new Error('cancel-tool received in a viewer — tool execution runs only in the engine');
  }
  const c = await ensureEngineConversationLoaded(wm, conversationId);
  if (!c) { sendEngineTrace(wm, conversationId, 'cancel-noconv', { toolUseId }); return; }
  // hit=false means this engine had NO registered in-flight execution for the id
  // — the tool was flagged running in the doc but nothing was actually executing
  // here to abort (the wedge signature). hit=true means a real execution was
  // aborted. "Escape visibly cancels" looks identical either way; this disambiguates.
  const hit = c._actionExecutor?.cancelByToolUseId(toolUseId, c.id);
  sendEngineTrace(wm, conversationId, 'cancel', { toolUseId, hit: !!hit });
}

/**
 * Send the strategy-hook response — the guidance the hook captured — back to the
 * worker, which writes those durable items itself (single writer).
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {Array<{content: string, source?: string}>} guidance
 */
export function sendStrategyHookResponse(wm, conversationId, requestId, guidance) {
  wm.sendToWorker(conversationId, {
    type: 'strategy-hook-response',
    requestId,
    guidance
  });
}

/**
 * Resolve and fully load the engine's copy of a conversation, awaiting any
 * in-flight auto-load — on a cold engine restart the worker may have only just
 * pushed its state, so the conversation can still be loading when the hook
 * arrives. Returns null if it cannot be loaded.
 * @param {any} wm
 * @param {string} conversationId
 * @returns {Promise<any>} The loaded conversation, or null
 */
async function ensureEngineConversationLoaded(wm, conversationId) {
  const pending = wm._pendingAutoLoads?.get(conversationId);
  if (pending) {
    try {
      await pending.promise;
    } catch {
      // Auto-load failed; fall through to an explicit load attempt below.
    }
  }
  let conversation = wm._session?.conversations.get(conversationId);
  if (wm._session && (!conversation || conversation.loadState !== 'loaded')) {
    try {
      conversation = await wm.loadExistingConversation(conversationId, wm._session);
    } catch (err) {
      console.error(`[worker-manager] could not load ${conversationId} for strategy hook:`, err);
      return null;
    }
  }
  return conversation;
}

/**
 * Send the approval response back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 * @param {string} response
 */
export function sendApprovalResponse(wm, conversationId, toolUseId, response) {
  wm.sendToWorker(conversationId, {
    type: 'approval-response',
    toolUseId,
    response
  });
}

/**
 * Re-ask a completed tool-action: reset it to its pending approval state,
 * clearing the result and prior response so the approval/question UI
 * re-renders for a fresh answer (e.g. re-running AskUserQuestion).
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 */
export function retryToolApproval(wm, conversationId, toolUseId) {
  wm.sendToWorker(conversationId, { type: 'retry-tool-approval', toolUseId });
}

/**
 * Retry a tool action (reset to pending state).
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 */
export function retryToolAction(wm, conversationId, toolUseId) {
  wm.sendToWorker(conversationId, { type: 'retry-tool-action', toolUseId });
}

/**
 * Update tool action for retry: set approvalOptions and displayData.
 * Called when retrying an action — worker resets to pending, main updates options.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 * @param {object} approvalOptions
 * @param {object} [displayData]
 */
export function updateToolActionForRetry(wm, conversationId, toolUseId, approvalOptions, displayData) {
  wm.sendToWorker(conversationId, {
    type: 'update-tool-action-for-retry',
    toolUseId,
    approvalOptions,
    displayData
  });
}

/**
 * Update tool-actions to clear itemId and set placeholder content. Used
 * when repositioning context items — old tool-action becomes placeholder.
 * Worker owns items[], so mutation must happen there.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} itemId
 */
export function repositionContextItemPlaceholder(wm, conversationId, itemId) {
  wm.sendToWorker(conversationId, {
    type: 'reposition-context-item-placeholder',
    itemId
  });
}

/**
 * Update tool-actions with new hash and reposition changed ones to end.
 * Worker finds all tool-actions for the itemId, compares hashes, updates
 * mismatched ones and moves them to the end.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} itemId
 * @param {number} newHash
 */
export function updateAndRepositionToolActions(wm, conversationId, itemId, newHash) {
  wm.sendToWorker(conversationId, {
    type: 'update-and-reposition-tool-actions',
    itemId,
    newHash
  });
}
