//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { renderAssistantContentWrapped, renderMarkdownWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';
import { stripLLMTags } from './content-utils.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { hasPendingApprovalInTree, hasUnsettledToolInTree } from '../model/thread-navigation.js';
import { canonicalThread, itemGoal, itemRunRecord } from '../model/thread-alias.js';

/**
 * What a thread tile shows: the result of the ONE run that item stands for.
 *
 * A thread called more than once has one parent item per call (see
 * model/thread-alias.js), and each shows its own run's result, frozen when that
 * run settled — so a later call can never rewrite what an earlier tile says.
 * An item with no run selector falls back to the thread's `result`, its current
 * summary: a user-created thread, a fold, and every document written before
 * aliases record completion only there.
 *
 * Until the run has come to rest there is nothing worth showing on the tile.
 * Whatever live work is going on inside (streaming an assistant message,
 * awaiting tool approval) is visible only when the user drills into the
 * sub-thread itself — the tile face just shows a status block.
 * @param {any} threadYMap - The thread item Y.Map (canonical or alias).
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {{ text: string }} The summary, or '' when there is none.
 */
export function getThreadDisplayContent(threadYMap, siblingArray) {
  const record = itemRunRecord(threadYMap, siblingArray);
  if (record) return { text: record.result };
  const result = threadYMap.get('result');
  return { text: (typeof result === 'string') ? result : '' };
}

/**
 * @typedef {'running'|'pending'|'paused'|'queued'|'errored'|'idle'} ThreadStatusKind
 */

/**
 * @typedef {object} ThreadStatus
 * @property {ThreadStatusKind} kind - Which state the thread is in.
 * @property {string} goal - The thread's user-facing goal ("" if unset).
 * @property {string} message - Status line to render under the goal.
 * @property {boolean} spinner - Whether the status block should show a spinner.
 * @property {boolean} [showSummary] - Paint the thread's summary instead of a
 *   status block. Set only when the thread is genuinely at rest, so the several
 *   surfaces that render a tile never re-derive "is it resting" and disagree.
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
 *   running  — worker is actively driving this thread.
 *   pending  — `needsStrategyRun` set but the worker hasn't picked it up yet.
 *   errored  — a nested item is an error message.
 *   queued   — the conversation is still processing (a sibling is the live
 *              thread) but this one hasn't run yet: it's waiting its turn.
 *   idle     — none of the above: nothing is actively driving this thread. It
 *              is stopped, which is a resting state, not a terminal one — it
 *              may never have started, or it may have run and come to rest
 *              carrying a summary. Either way it accepts a message and runs
 *              again; the tile face shows the summary when there is one.
 * @param {any} threadYMap - The thread item Y.Map (canonical or alias).
 * @param {ThreadLiveStatus|null} [live] - Live LLM status snapshot from llmState.
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {ThreadStatus} Classification + display fields.
 */
export function getThreadStatus(threadYMap, live, siblingArray) {
  // The transcript hangs off the canonical: an alias asks every subtree question
  // of the thread it is a view of.
  const thread = canonicalThread(threadYMap, siblingArray);
  // The goal THIS item's call named, not the session's current one: a tile
  // describes the call it was made by, and the thread's `goal` moves with the
  // latest call (see itemGoal in model/thread-alias.js).
  const goal = itemGoal(threadYMap, siblingArray);

  const items = thread.get('items');

  // Awaiting approval is a PURE FUNCTION of the current subtree and trumps
  // everything else — checked FIRST, before `result` and before the live
  // status. A tool-action awaiting approval ANYWHERE below this thread (direct
  // child or buried in a nested sub-thread) parks the whole branch: surface it
  // as 'paused' so this tile AND every ancestor tile turn orange, keeping the
  // visual route from the tab to the action unbroken regardless of nesting
  // depth. A thread can legitimately carry a summary while a descendant still
  // holds a live pending approval — the dynamic signal wins, we never bake
  // "has a pending child" into the data model. It trumps a settled run too: an
  // approval is a request for the user, and which call it arose under is no
  // reason to hide the route to it. Mirrors the tab's awaiting-trumps-everything
  // rule in conversation-bar._refreshTabStatus.
  if (hasPendingApprovalInTree(items)) {
    return { kind: 'paused', goal, message: 'Waiting for approval', spinner: false };
  }

  // An item stamped with a run selector answers for THAT run alone. Once it has
  // settled the tile is frozen: what a later call into the same thread does is
  // another item's business, and a historic tile that started spinning again
  // would be reporting work its own call never asked for.
  const record = itemRunRecord(threadYMap, siblingArray);
  if (record?.status) {
    return record.result
      ? { kind: 'idle', goal, message: '', spinner: false, showSummary: true }
      : { kind: 'idle', goal, message: 'Idle', spinner: false };
  }

  // Keyed on the canonical, because that is the thread the worker names when it
  // reports what it is driving. Only an item whose own run is still open reaches
  // here, so the spinner lands on the call being answered and nowhere else.
  const itemId = thread.get('itemId');
  if (live && live.threadId === itemId && live.message) {
    return {
      kind: 'running',
      goal,
      message: live.message,
      spinner: true,
    };
  }

  if (thread.get('needsStrategyRun')) {
    return { kind: 'pending', goal, message: 'Waiting to start…', spinner: false };
  }

  // At rest carrying a summary from an earlier run: nothing is driving it, so
  // the tile shows that summary instead of a status line. This sits BELOW the
  // live check — a thread being driven again reports 'running', so a resumed
  // thread shows its spinner rather than a stale summary — and ABOVE the error
  // and queued fall-throughs, which describe threads that never came to rest.
  //
  // "At rest" still has to be derived, never taken from the summary alone: a
  // thread mid-tool-use is working regardless of what text sits on it, so an
  // unsettled tool anywhere below keeps it out of this branch.
  //
  // Only threads with no run selector get here: an item that stands for one run
  // was answered above, and borrowing the thread's current summary for a run
  // still in flight would show it the previous call's reply.
  const result = !record ? thread.get('result') : '';
  if (typeof result === 'string' && result.length > 0 && !hasUnsettledToolInTree(items)) {
    return { kind: 'idle', goal, message: '', spinner: false, showSummary: true };
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
 * markdown summary when the thread is at rest and has one; otherwise renders a
 * structured status block (goal line + optional spinner + status line). Shared
 * so the in-conversation tile and the panel stay visually identical.
 * @param {HTMLElement} el - Element to populate.
 * @param {string} text - Summary text (only used when status.showSummary).
 * @param {{status?: ThreadStatus}} [opts]
 */
export function paintThreadSummary(el, text, opts) {
  const status = opts?.status;
  const showSummary = status ? !!status.showSummary : !!text;
  if (showSummary) {
    el.className = 'thread-summary';
    el.innerHTML = renderAssistantContentWrapped(stripLLMTags(text));
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
  // A status with nothing to say and no spinner renders no line at all, rather
  // than an empty one the column gap would still space out.
  const msgLine = (status.message || status.spinner)
    ? `<div class="thread-status-message">${spinnerEl}<span>${escapeHtml(status.message || '')}</span></div>`
    : '';
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
 * by `paintThreadSummary` with a status of the same shape — one that painted a
 * status block rather than a summary, and whose message and spinner presence
 * are unchanged. Anything else changes which elements exist, so it needs a
 * fresh `paintThreadSummary` instead.
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
