//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { wrapWithIcon } from '../utils/icon-message-renderer.js';
import { badgeForItem } from '../utils/item-badge.js';
import { getThreadStatus, paintThreadSummary, paintThreadStatusText } from '../utils/thread-display.js';
import { applyCollapsible } from '../utils/collapsible.js';

/**
 * ThreadMessage — parent-tile rendering of a sub-thread.
 *
 * Until the thread is closed (has a `result`), the tile shows a status block
 * (goal + spinner + status line) reflecting the sub-thread's current state.
 * The status string mirrors the conversation footer's wording for that
 * thread (e.g. "Streaming • 250 tokens"), driven by an `llmState` snapshot
 * the parent column hands in. After closure the tile shows the summary.
 */
class ThreadMessage extends HTMLElement {
  constructor() {
    super();
    /** @type {any|null} @private */
    this._item = null;
    /** @type {import('../utils/thread-display.js').ThreadLiveStatus|null} @private */
    this._live = null;
    /**
     * Structural-mode key: full DOM is rebuilt only when this changes, so the
     * spinner and icon-box (whose `icon-pulse` animation is tied to
     * `article[data-processing="true"]`) survive in-place text updates and
     * their CSS animations don't reset every tick.
     * @type {string|null} @private
     */
    this._mode = null;
    /**
     * Content signature of what was last painted (result text when closed, or
     * the status fields otherwise). render() is driven on every tile by the
     * column's ~1Hz live-status broadcast, so without this guard a closed
     * thread would re-parse its markdown summary and replace innerHTML every
     * tick. Repaint is skipped when this is unchanged.
     * @type {string|null} @private
     */
    this._paintedKey = null;
  }

  connectedCallback() {
    this.render();
  }

  static get observedAttributes() {
    return ['goal', 'child-count'];
  }

  attributeChangedCallback() {
    if (!this.isConnected) return;
    this.render();
  }

  /**
   * Update from Y.Map item data (called by _notifyChangedElements).
   * Also accepts the conversation's live LLM status so the tile can mirror
   * the footer wording while the thread is running.
   * @param {any} item - The thread Y.Map.
   * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} [live] - Live LLM status.
   */
  updateFromItem(item, live) {
    this._item = item;
    if (live !== undefined) this._live = live;
    this.render();
  }

  /**
   * Refresh status from a new live status snapshot without changing the item.
   * Called by the column when only the llmState message changed.
   * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} live
   */
  setLiveStatus(live) {
    this._live = live;
    if (this._item) this.render();
  }

  /**
   * Thread tiles render their own status block when not closed, so the
   * parent column's footer should NOT duplicate it with another
   * spinner/text. Returning null keeps the footer quiet; the tile face is
   * the single source of "what's this thread doing right now".
   * @returns {null} Always null — tile is self-rendered.
   */
  getBusyState() {
    return null;
  }

  /**
   * Build the tile's stop button. Click dispatches `cancel-thread-requested`
   * (bubbling + composed) carrying this thread's itemId; the conversation-tab
   * resolves it to conversation.cancelThread.
   * @returns {HTMLButtonElement} The stop button element.
   * @private
   */
  _buildStopButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thread-action-btn thread-stop-btn';
    btn.title = 'Stop this thread';
    btn.setAttribute('aria-label', 'Stop this thread');
    btn.textContent = 'Stop';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const threadItemId = this._item?.get?.('itemId');
      if (!threadItemId) return;
      this.dispatchEvent(new CustomEvent('cancel-thread-requested', {
        detail: { threadItemId },
        bubbles: true,
        composed: true
      }));
    });
    return btn;
  }

  render() {
    const status = this._item ? getThreadStatus(this._item, this._live) : null;
    const isClosed = status?.kind === 'closed';
    // The tile shows a Stop button only when the subtree actually has something
    // to stop: it's the live processing column (running), about to be driven
    // (pending), or parked on an approval (paused). A queued/idle/errored tile
    // owns no in-flight work, so a Stop there would be misleading — and clicking
    // it could only stamp the tile, never preempt a sibling (see
    // conversation.cancelThread / _threadOwnsActiveWork).
    const stoppable = !!status &&
      (status.kind === 'running' || status.kind === 'pending' || status.kind === 'paused');
    // Source of truth: the cached item's `result`. Don't read the attribute —
    // it's only set at create time and would go stale after the worker writes
    // the summary.
    const result = (this._item?.get?.('result') || '');

    // Structural mode: only changes when summary/status surface or spinner
    // presence flips. Within a mode we update text in place so the spinner
    // element and the icon-box (with its pulse animation) persist.
    const mode = !this._item
      ? 'empty'
      : isClosed
        ? 'closed'
        : `status:${status?.spinner ? '1' : '0'}:${stoppable ? 'stop' : 'nostop'}`;

    // Content signature: what would actually be painted this tick. Lets us
    // skip the in-place repaint when nothing visible changed (the common case
    // when the column rebroadcasts live status to every tile each second).
    const key = !this._item
      ? 'empty'
      : isClosed
        ? `closed:${result}`
        : `status:${status?.kind}:${status?.goal}:${status?.message}:${status?.spinner ? 1 : 0}`;

    if (this._mode !== mode) {
      this._mode = mode;
      this._paintedKey = key;
      const article = document.createElement('article');
      article.className = 'thread-item';
      if (!isClosed) article.setAttribute('data-processing', 'true');

      const summaryDiv = document.createElement('div');
      paintThreadSummary(summaryDiv, result, status ? { status } : undefined);

      // Icon + "Thread" lozenge come from the one shared badge resolver (same
      // code the properties-panel header uses), grouped with the icon via
      // wrapWithIcon's badge option so they keep a fixed layout, exactly like
      // the type badge on the other context-item tiles.
      const badge = badgeForItem(this._item, { fallbackType: 'thread' });
      article.appendChild(wrapWithIcon(summaryDiv, { ...badge, badge: badge.typeName }));

      // Stop affordance: when the subtree has live work to stop (running /
      // pending / paused) the user can stop it straight from the parent tile —
      // they shouldn't have to drill into the column header. The click is the
      // action site, so it dispatches a bubbling request that the tab resolves
      // to conversation.cancelThread (subtree-scoped cancel + 'Cancelled'
      // summary). stopPropagation keeps the click from also selecting the tile.
      // It lives inside the status-message row (right-aligned) so it sits with
      // the status line rather than overlaying the goal text.
      if (stoppable) {
        const msgEl = summaryDiv.querySelector('.thread-status-message');
        (msgEl || article).appendChild(this._buildStopButton());
      }

      this.replaceChildren(article);
      // Now attached — clamp an overly long summary behind a Show more toggle.
      // Only the closed-state markdown summary is collapsible; the live status
      // block is always short. Keyed by the thread id so an expanded summary
      // stays expanded across the tile's in-place repaints.
      if (isClosed) applyCollapsible(summaryDiv, { key: this._item?.get?.('itemId') || '' });
      return;
    }

    // Same structural mode — skip the repaint entirely if the painted content
    // is identical to last tick (the ~1Hz live-status broadcast hits every
    // tile, but most have nothing new to show).
    if (this._paintedKey === key) return;
    this._paintedKey = key;

    const summaryDiv = /** @type {HTMLElement|null} */ (this.querySelector('.thread-summary'));
    if (!summaryDiv) return;
    if (isClosed) {
      paintThreadSummary(summaryDiv, result, { status });
      applyCollapsible(summaryDiv, { key: this._item?.get?.('itemId') || '' });
      return;
    }
    if (status) paintThreadStatusText(summaryDiv, status);
  }
}

customElements.define('thread-message', ThreadMessage);

export default ThreadMessage;
