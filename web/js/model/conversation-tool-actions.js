//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tool-action helpers extracted from Conversation. Pure-function helpers that
 * take the Conversation instance (`c`) as their first argument; the class
 * methods become one-line delegators.
 *
 * The tool lifecycle is command-driven: the Go worker observes every doc
 * update and drives each tool-action by commanding the engine
 * (`evaluate-tool` → `handleNewToolAction`, `execute-tool` →
 * `claimRunning` + `executeToolAction`, `cancel-tool`). The engine has no
 * reactive tool reducer.
 * @module model/conversation-tool-actions
 */

import {
  isToolActionMessage,
  TOOL_STATES,
} from '../../sdk/lib/message.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import toolExecutor from '../services/tool-executor.js';
import { resolveToolName } from '../services/tool-generator.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isViewer } from '../../sdk/lib/client-role.js';
import { ENGINE_DERIVED_ORIGIN } from '../utils/document-sync-manager.js';
import { APPROVAL_POLICY } from 'juggler/strategy-type';
import { INTERACTION_KIND } from '../../sdk/context-item.js';

/** @typedef {import('../../sdk/lib/message.js').Message} Message */

/**
 * Framework-owned, strategy-agnostic label for the review indicator shown while
 * a strategy's `onToolPending` promise is in flight. Derived from the strategy's
 * own manifest so no strategy-specific string leaks into the core: an explicit
 * `static REVIEW_LABEL` wins, else "<name> reviewing…", else a generic fallback.
 * @param {any} strategy - The message thread's strategy instance
 * @returns {string} Human-readable review label
 */
function reviewLabelFor(strategy) {
  const override = strategy?.constructor?.REVIEW_LABEL;
  if (override) return override;
  const name = strategy?.constructor?.MANIFEST?.name;
  return name ? `${name} reviewing…` : 'Reviewing…';
}

/**
 * Mark a parked tool-action as under out-of-band review by writing a transient
 * `reviewStatus` field. Tagged ENGINE_DERIVED_ORIGIN so the worker's UndoManager
 * skips it, matching the sibling approvalOptions/displayData writes.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @param {string} label
 */
function setReviewStatus(messageThread, toolUseId, label) {
  const doc = messageThread.conversation?._doc?.doc;
  if (!doc) return;
  doc.transact(() => {
    const items = messageThread.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
        messageThread.updateItemField(i, 'reviewStatus', { busy: true, label });
        break;
      }
    }
  }, ENGINE_DERIVED_ORIGIN);
}

/**
 * Clear the transient `reviewStatus` once a strategy's `onToolPending` promise
 * settles — but only if the tool is still PENDING. On the allow path it already
 * transitioned to APPROVED and the approval surface is gone, so the stale field
 * is harmless; we leave it untouched rather than write onto a resolved item.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 */
function clearReviewStatus(messageThread, toolUseId) {
  const doc = messageThread.conversation?._doc?.doc;
  if (!doc) return;
  doc.transact(() => {
    const items = messageThread.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
        if (item.get('state') === TOOL_STATES.PENDING) {
          messageThread.updateItemField(i, 'reviewStatus', null);
        }
        break;
      }
    }
  }, ENGINE_DERIVED_ORIGIN);
}

/**
 * Execute a tool action that has been approved (state='running').
 * Called by the items observer when it detects a running tool without a result.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @param {any} conversation - Conversation instance
 */
export async function executeToolAction(messageThread, toolUseId, conversation) {
  const toolAction = messageThread.getToolAction(toolUseId);
  if (!toolAction || toolAction.get('state') !== TOOL_STATES.RUNNING) {
    return;
  }

  const toolName = toolAction.get('toolName');

  // Worker-managed tools: execution handled by Go worker, skip browser-side execution
  const ActionClass = contextItemRegistry.getByToolName(toolName);
  if (ActionClass?.MANIFEST?.workerManaged) {
    return;
  }
  const toolInput = toolAction.get('toolInput');

  try {
    const toolCall = {
      id: toolUseId,
      name: toolName,
      input: toolInput?.toJSON ? toolInput.toJSON() : toolInput
    };

    await toolExecutor.executeToolCall(toolCall, conversation._responseHandler, messageThread);
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    console.error(`[ToolExec] Error: ${toolName} (${toolUseId}): ${errorMessage}`);
    messageThread.completeToolAction(toolUseId, {
      content: `Tool execution failed: ${errorMessage}`,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: errorMessage }
    });
  }
}

/**
 * Handle a newly created tool-action with undefined state.
 * Checks plugin manifest to determine if approval is needed.
 * Called by the items observer when a new tool-action is inserted.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @param {any} conversation
 * @param {any} [existingYMap]
 */
export async function handleNewToolAction(messageThread, toolUseId, conversation, existingYMap = null) {
  if (isViewer()) return;

  const toolAction = existingYMap || messageThread.getToolAction(toolUseId);
  if (!toolAction) return;

  const toolName = toolAction.get('toolName');
  const toolInput = toolAction.get('toolInput');
  const toolInputPlain = toolInput?.toJSON ? toolInput.toJSON() : toolInput;
  const ActionClass = contextItemRegistry.getByToolName(toolName);
  if (!ActionClass) {
    messageThread.completeToolAction(toolUseId, {
      content: `Unknown tool: ${toolName}`,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: `Unknown tool: ${toolName}` }
    });
    return;
  }

  // Worker-managed tools: execution handled by Go worker, skip browser-side
  // execution. Stamp executor='worker' authoritatively (this is where the plugin
  // manifest is actually known) so the worker's tool-execution-report liveness
  // rule can skip tools it executes itself — the engine's executor is not their
  // liveness oracle and they never appear in a report. Additive field, tagged
  // ENGINE_DERIVED_ORIGIN like every other derivation here so undo skips it.
  if (ActionClass.MANIFEST?.workerManaged) {
    if (toolAction.get('executor') !== 'worker') {
      conversation._doc.doc.transact(() => {
        toolAction.set('executor', 'worker');
      }, ENGINE_DERIVED_ORIGIN);
    }
    return;
  }

  const action = new ActionClass({
    id: ActionClass.MANIFEST?.id || 'unknown',
    session: conversation._session,
    conversation,
    messageThread,
    // Lets a multi-tool class (e.g. the MCP bridge) route validate/approval to
    // the invoked tool. Omitting it makes such a class validate with an empty
    // name and reject its own call — the "Unknown MCP tool """ failure.
    toolName: resolveToolName(toolName)
  });

  let prepared;
  try {
    prepared = await action.prepare(toolInputPlain);
  } catch (err) {
    const errorMessage = extractErrorMessage(err);
    messageThread.completeToolAction(toolUseId, {
      content: `Action preparation failed: ${errorMessage}`,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: errorMessage }
    });
    return;
  }

  if (!prepared.valid) {
    const errorMessage = prepared.error || 'Validation failed';
    messageThread.completeToolAction(toolUseId, {
      content: errorMessage,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: errorMessage }
    });
    return;
  }

  // The action's own default decision: needs approval unless it never requires
  // it, is already permitted by a rule, or the conversation is in auto-approve.
  const defaultApproval = action.requiresApproval() &&
                          !action.isPermitted(toolInputPlain) &&
                          !conversation._autoApprove;

  // The strategy has master control over approval (YOLO approves everything,
  // read-only auto-approves read/meta tools).
  // Consult it exactly as response-handler._determineApprovalNeeded does, so a
  // live strategy switch takes effect for every tool evaluated afterwards — the
  // metadata observer rebuilds messageThread.strategy on the switch, so this
  // reads the current policy with no extra plumbing.
  const toolDefs = ActionClass.getToolDefinitions?.() || [];
  const toolDef = toolDefs.find((/** @type {{name: string}} */ t) => t.name === toolName);
  const strategyPolicy = messageThread.strategy?.getApprovalPolicy?.({
    toolName,
    toolInput: toolInputPlain,
    category: toolDef?.category,
    defaultApproval,
    // The parked-state kind (gate vs elicitation). Lets a policy decline to
    // stand in for the user on an elicitation (e.g. AskUserQuestion), whose
    // resolution IS the user's typed answer — so a blanket auto-approve (YOLO)
    // never silently answers a question. Same discriminant the gate-only
    // onToolPending dispatch keys off below.
    interactionKind: action.interactionKind()
  });

  let needsApproval;
  if (strategyPolicy === APPROVAL_POLICY.APPROVE) {
    needsApproval = false;
  } else if (strategyPolicy === APPROVAL_POLICY.REQUIRE_APPROVAL) {
    needsApproval = true;
  } else {
    needsApproval = defaultApproval;
  }

  // All writes below are pure derivations of the just-observed tool-action
  // (toolName + toolInput + plugin manifest). Wrap them in the
  // ENGINE_DERIVED_ORIGIN transaction so the worker's UndoManager skips
  // them — otherwise undo of the tool-action's insert would only pop these
  // derivations and the engine would immediately re-derive on the next
  // observer tick.
  conversation._doc.doc.transact(() => {
    if (needsApproval) {
      const approvalOptions = conversation._responseHandler.buildApprovalOptions(action, prepared);
      // CAS guard: only write pending if still unstarted (ifState: '').
      // A concurrent handleNewToolAction call that beat us to APPROVED would
      // have the tool executing; don't reset it to pending.
      messageThread.updateToolActionState(toolUseId, TOOL_STATES.PENDING, { ifState: '' });
      const items = messageThread.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
          messageThread.updateItemField(i, 'approvalOptions', approvalOptions);
          messageThread.updateItemField(i, 'displayData', prepared.displayData);
          break;
        }
      }
    } else {
      // Set state to 'approved' — the worker observes this and commands the
      // engine to execute (`execute-tool` → claimRunning atomically claims
      // approved → running, then executeToolAction launches the work).
      // Writing 'running' directly would skip the claim.
      // CAS guard: only write approved if still unstarted (ifState: '').
      // Prevents a late-arriving duplicate handleNewToolAction call from
      // resetting RUNNING → APPROVED and triggering a second execution.
      messageThread.updateToolActionState(toolUseId, TOOL_STATES.APPROVED, { ifState: '' });
    }
  }, ENGINE_DERIVED_ORIGIN);

  // The tool has now parked awaiting approval (state=PENDING committed above).
  // Notify the strategy so out-of-band approval automation (e.g. a cheap-model
  // auto-approve classifier) can review it and resolve via resolveApproval.
  //
  // GATE INTERACTIONS ONLY. An elicitation (e.g. AskUserQuestion) parks with an
  // approval surface that is a user-input form, not a go/no-go gate — its
  // resolution IS the user's answer, which no proxy can supply. Handing it to a
  // reviewer could only produce a resolution that silently answers for the
  // user, so the dispatch simply never fires for elicitations: there is no code
  // path by which approval automation can resolve one. onToolPending's contract
  // (see StrategyType) is therefore gate-only, and strategies need no per-call
  // guard.
  //
  // Fire-and-forget by contract: this whole function is engine-only (viewers
  // returned at the top), so the hook runs exactly once per park — no viewer
  // election. We deliberately do NOT await it: getApprovalPolicy above is the
  // synchronous decision, and blocking the gate on an async classifier would
  // stall the evaluate-tool ack. A throw or a rejected promise is swallowed
  // here so it never becomes an unhandled rejection; the tool simply stays
  // PENDING for the human (fail-closed).
  if (needsApproval && action.interactionKind() === INTERACTION_KIND.GATE) {
    try {
      const pendingResult = messageThread.strategy?.onToolPending?.({
        toolUseId,
        toolName,
        toolInput: toolInputPlain,
        category: toolDef?.category,
        // The action's permission key (e.g. 'write-file' for every edit-family
        // tool). Lets a strategy tell apart classes of parked call that share a
        // category — edits and shell commands are both category 'write', but
        // only edits report the 'write-file' key — so e.g. auto-approve can
        // defer all file edits to the deterministic file-editing toggle.
        permissionKey: action.getPermissionKey(toolInputPlain)
      });
      if (pendingResult && typeof pendingResult.then === 'function') {
        // The hook returned a still-pending promise: the strategy is reviewing
        // this parked call out-of-band. Surface a transient "reviewing…"
        // indicator for exactly the promise's lifetime (the approval buttons
        // stay fully live throughout — the indicator is purely additive), and
        // clear it when the promise settles.
        setReviewStatus(messageThread, toolUseId, reviewLabelFor(messageThread.strategy));
        pendingResult
          .catch((/** @type {unknown} */ err) => {
            console.error('[handleNewToolAction] onToolPending rejected:', err);
          })
          .finally(() => clearReviewStatus(messageThread, toolUseId));
      }
    } catch (err) {
      console.error('[handleNewToolAction] onToolPending threw:', err);
    }
  }
}

/**
 * Atomically transition a tool-action from APPROVED → RUNNING. Returns
 * true iff this caller made the transition (i.e., "claimed" the execution).
 * The compare-and-set is safe because Yjs observer callbacks are synchronous:
 * no other observer can interleave between the read and the write inside
 * the same transact() block.
 * @param {any} c - Conversation instance
 * @param {any} ymap - Tool-action Y.Map
 * @returns {boolean} True if this caller transitioned APPROVED → RUNNING
 */
export function claimRunning(c, ymap) {
  let claimed = false;
  // APPROVED → RUNNING is a pure derivation of the previously-approved
  // state; tag with ENGINE_DERIVED_ORIGIN so the worker's UndoManager
  // doesn't see it as a separate undoable step.
  c._doc.doc.transact(() => {
    if (ymap.get('state') === TOOL_STATES.APPROVED) {
      ymap.set('state', TOOL_STATES.RUNNING);
      // Stamp the moment execution actually starts so the properties
      // panel's "Running… Xs" elapsed digit anchors to *this* run, not
      // the tool-action's original creation timestamp. Crucial for
      // re-runs of old tool-actions — without it the elapsed time would
      // read "50 hours" against the original timestamp.
      ymap.set('runningStartedAt', Date.now());
      // runningEpoch is the immutable per-incarnation execution generation.
      // Bump it on every claim so a cancel signal (or liveness evidence) can
      // be scoped to the exact execution it was issued against: a re-run of
      // the same toolUseId claims a strictly higher epoch, so a stale cancel
      // meant for the previous execution mismatches and is ignored. Unlike
      // runningStartedAt (a wall-clock stamp that two claims can share within a
      // millisecond, and which the reset paths clear), the epoch is a
      // monotonic counter that survives reattach resets — the next claim
      // increments past it — so it is a true generation identity.
      ymap.set('runningEpoch', (Number(ymap.get('runningEpoch')) || 0) + 1);
      claimed = true;
    }
  }, ENGINE_DERIVED_ORIGIN);
  return claimed;
}

/**
 * Persist the auto-approval grant for a 'yes-always' response. Every grant flows
 * through the plugin's `getApprovalSuggestions` pipeline: a suggestion button
 * carries its exact rules/paths on the tool-action (the common case), and a bare
 * 'yes-always' derives the grant from the plugin's narrowest suggestion (or a
 * framework boolean default). There is no separate per-plugin save method.
 * @param {any} c - Conversation instance
 * @param {any} ymap - The tool-action Y.Map
 * @param {import('./message-thread.js').default} messageThread
 */
export function saveAutoApprovalPermission(c, ymap, messageThread) {
  // Preferred path: the approval button carried the exact rules the chosen
  // suggestion should persist (escalating breadth the user selected). Add
  // them verbatim under the suggestion's itemType — no re-derivation, so the
  // saved permission can't drift from what the button promised.
  const approvalRules = ymap.get('approvalRules');
  const approvalItemType = ymap.get('approvalItemType');
  if (approvalRules && approvalItemType) {
    const rules = approvalRules.toJSON ? approvalRules.toJSON() : approvalRules;
    for (const r of rules) {
      messageThread.addRule(approvalItemType, { kind: r.kind, value: r.value, scope: r.scope });
    }
    return;
  }

  // Path-grant suggestion: the chosen button promised to add folders to the
  // conversation's allowed-paths list (the framework-generic FS roots), not a
  // plugin rule. Add them verbatim — after which isPermitted re-passes the
  // command without any command-shape wildcard.
  const approvalAllowedPaths = ymap.get('approvalAllowedPaths');
  if (approvalAllowedPaths) {
    const paths = approvalAllowedPaths.toJSON ? approvalAllowedPaths.toJSON() : approvalAllowedPaths;
    for (const p of paths) {
      messageThread.addAllowedPath(p, { scope: 'conversation' });
    }
    return;
  }

  // Bare 'yes-always' (no button-carried rules — e.g. a programmatic approval
  // that didn't go through the escalating-suggestion buttons): derive the grant
  // from the plugin's own suggestion pipeline. The narrowest suggestion is the
  // default remembered grant (its rules make isPermitted true by construction);
  // a plugin that offers none gets a framework boolean default under its
  // permission key. This is the single approval-persistence system — there is no
  // separate per-plugin save path.
  const toolName = ymap.get('toolName');
  const toolInputY = ymap.get('toolInput');
  const toolInput = toolInputY?.toJSON ? toolInputY.toJSON() : (toolInputY || {});
  const ActionClass = contextItemRegistry.getByToolName(toolName);
  if (!ActionClass) return;
  const actionId = /** @type {any} */ (ActionClass).MANIFEST?.id || toolName;
  const action = new ActionClass({
    id: actionId,
    session: c._session,
    conversation: c,
    messageThread
  });
  const suggestions = action.getApprovalSuggestions?.(toolInput) || [];
  const grant = suggestions[0] || {
    itemType: action.getPermissionKey(toolInput),
    rules: [{ kind: 'boolean', value: true, scope: 'conversation' }],
  };
  if (grant.itemType && grant.rules) {
    for (const r of grant.rules) {
      messageThread.addRule(grant.itemType, { kind: r.kind, value: r.value, scope: r.scope ?? 'conversation' });
    }
  }
  if (grant.allowedPaths) {
    for (const p of grant.allowedPaths) {
      messageThread.addAllowedPath(p, { scope: 'conversation' });
    }
  }
}

/**
 * Re-check all currently pending approvals against the conversation's latest
 * permission rules, approving any that the owning plugin now permits.
 *
 * This is intentionally keyed off the central permission metadata observer
 * rather than individual approval buttons, so rules added from any surface
 * ("yes-always", permission popup, sync from another client, tests) have the
 * same effect.
 * @param {any} c - Conversation instance
 * @param {{allowViewer?: boolean, itemTypes?: string[]}} [options] Filter/recheck options
 */
export function approvePermittedPendingApprovals(c, options = {}) {
  const opts = /** @type {{allowViewer?: boolean, itemTypes?: string[]}} */ (options);
  if (isViewer() && !opts.allowViewer) return;
  for (const messageThread of c.getAllMessageThreads()) {
    const pending = messageThread.getPendingApprovalMessages();
    for (const toolAction of pending) {
      const toolUseId = toolAction.get('toolUseId');
      const toolName = toolAction.get('toolName');
      const toolInput = toolAction.get('toolInput');
      const toolInputPlain = toolInput?.toJSON ? toolInput.toJSON() : toolInput;
      const ActionClass = contextItemRegistry.getByToolName(toolName);
      if (!ActionClass) continue;

      const actionId = /** @type {any} */ (ActionClass).MANIFEST?.id || toolName;
      if (opts.itemTypes && !opts.itemTypes.includes(actionId)) continue;
      const action = new ActionClass({
        id: actionId,
        session: c._session,
        conversation: c,
        messageThread
      });

      try {
        if (action.isPermitted(toolInputPlain || {})) {
          messageThread.resolveApproval(toolUseId, 'yes');
        }
      } catch (err) {
        console.error(`[Conversation] re-check approval ${toolUseId}:`, err);
      }
    }
  }
}
