//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';
import { INTERACTION_KIND } from 'juggler/context-item';

/**
 * Shared base for the hidden strategies the sub-agent context items own.
 *
 * A sub-agent thread has **no human in it**. That single fact decides the whole
 * design:
 *
 *   - `canSpawnThreads` is the flag meaning "a human is steering this thread",
 *     and a delegated child is never granted it;
 *   - a parked tool stays parked until somebody resolves it, and
 *     `APPROVAL_POLICY` has no DENY — only APPROVE / REQUIRE_APPROVAL / DEFAULT.
 *
 * So **any tool a sub-agent exposes but cannot auto-approve is a hang, not a
 * prompt**. The invariant every subclass must keep is therefore: whatever
 * survives `filterTools` is either auto-approved by {@link getApprovalPolicy}
 * or refused outright by {@link onToolPending}. Nothing is ever left parked.
 *
 * A sub-agent's brief is its `static GUIDANCE`: the base class injects it as a
 * durable system-reminder when the strategy activates, which in a freshly-born
 * delegated thread puts it first in the transcript after the seed.
 *
 * These strategies are `hidden`, so they never appear in the strategy selector,
 * the Shift+Tab ring, the default picker or the command editor. The user picks a
 * sub-agent by calling its tool; the strategy id is an implementation detail.
 * @augments {StrategyType}
 * @abstract
 */
export default class SubagentStrategyType extends StrategyType {
  /**
   * Tools no sub-agent may ever be handed, whatever its category filter says.
   *
   * Two kinds, and both are about the missing human:
   *   - **blocks on a person**: `AskUserQuestion`. Note its category is `read`,
   *     so a naive read-only filter KEEPS it — and as an *elicitation* it can
   *     neither be auto-approved (that would answer for the user) nor refused by
   *     `onToolPending` (which never fires for elicitations), so it is the one
   *     tool that would genuinely wedge a sub-agent run. Any future elicitation
   *     tool must be added here for the same reason.
   *   - **steers the caller's session**: `todo`, `plan`, `memory`,
   *     `define_command`, `new_conversation`. A child answering one question has
   *     no business rewriting the parent's plan or the user's project memory.
   *
   * Sub-agent tools are not named here, though they are equally unusable: they
   * are dropped by {@link withoutWithheld} on their `requiresDelegation` flag
   * instead, so a third-party sub-agent is covered without having to know this
   * list exists. `create_thread` needs no entry at all — the worker withholds it
   * from every delegated thread on the `canSpawnThreads` capability.
   * @type {readonly string[]}
   */
  static WITHHELD = Object.freeze([
    'AskUserQuestion',
    'todo',
    'plan',
    'memory',
    'define_command',
    'new_conversation'
  ]);

  /**
   * Drop the tools no sub-agent may have. Subclasses build their own filter on
   * top of this, never instead of it.
   *
   * Two rules: the named {@link WITHHELD} set, and every tool declaring
   * `requiresDelegation` — a tool with no inline path, which inside a delegated
   * thread could not delegate and so could only fail. The second is a flag test
   * rather than a name list because the worker applies exactly the same rule
   * server-side (`filterToolsForThread`, `llm_request.go`); keeping them
   * expressed the same way is what stops the two filters drifting into
   * disagreement, with this one admitting a tool the other must then strip.
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools - Candidate tools
   * @returns {import('juggler/strategy-type').ToolDefinition[]} Tools minus the withheld set
   * @protected
   */
  withoutWithheld(tools) {
    const withheld = /** @type {typeof SubagentStrategyType} */ (this.constructor).WITHHELD;
    return tools.filter(t => !withheld.includes(t.name) && !t.requiresDelegation);
  }

  /**
   * Approve what the permission system already allows; leave everything else to
   * {@link onToolPending}, which refuses it.
   *
   * `defaultApproval === false` means the permission system raised no question —
   * an in-project read, an allowlisted command — so the call runs unattended.
   * Anything else is a call the user would have been asked about, and there is
   * nobody here to ask, so it must not run silently either: it parks for the
   * instant it takes `onToolPending` to deny it.
   * @override
   * @param {{toolName: string, toolInput: Record<string, unknown>, category: string|undefined, defaultApproval: boolean, interactionKind: string, autoApprovable: boolean}} info - Approval context
   * @returns {'approve'|'require-approval'|'default'} Approval policy
   */
  getApprovalPolicy({ toolName, defaultApproval, interactionKind, autoApprovable }) {
    if (interactionKind === INTERACTION_KIND.ELICITATION) {
      // Unreachable while every elicitation is in WITHHELD — and it must stay
      // that way, because this is the one case with no safe answer: approving it
      // decides for a user who isn't here, and parking it waits for one forever.
      console.error(`[subagent] ${this.getManifest().id} exposed the elicitation "${toolName}"; it will park with nobody to answer it. Add it to WITHHELD.`);
      return APPROVAL_POLICY.DEFAULT;
    }
    // A deliberate human checkpoint (a plan submit, a catastrophic delete) is
    // never ticked past silently — it parks, and is then refused rather than
    // waiting for a review that cannot happen here.
    if (autoApprovable === false) return APPROVAL_POLICY.DEFAULT;
    return defaultApproval ? APPROVAL_POLICY.DEFAULT : APPROVAL_POLICY.APPROVE;
  }

  /**
   * Refuse anything that parked. This is the other half of the no-hang
   * invariant: a sub-agent thread has nobody to approve a call, so leaving one
   * parked would strand the caller's tool_use for the life of the conversation.
   *
   * The refusal goes through `refuseApproval`, which settles the call as a
   * failed tool — not through `resolveApproval(id, 'no')`, which marks it
   * cancelled. A cancelled call is how a *human* denial is recorded, and the
   * worker stops the turn on one, so refusing that way would end the sub-agent's
   * run at its first awkward call rather than letting it work around it.
   * @override
   * @param {{toolUseId: string, toolName: string}} info - The parked call
   * @returns {void}
   */
  onToolPending({ toolUseId, toolName }) {
    this.messageThread.refuseApproval(toolUseId,
      `Refused: ${toolName} needed approval, and a sub-agent has nobody to ask. `
      + 'Find another way, or report what you could not check.');
  }
}
