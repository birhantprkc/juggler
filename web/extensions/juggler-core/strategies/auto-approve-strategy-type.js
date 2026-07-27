//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { generateText } from 'juggler/ops';
import DefaultStrategyType from './default-strategy-type.js';
import { POLICY_PROMPT, buildReviewerPrompt, parseVerdict } from './auto-approve-reviewer.js';
import { WRITE_FILE_ITEM_TYPE } from '../../../js/services/file-editing-permission.js';

/**
 * AutoApproveStrategyType - Default behavior plus an out-of-band safety reviewer
 * that silently approves parked tool calls it is confident are safe.
 *
 * This sits one rung more autonomous than Default on the autonomy axis
 * (Read-only → Default → Auto-approve → YOLO). It extends DefaultStrategyType,
 * so it inherits the full toolset and Default's approval policy unchanged: read
 * tools, allowlisted commands, and in-project edits are still auto-permitted by
 * the permission system before anything parks. Only the genuinely ambiguous
 * calls that *would* prompt you reach the `onToolPending` hook below.
 *
 * The design is **allow-only and fail-closed**. When a call parks, a cheap
 * out-of-band model classifies it and — only on a clean `allow` — resolves it.
 * Every other outcome (deny, a saturated/timed-out/errored `generateText`, a
 * malformed answer) does nothing, leaving the tool parked for the human exactly
 * as today. So this strategy can only ever *remove* an approval prompt you would
 * have granted; it can never block the model or auto-run something the reviewer
 * distrusts.
 *
 * The reviewer is shown only the user's own messages and the agent's raw tool
 * calls — never the agent's prose, never tool output (see
 * `auto-approve-reviewer.js`). In allow-only mode the only harmful mistake is a
 * wrong *allow*, and those are the two channels that manufacture one.
 *
 * **File edits are deliberately out of the reviewer's remit.** A file write only
 * reaches this hook when it has already parked, and an edit parks for exactly two
 * reasons: the conversation's file-editing toggle is off (the user asked to
 * eyeball every edit), or the write targets a path outside the project and
 * granted roots (the containment guard in `edit-base.js`, issues #23/#24). Both
 * are cases we want a human to decide, so the deterministic file-editing toggle
 * owns edits end to end and this reviewer never resolves a `write-file` action —
 * it only ever clears the routine *non-edit* prompts (allowlistable commands,
 * out-of-root reads). Approving edits wholesale is what YOLO is for.
 *
 * While `onToolPending`'s returned promise is in flight the framework surfaces a
 * transient "Auto-approve reviewing…" indicator in the approval card (label
 * derived from this manifest's `name`); the approval buttons stay fully live, so
 * the human can always decide instantly and race the reviewer.
 *
 * Future (deliberately out of scope for v1): hard-deny with rationale fed back
 * to the model, a per-turn circuit breaker, a per-strategy reviewer-model
 * setting UI, and surfacing the reviewer's rationale in the approval card.
 * @augments {DefaultStrategyType}
 */
export default class AutoApproveStrategyType extends DefaultStrategyType {
  /**
   * Strategy manifest describing capabilities and recommendations.
   *
   * MANIFEST is mandatory here even though we extend Default: static props are
   * inherited in JS, so omitting it would make this strategy report `id:
   * 'default'` and collide. (Yolo defines its own for the same reason.)
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'auto-approve',
    name: 'Auto-approve',
    version: '1.0.0',
    description: 'Like Default, but a cheap model auto-approves the routine prompts it is sure are safe — so you only get asked about the risky ones.',
    author: 'Juggler Team',
    color: 'var(--accent-green)',
    icon: 'icon-auto-awesome',
    order: 1,
    // Denied/unreviewed actions still park and use the permission toggles.
    showsApprovalControls: true,
    // Inherit Default's approval behaviour wholesale; Default ships no default
    // rules today, so there is nothing to copy.
    defaultRules: [],
    recommendations: {
      recommendedFor: [
        "Longer autonomous runs where you're semi-watching",
        'Cutting approval fatigue on routine edits and safe commands',
        'Trusted projects where most actions are benign'
      ],
      exampleTriggers: [
        "keep going without asking unless it's risky...",
        'auto-approve the safe stuff...',
        "don't stop for every little command..."
      ],
      approach: 'Auto-approve runs the same loop as Default, so the permission system still decides everything first: read tools, allowlisted commands, and in-project edits are approved automatically, and only the calls that would otherwise stop to ask you are handed off for review.\n\n'
        + 'Each parked call is checked by a cheap, fast model — the one set as your cheap model in settings — against a fixed safety policy. To keep that judgement trustworthy the reviewer sees only your own messages and the agent\'s raw tool calls; it never sees the agent\'s explanations or any tool output, so it cannot be argued into an approval or fed instructions hidden in a tool result.\n\n'
        + 'The reviewer answers a simple allow or deny. A confident allow silently approves the call and the run continues. Anything else — a deny, an uncertain answer, a timeout, or a reviewer that is busy or errors — leaves the call parked for you to decide, exactly as under Default.\n\n'
        + 'Because it only ever approves, the strategy can remove a prompt you would have granted but can never block the model or run something on its own that the reviewer distrusts.',
      tradeoffs: {
        pros: [
          'Fewer prompts for obviously-safe actions',
          'Can only remove prompts, never blocks or auto-runs something risky',
          'Uses a cheap/fast model, low cost per review'
        ],
        cons: [
          'Adds ~1–3s latency to a parked call while it reviews',
          'The reviewer is a probabilistic model and will sometimes leave a safe action parked',
          'Not a security boundary — for untrusted code use Read-only'
        ]
      }
    }
  };

  /**
   * Review a freshly-parked tool call out-of-band and silently approve it iff
   * the reviewer is confident it is safe and user-authorized.
   *
   * Fire-and-forget by contract (see StrategyType#onToolPending): the framework
   * does not await this and ignores its return value, so any error just leaves
   * the tool parked — fail-closed. We only ever call `resolveApproval(_, 'yes')`
   * on a clean `allow`; for deny (or any failure) we do nothing.
   * The framework only fires this hook for **gate** interactions (see
   * StrategyType#onToolPending / INTERACTION_KIND). Elicitations like
   * AskUserQuestion are never delivered here — their resolution is the user's
   * own input, which no reviewer can supply — so this method needs no guard
   * against auto-answering a question.
   * @override
   * @param {{toolUseId: string, toolName: string, toolInput: Record<string, unknown>, category: string|undefined, permissionKey: string}} info
   * @returns {Promise<void>}
   */
  async onToolPending({ toolUseId, toolName, toolInput, category, permissionKey }) {
    // `category` is unused in v1 but kept for future use (e.g. skipping review
    // for 'meta' tools). Reference it so the destructure isn't dead.
    void category;
    // File edits are never auto-approved by the reviewer — the deterministic
    // file-editing toggle owns them (see the class doc). Leave the write parked
    // for the human. Guarding on the permission key (not a tool-name list) keeps
    // every current and future edit-family plugin covered uniformly.
    if (permissionKey === WRITE_FILE_ITEM_TYPE) return;
    try {
      const prompt = buildReviewerPrompt(this.messageThread.items, { toolName, toolInput });
      const model = /** @type {any} */ (this.state)?.reviewerModel ?? 'cheap';
      const { text } = await this._complete(
        { system: POLICY_PROMPT, prompt, model, maxTokens: 16 },
        this._abortController?.signal
      );
      if (parseVerdict(text) === 'allow') {
        this.messageThread.resolveApproval(toolUseId, 'yes');
      }
      // deny → intentionally do nothing; the tool stays parked for the human.
    } catch (err) {
      // Fail-closed: any error (429 busy, timeout, network, parse) leaves the
      // tool parked. Log for diagnosis; never rethrow (the framework ignores it
      // anyway, but keep it tidy).
      console.error('[auto-approve] review failed, leaving parked:', err);
    }
  }

  /**
   * Thin seam around the out-of-band completion call, so tests can stub the LLM
   * without a network round-trip. Do not add logic here — it must stay a plain
   * pass-through to `generateText`.
   * @param {import('../../../js/services/ops-api.js').GenerateTextParams} params
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../../js/services/ops-api.js').GenerateTextResult>} The generated text and usage
   */
  async _complete(params, signal) {
    return generateText(params, signal);
  }
}
