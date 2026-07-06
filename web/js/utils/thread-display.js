//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { renderMarkdownWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';
import { stripLLMTags } from './content-utils.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { hasPendingApprovalInTree, isThreadClosed } from '../model/thread-navigation.js';

/**
 * A thread is "closed" when it has a non-empty `result`; until then it has
 * no summary worth showing on the parent tile. Whatever live work is going
 * on inside (streaming an assistant message, awaiting tool approval, etc.)
 * is visible to the user only when they drill into the sub-thread itself —
 * the parent tile face just shows a status block.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {{ text: string, isFinal: boolean }} The final summary if any.
 */
export function getThreadDisplayContent(threadYMap) {
  const result = threadYMap.get('result');
  if (typeof result === 'string' && result.length > 0) {
    return { text: result, isFinal: true };
  }
  return { text: '', isFinal: false };
}

/**
 * @typedef {'closed'|'running'|'pending'|'paused'|'queued'|'errored'|'idle'} ThreadStatusKind
 */

/**
 * @typedef {object} ThreadStatus
 * @property {ThreadStatusKind} kind - Which state the thread is in.
 * @property {string} goal - The thread's user-facing goal ("" if unset).
 * @property {string} message - Status line to render under the goal.
 * @property {boolean} spinner - Whether the status block should show a spinner.
 */

/**
 * @typedef {object} ThreadLiveStatus
 * @property {string} message - Footer-style status message (e.g. "Streaming • 250 tokens"). Empty if not active.
 * @property {string|null} threadId - The thread item ID this status targets, or null for root.
 */

/**
 * Classify a thread's current state for tile-face display. Pure function: the
 * caller passes in a `live` status snapshot (the same one the conversation
 * footer reads from `llmState`) so the tile mirrors footer wording.
 *
 * States enumerated (in precedence order):
 *   paused   — a tool-action anywhere in the subtree is pending approval.
 *   closed   — `result` set; show the summary instead.
 *   running  — worker is actively driving this thread.
 *   pending  — `needsStrategyRun` set but the worker hasn't picked it up yet.
 *   errored  — a nested item is an error message.
 *   queued   — the conversation is still processing (a sibling is the live
 *              thread) but this one hasn't run yet: it's waiting its turn.
 *   idle     — none of the above: the conversation is idle and this thread is
 *              not running and has no result (never started, or its turn ended
 *              without completing). Nothing is actively driving it.
 * @param {any} threadYMap - The thread Y.Map.
 * @param {ThreadLiveStatus|null} [live] - Live LLM status snapshot from llmState.
 * @returns {ThreadStatus} Classification + display fields.
 */
export function getThreadStatus(threadYMap, live) {
  const goal = (threadYMap.get('goal') || '');
  const items = threadYMap.get('items');

  // Awaiting approval is a PURE FUNCTION of the current subtree and trumps
  // everything else — checked FIRST, before `result` and before the live
  // status. A tool-action awaiting approval ANYWHERE below this thread (direct
  // child or buried in a nested sub-thread) parks the whole branch: surface it
  // as 'paused' so this tile AND every ancestor tile turn orange, keeping the
  // visual route from the tab to the action unbroken regardless of nesting
  // depth. This must beat the `result` check below: a thread can legitimately
  // carry a result (e.g. the "interrupted" sentinel written on reload) while a
  // descendant still holds a live pending approval — the dynamic signal wins,
  // we never bake "has a pending child" into the data model. Mirrors the tab's
  // awaiting-trumps-everything rule in conversation-bar._refreshTabStatus.
  if (hasPendingApprovalInTree(items)) {
    return { kind: 'paused', goal, message: 'Waiting for approval', spinner: false };
  }

  // Genuinely finished (result set, nothing awaiting) — same canonical
  // predicate the input-box placement uses, so colour and input never disagree.
  if (isThreadClosed(threadYMap)) {
    return { kind: 'closed', goal, message: '', spinner: false };
  }

  const itemId = threadYMap.get('itemId');
  if (live && live.threadId === itemId && live.message) {
    return {
      kind: 'running',
      goal,
      message: live.message,
      spinner: true,
    };
  }

  if (threadYMap.get('needsStrategyRun')) {
    return { kind: 'pending', goal, message: 'Waiting to start…', spinner: false };
  }

  if (items && typeof items.length === 'number') {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items.get(i);
      if (!it || typeof it.get !== 'function') continue;
      if (it.get('type') === 'error') {
        return { kind: 'errored', goal, message: 'Stopped (error)', spinner: false };
      }
    }
  }

  // A `live` snapshot is non-null only while the conversation is actively
  // processing some thread (see conversation-area._snapshotLiveStatus). We
  // already returned 'running' above if THIS thread were the live one, so
  // reaching here with `live` present means a sibling is being driven and this
  // incomplete thread is simply waiting its turn in the worker's queue — not
  // stopped. Threads launched together run one at a time, so the not-yet-run
  // siblings sit here. Once the conversation goes idle `live` is null and a
  // still-unfinished thread correctly falls through to 'idle'.
  if (live && live.message) {
    return { kind: 'queued', goal, message: 'Waiting for its turn…', spinner: false };
  }

  // "Idle", not "Stopped": with the conversation idle and no result, nothing is
  // driving this thread — but nothing necessarily stopped it either (it may
  // simply never have been started). "Stopped" wrongly implies an interruption.
  return { kind: 'idle', goal, message: 'Idle', spinner: false };
}

/**
 * Paint a thread tile / properties-panel summary surface. Renders the
 * markdown summary when closed; otherwise renders a structured status block
 * (goal line + optional spinner + status line). Shared so the
 * in-conversation tile and the panel stay visually identical.
 * @param {HTMLElement} el - Element to populate.
 * @param {string} text - Summary text (only used when status.kind === 'closed').
 * @param {{status?: ThreadStatus}} [opts]
 */
export function paintThreadSummary(el, text, opts) {
  const status = opts?.status;
  const showSummary = status ? status.kind === 'closed' : !!text;
  if (showSummary) {
    el.className = 'thread-summary';
    el.innerHTML = renderMarkdownWrapped(stripLLMTags(text), { escapeXml: true });
    decorateCodeBlocks(el);
    return;
  }

  if (!status) {
    el.className = 'thread-summary not-summarised';
    el.textContent = 'Thread not yet summarised';
    return;
  }

  el.className = 'thread-summary thread-status';
  el.dataset.kind = status.kind;
  const goalLine = status.goal
    ? `<div class="thread-status-goal">${renderMarkdownWrapped(stripLLMTags(status.goal), { escapeXml: true })}</div>`
    : '';
  const spinnerEl = status.spinner
    ? '<juggler-spinner class="thread-status-spinner" style="--size: 0.9em"></juggler-spinner>'
    : '';
  const msgLine = `<div class="thread-status-message">${spinnerEl}<span>${escapeHtml(status.message || '')}</span></div>`;
  el.innerHTML = `${goalLine}${msgLine}`;
  // Record the goal source we just rendered so the next in-place text update
  // (paintThreadStatusText) can skip re-parsing the markdown when it's unchanged.
  const goalEl = /** @type {GoalEl|null} */ (el.querySelector('.thread-status-goal'));
  if (goalEl) goalEl._renderedGoalSrc = status.goal || '';
}

/**
 * @typedef {HTMLElement & { _renderedGoalSrc?: string }} GoalEl
 */

/**
 * Render `goalSrc` markdown into `goalEl`, but only when it differs from the
 * goal source last rendered into that element. The goal almost never changes
 * while the status message ticks ~1Hz, so skipping the rewrite avoids
 * needlessly re-parsing the markdown and replacing the `.thread-status-goal`
 * subtree on every tick. Safe because the render is a pure function of the
 * source string.
 * @param {GoalEl} goalEl
 * @param {string} goalSrc
 */
function renderGoalInto(goalEl, goalSrc) {
  const src = goalSrc || '';
  if (goalEl._renderedGoalSrc === src) return;
  goalEl._renderedGoalSrc = src;
  goalEl.innerHTML = src
    ? renderMarkdownWrapped(stripLLMTags(src), { escapeXml: true })
    : '';
  decorateCodeBlocks(goalEl);
}

/**
 * Update only the text content of an already-painted status block (goal +
 * message). Leaves the `<juggler-spinner>` element and the surrounding
 * structure untouched so CSS animations (spinner rotation, parent icon-box
 * pulse) don't restart. Caller must ensure the block was previously painted
 * by `paintThreadSummary` with a non-closed `status`.
 * @param {HTMLElement} el - The `.thread-summary.thread-status` element.
 * @param {ThreadStatus} status - Current status.
 */
export function paintThreadStatusText(el, status) {
  el.dataset.kind = status.kind;
  const goalEl = /** @type {GoalEl|null} */ (el.querySelector('.thread-status-goal'));
  if (goalEl) renderGoalInto(goalEl, status.goal);
  const msgSpan = el.querySelector('.thread-status-message > span');
  if (msgSpan) msgSpan.textContent = status.message || '';
}
