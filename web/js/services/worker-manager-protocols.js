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
import { TOOL_STATES } from '../../sdk/lib/message.js';
import contextItemRegistry from '../registries/context-item-registry.js';
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
 * conversation. Context rendering is engine-only, so this callback is the sole
 * responder and MUST always reply — an unanswered request wedges the worker's
 * requestContextAndTools for the whole 30s ContextTimeout. Awaiting the load
 * here (a freshly-created conversation or cold engine can have its first context
 * request arrive before auto-load finishes) narrows that race; the callback
 * itself closes it by waiting briefly for still-in-flight item syncs and then
 * responding regardless (see setOnContextRequest in session-worker-callbacks.js).
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {any} data - Worker message payload
 * @returns {Promise<void>}
 */
export async function handleRenderContextItemsRequest(wm, conversationId, data) {
  if (!wm._onContextRequest) return;
  // loadAndFlush applies any batched/deferred syncs before rendering so the
  // callback sees the turn's items (e.g. the just-synced user message / context
  // items). Without this the callback's "requested context-item not in local
  // view" guard bails without responding — and, context being engine-only, that
  // wedges the turn.
  await loadAndFlush(wm, conversationId);
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

// ── subthread delegation (worker-driven; engine-only) ────────────────

/**
 * Dispatch a build-subthread-spec request from the worker to the registered
 * engine callback (set via setOnSubthreadSpecRequest). Ensures the engine's
 * copy of the conversation is loaded and its pending syncs applied first, so the
 * callback can resolve the tool's item (mirrors handleRenderContextItemsRequest).
 * @param {any} wm
 * @param {string} conversationId
 * @param {any} data - {requestId, toolUseId, toolName, toolInput}
 * @returns {Promise<void>}
 */
export async function handleBuildSubthreadSpec(wm, conversationId, data) {
  if (!wm._onSubthreadSpecRequest) return;
  await loadAndFlush(wm, conversationId);
  wm._onSubthreadSpecRequest(data, conversationId);
}

/**
 * Send a built subthread spec (or null) back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {object|null} spec - SubthreadSpec, or null to run the tool normally
 * @param {string} [error]
 */
export function sendBuildSubthreadSpecResponse(wm, conversationId, requestId, spec, error = '') {
  wm.sendToWorker(conversationId, {
    type: 'build-subthread-spec-response',
    requestId,
    spec: spec || null,
    error: error || ''
  });
}

/**
 * Dispatch a subthread-error request from the worker to the registered engine
 * callback (set via setOnSubthreadErrorRequest).
 * @param {any} wm
 * @param {string} conversationId
 * @param {any} data - {requestId, toolName, toolInput, reason}
 * @returns {Promise<void>}
 */
export async function handleSubthreadError(wm, conversationId, data) {
  if (!wm._onSubthreadErrorRequest) return;
  await loadAndFlush(wm, conversationId);
  wm._onSubthreadErrorRequest(data, conversationId);
}

/**
 * Send an onSubthreadError fallback result back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {string} result - '' → use default error result
 */
export function sendSubthreadErrorResponse(wm, conversationId, requestId, result) {
  wm.sendToWorker(conversationId, {
    type: 'subthread-error-response',
    requestId,
    result: result || ''
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
  const root = conversation?.rootMessageThread;

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
      await runStrategyHookGuarded(strategy, hook, data.previousStrategyId, conversationId);
    } finally {
      if (strategy && original) strategy.injectGuidance = original;
    }
    sendStrategyHookResponse(wm, conversationId, requestId, guidance);
    return;
  }

  // onWorkerIdle (fire-and-forget): runs normally. Its effects — e.g. plan
  // execution spawning sub-threads — re-enter through the worker, so there is
  // nothing to capture or reply.
  await runStrategyHookGuarded(strategy, hook, data.previousStrategyId, conversationId);
}

/**
 * Run a strategy lifecycle hook, swallowing (and logging) any error it throws so
 * a misbehaving hook can never wedge the worker's turn. Shared by both the
 * onActivate and onWorkerIdle paths of handleRunStrategyHook.
 * @param {any} strategy - The active strategy instance (may be undefined)
 * @param {string} hook - Hook name ('onActivate' | 'onWorkerIdle')
 * @param {string|null|undefined} previousStrategyId
 * @param {string} conversationId - For the error log only
 * @returns {Promise<void>}
 */
async function runStrategyHookGuarded(strategy, hook, previousStrategyId, conversationId) {
  try {
    await strategy?.[hook]?.(previousStrategyId || null);
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
 * Ensure the engine's copy of a conversation is loaded, then flush its batched-
 * but-unapplied syncs so any state the worker pushed ahead of this command is
 * visible. The shared preamble for every worker-driven engine command
 * (render-context-items, build-subthread-spec, subthread-error, evaluate-tool,
 * execute-tool, cancel-tool). Returns the loaded conversation, or null if it
 * could not be loaded.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @returns {Promise<any>} The loaded conversation, or null
 */
async function loadAndFlush(wm, conversationId) {
  const c = await ensureEngineConversationLoaded(wm, conversationId);
  if (c) flushPendingSyncs(c);
  return c;
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
 * created tool-action (approval-gate or auto-approve) by id. The worker is the
 * sole driver of the tool lifecycle (the engine has no reactive tool reducer);
 * the `_handlingNewToolAction` guard makes this idempotent against a re-driven
 * command for the same tool.
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
  const c = await loadAndFlush(wm, conversationId);
  if (!c) return false;
  const mt = findThreadForTool(c, toolUseId);
  if (!mt) return false;
  // Synchronous guard: don't launch a second concurrent evaluation while one is
  // in flight for this tool (e.g. a re-driven command). The in-flight evaluation
  // will produce the result, so this is "handled", not a retry.
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
 * tool-action (approved→running) and run its side effect by id. The worker is
 * the sole driver of the tool lifecycle (the engine has no reactive tool
 * reducer); the claimRunning compare-and-set makes this idempotent against a
 * re-driven command (only one caller wins the claim, so the tool executes
 * exactly once).
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
  const c = await loadAndFlush(wm, conversationId);
  if (!c) { sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'conv-not-loaded' }); return false; }
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
    // Post-condition: execution returned but left the tool NON-TERMINAL with no
    // result. This is the cancelled-no-write exit (_runActionAndComplete's
    // `result.cancelled` branch, e.g. a spurious abort of a re-run whose stale
    // cancel signal fired immediately): the single-writer rule means the browser
    // deliberately wrote nothing, deferring cancellation to the worker. Without a
    // strategy-loop turn about to stamp it, the tool would wedge forever at
    // running-with-no-result. Report it so the worker (sole cancellation writer)
    // finalizes it. Guarded on `claimed` so a re-driven command that lost the
    // claim (another invocation owns the live execution) never false-reports.
    const postResult = ymap.get('result');
    if (ymap.get('state') === TOOL_STATES.RUNNING && (postResult === undefined || postResult === null)) {
      // Epoch = this claim's runningStartedAt. Between claim and here nothing else
      // re-claims this id (it's running), so this is exactly the aborted execution.
      const runningStartedAt = ymap.get('runningStartedAt');
      sendEngineTrace(wm, conversationId, 'execute-wedge-finalize', { toolUseId, runningStartedAt });
      finalizeCancelledToolAction(wm, conversationId, toolUseId, runningStartedAt);
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
  const c = await loadAndFlush(wm, conversationId);
  if (!c) { sendEngineTrace(wm, conversationId, 'cancel-noconv', { toolUseId }); return; }
  // hit=false means this engine had NO registered in-flight execution for the id
  // — the tool was flagged running in the doc but nothing was actually executing
  // here to abort (the wedge signature). hit=true means a real execution was
  // aborted. "Escape visibly cancels" looks identical either way; this disambiguates.
  const hit = c._actionExecutor?.cancelByToolUseId(toolUseId, c.id);
  sendEngineTrace(wm, conversationId, 'cancel', { toolUseId, hit: !!hit });
}

/**
 * Engine handler for the worker's `probe-tool-liveness` command — the tool-liveness
 * backstop. The worker sends this for a tool-action the doc has flagged `running`
 * with no result for longer than the grace period. The engine is the sole tool
 * executor, so its action executor is the authoritative liveness oracle: if it is
 * NOT executing this id (and the tool is browser-executed, not worker-managed),
 * the doc's `running` flag is a lie — the execution was orphaned (a cancelled
 * -no-write exit whose report was lost, an engine reload, a crash). Report it via
 * the same `finalize-cancelled-tool` signal the execute post-condition uses, so
 * the worker (sole cancellation writer) finalizes it. A genuinely long-running
 * tool is still registered here, answers "live", and is left untouched.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @returns {Promise<void>}
 */
export async function handleProbeToolLiveness(wm, conversationId, toolUseId) {
  if (!isEngine()) {
    // Only the executing engine can judge liveness; a viewer must never finalize.
    return;
  }
  const c = await loadAndFlush(wm, conversationId);
  if (!c) { sendEngineTrace(wm, conversationId, 'liveness-noconv', { toolUseId }); return; }
  const mt = findThreadForTool(c, toolUseId);
  if (!mt) return;
  const ymap = mt.getToolAction(toolUseId);
  if (!ymap) return;
  // Only judge the wedge shape — still running, no result. If it already moved on
  // (completed/cancelled, or a re-run reset it to approved), there is nothing to do.
  const probeResult = ymap.get('result');
  if (ymap.get('state') !== TOOL_STATES.RUNNING || (probeResult !== undefined && probeResult !== null)) return;
  // Worker-managed tools (e.g. create_thread) execute in the Go worker, never in
  // the engine, so the engine's action executor is not their liveness oracle —
  // leave them for the worker to complete.
  const ActionClass = contextItemRegistry.getByToolName(ymap.get('toolName'));
  if (ActionClass?.MANIFEST?.workerManaged) {
    sendEngineTrace(wm, conversationId, 'liveness-foreign', { toolUseId });
    return;
  }
  const live = c._actionExecutor?.isExecutingToolUse(toolUseId, c.id);
  sendEngineTrace(wm, conversationId, 'liveness-probe', { toolUseId, live: !!live });
  if (!live) {
    // Carry the epoch we just observed so the worker only finalizes THIS running
    // execution — if a re-run re-claimed the id (fresh runningStartedAt) between
    // this probe and its processing, the epoch won't match and it's left alone.
    finalizeCancelledToolAction(wm, conversationId, toolUseId, ymap.get('runningStartedAt'));
  }
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
 * Report to the worker that the engine executed a tool-action but left it
 * non-terminal with no result — a cancelled-no-write exit (the browser aborted
 * execution and, per the single-writer rule, deliberately didn't write). The
 * worker (sole cancellation writer) stamps it cancelled iff it is still RUNNING
 * under the SAME execution, so the tool can never wedge at running-with-no-result.
 * Emitted from the engine execute post-condition and the liveness backstop.
 *
 * `runningStartedAt` is the execution epoch the sender observed (the value
 * claimRunning stamped). The worker finalizes only if the doc still carries that
 * exact epoch — so a re-run that re-claimed the same toolUseId to a FRESH running
 * (a new runningStartedAt) between this report and its processing is never
 * clobbered. Without it, an ABA on the id would abort the innocent re-run.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 * @param {number|undefined} runningStartedAt - execution epoch observed by the sender
 */
export function finalizeCancelledToolAction(wm, conversationId, toolUseId, runningStartedAt) {
  wm.sendToWorker(conversationId, { type: 'finalize-cancelled-tool', toolUseId, runningStartedAt });
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
