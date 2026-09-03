//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {object} FooterState
 * @property {boolean} isProcessing - LLM is actively processing (includes "waiting for user approval" — in that case statusMessage describes the wait)
 * @property {boolean} canContinue - Whether continue is possible (has messages)
 * @property {string} [statusMessage] - Optional status message when processing
 * @property {boolean} [showSpinner] - Whether to show the spinner animation (default true)
 * @property {string} [nextSteps] - Optional next steps guidance
 * @property {boolean} [showDuplicateTab] - Whether to show the duplicate tab button (root thread only)
 * @property {string} [busyItemMessageId] - message-id of the busy thread item, enables clicking footer to select it
 * @property {boolean} [politePending] - A polite stop (Pause) covering this column is still winding its work down: render the Pause button active
 * @property {boolean} [politePaused] - A Pause covering this column has landed: this thread is at rest and runs nothing until it is lifted
 * @property {number} [runningTools] - How many tool-actions are executing right now; drives the spinner's club count
 * @property {number} [throughput] - Output tokens per second right now (0 when nothing is streaming); drives the spinner's speed
 * @property {number|null} [toolWaitMs] - How long the longest-running tool call has been running, or null when none is; drives the spinner's tool-wait ramp
 * @property {number} [lastActivityAt] - When the thread last changed, Unix ms; 0 or absent hides the timestamp
 */

/**
 * ConversationFooter - footer element at the end of a conversation.
 *
 * Token counts are read on-demand from the transaction blob of the most
 * recent assistant message in this thread (see findLastAssistantTxnId).
 * Nothing is persisted in Yjs: the blob on disk is the only record.
 * A small per-element cache keyed by transactionId avoids refetching
 * on every items-array event.
 *
 * ## Status-only mode
 *
 * A column that shows a folded tool run (see `setStatusOnly`) is a lens on part
 * of a thread, not a thread: every idle-row control acts on the whole thread and
 * the token meter counts the whole thread, so both would lie about what the
 * column shows. In that mode the footer keeps only the status line — which its
 * owner scopes to the run's own rows — and disappears entirely when the run is
 * settled.
 */
import { findLastAssistantTxnId, findLastAssistantItemId } from '../utils/transaction-anchor.js';
import { formatRelativeDateTime } from '../utils/format.js';
import providersCache from '../services/providers-cache.js';
import { openSettings } from '../services/settings-launcher.js';

const TOKEN_UPDATE_DEBOUNCE_MS = 2000;

/** Magnifier over a document: inspect this conversation's log file. */
const LOG_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M458-280q18 0 35.5-4.5T526-298l98 98 56-56-98-98q9-15 13.5-32.5T600-422q0-58-41-98t-99-40q-58 0-99 41t-41 99q0 58 40 99t98 41Zm2-80q-25 0-42.5-17.5T400-420q0-25 17.5-42.5T460-480q25 0 42.5 17.5T520-420q0 25-17.5 42.5T460-360ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z"/></svg>';

class ConversationFooter extends HTMLElement {
  /** @type {import('../model/message-thread.js').default} */
  _messageThread = /** @type {any} */ (null);
  /** @type {(() => void)|null} */
  _unsubscribe = null;
  /**
   * Unsubscribe from the LLMState status-observer feed. Separate from
   * `_unsubscribe` (session events): the status observer fires on every
   * mid-turn usage update, driving the live-growing meter without the 2s
   * event debounce.
   * @type {(() => void)|null}
   */
  _statusUnsubscribe = null;

  /**
   * Cache of resolved transaction-blob token totals, keyed by
   * transactionId. Lookups are global to the element instance
   * (same conversation for the element's lifetime, so no key
   * collision risk). `cachedTokens` is null when the blob carries no
   * cache figure — the provider reported none for that call, which is
   * unknown rather than a miss.
   * @type {Map<string, {inputTokens: number, cachedTokens: number|null, inputTokensApproximate: boolean}|null>}
   * @private
   */
  _blobTokenCache = new Map();

  /**
   * Transaction id currently being fetched, or empty string.
   * Used to avoid stacking duplicate in-flight fetches.
   * @type {string}
   * @private
   */
  _pendingTxnId = '';

  /**
   * Debounce timer for event-driven token refreshes. Conversation/status
   * updates can arrive many times per second while the LLM streams; delaying
   * the refresh keeps the last stable count visible instead of briefly
   * clearing it on each transaction-blob cache miss.
   * @type {number|undefined}
   * @private
   */
  _tokenUpdateTimer = undefined;

  /**
   * Status-only mode: the footer is reduced to the status line (see the class
   * comment). Set by the owning column, and applied structurally by
   * `_applyStatusOnly` rather than on every `update()` tick.
   * @type {boolean}
   * @private
   */
  _statusOnly = false;

  /**
   * Metadata observer watching `undoState` while the Undo offer is showing,
   * so the offer can retire the moment its undo entry stops being the one
   * `undo()` would pop. Attached on show, detached on hide — an offer is rare
   * and short-lived, so there is nothing to observe the rest of the time.
   * @type {((event: any) => void)|null}
   * @private
   */
  _undoObserver = null;

  /**
   * `undoState.seq` of the undo entry the visible offer refers to, or null
   * while the offer is still waiting to see it (the delete's own frame has not
   * synced back yet). See `_showUndoOffer`.
   * @type {number|null}
   * @private
   */
  _undoOfferSeq = null;

  /**
   * Whether the last `update` saw a running turn, so the start of a turn can be
   * told apart from the many ticks that follow it. Only the rising edge offers
   * the spinner its once-per-turn fumble; every tick after that must not.
   * @type {boolean}
   * @private
   */
  _wasProcessing = false;

  disconnectedCallback() {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    if (this._statusUnsubscribe) { this._statusUnsubscribe(); this._statusUnsubscribe = null; }
    this._hideUndoOffer();
    this._cancelDeferredTokenDisplayUpdate();
  }

  /**
   * Set the message thread and subscribe to session events for token refresh.
   * @param {import('../model/message-thread.js').default} mt
   */
  setMessageThread(mt) {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    if (this._statusUnsubscribe) { this._statusUnsubscribe(); this._statusUnsubscribe = null; }
    // Only a real change of thread retires the Undo offer. A column re-hands
    // its footer the thread it already has on every rebuild, and a rebuild runs
    // on any conversation:changed — including the undoState frame the offer is
    // waiting for to arm itself, so an unconditional retire here means the
    // offer can never outlive the delete that raised it.
    if (!this._isOwnThread(mt)) this._hideUndoOffer();
    this._cancelDeferredTokenDisplayUpdate();
    // Defensive: if this element is recycled across threads (or across
    // conversations) the per-txnID cache from the previous thread is no
    // longer relevant. txnIDs are globally unique so collisions are not
    // possible, but a stale entry could be served to the wrong footer
    // for one tick before the new fetch lands.
    this._blobTokenCache.clear();
    this._pendingTxnId = '';
    this._messageThread = mt;
    if (mt) {
      const conversation = mt.conversation;
      const session = conversation?.session;
      if (session) {
        this._unsubscribe = /** @type {() => void} */ (session.subscribe((/** @type {any} */ event) => {
          if (event.type === 'conversation:context-window-updated' && event.data === conversation) {
            this._scheduleTokenDisplayUpdate();
          } else if (event.type === 'contextItems:changed' || event.type === 'conversation:changed') {
            this._scheduleTokenDisplayUpdate();
          } else if (event.type === 'conversation:items-removed'
            && this._isOwnThread(event.data?.messageThread)) {
            // The delete happened in THIS column, whose end is now exactly
            // where the removed items used to be.
            this._showUndoOffer(event.data.removed);
          }
        }));
      }
      // Mid-turn usage updates arrive on the LLMState status feed (one tick per
      // usage chunk). For a provider that streams authoritative per-step usage
      // we refresh the meter immediately — not through the 2s event debounce —
      // so the bar visibly grows as the turn proceeds. The callback is cheap
      // when nothing changed (token-display.setUsage no-ops on equal input).
      if (conversation) {
        this._statusUnsubscribe = conversation.onStatusChange(() => {
          // Only models that stream authoritative per-step usage drive the meter
          // from this feed; for the rest the meter stays on the blob anchor
          // refreshed by the (debounced) session events, so skip the per-tick work.
          if (this._modelStreamsLiveUsage()) this._updateTokenDisplay();
        });
      }
    }
    this._updateTokenDisplay();
  }

  /**
   * Reduce this footer to the status line, or restore the full footer.
   *
   * Set by a column that displays a folded tool run: the run's rows belong to
   * the thread one column to the left, which this column shares, so Continue,
   * Duplicate and Add Context Item would all act on that thread from inside a
   * lens on five of its rows, and the token meter would report the
   * thread's context for a handful of tool calls. Only the status line survives,
   * because the owner scopes it to the run (conversation-area.updateFooter).
   * @param {boolean} on - True for status-only, false for the full footer.
   */
  setStatusOnly(on) {
    on = !!on;
    if (this._statusOnly === on) return;
    this._statusOnly = on;
    this._applyStatusOnly();
    if (!on) this._updateTokenDisplay();
  }

  /**
   * Show or hide the parts status-only mode removes. Called on every change of
   * the mode and once on connection, since the markup is built there and a
   * column can set the mode before this element is in the DOM.
   * @private
   */
  _applyStatusOnly() {
    const on = this._statusOnly;
    this.toggleAttribute('status-only', on);
    const tokenDisplay = this.querySelector('token-display');
    // The meta row goes with the meter it carries — an empty row left standing
    // would still take its share of the footer's gap.
    for (const el of [tokenDisplay, this.querySelector('.footer-meta'),
      this.querySelector('.footer-pause-btn'), this.querySelector('.footer-stop-btn')]) {
      el?.classList.toggle('hidden', on);
    }
    if (on) {
      // No meter to keep current, and no in-flight refresh worth landing.
      this._cancelDeferredTokenDisplayUpdate();
      /** @type {any} */ (tokenDisplay)?.clear?.();
    } else {
      // The status-only footer hides itself while its run is settled; a full
      // footer is always present.
      this.classList.remove('hidden');
    }
  }

  /**
   * Whether `mt` addresses the same thread this footer is already bound to.
   *
   * Compared by container rather than by wrapper identity: a column builds a
   * fresh MessageThread wrapper for a sub-thread on every rebuild (the root
   * thread is the one that keeps its wrapper), so wrapper identity would report
   * a change on every rebuild of a thread column while the thread on screen
   * never moved. The container is the thread's Y.Array, which is the thread.
   * @param {import('../model/message-thread.js').default|null|undefined} mt
   * @returns {boolean} True when `mt` is the thread this footer is showing.
   * @private
   */
  _isOwnThread(mt) {
    if (!mt || !this._messageThread) return false;
    return mt.container === this._messageThread.container
      && mt.conversation === this._messageThread.conversation;
  }

  /**
   * Offer to undo a delete that just removed a span of items from this column.
   *
   * The offer is a promise about ONE undo entry, but `undo()` pops whatever is
   * on top of a stack the worker owns and every client of this conversation
   * shares. So the offer arms itself against `undoState.seq`: the first frame
   * it sees is the delete's own, and any later change means the top of the
   * stack is some other operation now — at which point the offer retires
   * rather than reverse something the user never asked about. Adopting the
   * wrong frame (a remote edit racing the delete) can only retire the offer
   * early; it can never point it at the wrong entry.
   * @param {number} removed - How many items the delete took out
   * @private
   */
  _showUndoOffer(removed) {
    // A group column shares its parent's thread, so a delete there reaches both
    // footers. The offer belongs to the column the span was listed in, not to a
    // lens on a handful of its rows — and a status-only footer hides itself
    // between runs, which would take the offer with it.
    if (this._statusOnly) return;
    const row = this.querySelector('.footer-undo-offer');
    const conversation = this._messageThread?.conversation;
    if (!row || !conversation) return;

    const label = this.querySelector('.footer-undo-text');
    if (label) label.textContent = `${removed} items removed`;
    row.classList.remove('hidden');
    this._undoOfferSeq = null;

    if (!this._undoObserver) {
      this._undoObserver = (/** @type {any} */ event) => {
        if (!event.keysChanged?.has?.('undoState')) return;
        const seq = conversation.getMetadata('undoState')?.seq ?? null;
        if (this._undoOfferSeq === null) this._undoOfferSeq = seq;
        else if (seq !== this._undoOfferSeq) this._hideUndoOffer();
      };
      conversation.observeMetadata(this._undoObserver);
    }
  }

  /**
   * Retire the Undo offer and stop watching the undo stack. Safe to call when
   * no offer is showing; `_undoObserver` is non-null exactly while one is.
   * @private
   */
  _hideUndoOffer() {
    this.querySelector('.footer-undo-offer')?.classList.add('hidden');
    this._undoOfferSeq = null;
    if (this._undoObserver) {
      this._messageThread?.conversation?.unobserveMetadata(this._undoObserver);
      this._undoObserver = null;
    }
  }

  /**
   * Whether the visible conversation's model streams authoritative per-step
   * input usage (provider capability, surfaced per model on the WS-pushed
   * provider list). Only such models drive the live-growing meter; others keep
   * the end-of-turn blob anchor.
   * @returns {boolean} True when the current model reports live per-step usage.
   * @private
   */
  _modelStreamsLiveUsage() {
    const cfg = this._messageThread?.conversation?.modelConfig;
    if (!cfg?.provider || !cfg?.model) return false;
    const providerEntry = providersCache.get().find((/** @type {any} */ p) => p?.name === cfg.provider);
    const model = providerEntry?.modelsWithContext?.find((/** @type {any} */ m) => m?.id === cfg.model);
    return !!model?.streamsLiveUsage;
  }

  /**
   * Schedule an event-driven token refresh after a quiet period.
   * @private
   */
  _scheduleTokenDisplayUpdate() {
    this._cancelDeferredTokenDisplayUpdate();
    this._tokenUpdateTimer = window.setTimeout(() => {
      this._tokenUpdateTimer = undefined;
      this._updateTokenDisplay();
    }, TOKEN_UPDATE_DEBOUNCE_MS);
  }

  /** @private */
  _cancelDeferredTokenDisplayUpdate() {
    if (this._tokenUpdateTimer !== undefined) {
      window.clearTimeout(this._tokenUpdateTimer);
      this._tokenUpdateTimer = undefined;
    }
  }

  /**
   * Async-fetch the transaction blob for `txnId` (no-op if already
   * cached or in flight); on success, cache the numbers and
   * re-render so the footer picks them up.
   * @private
   * @param {string} txnId
   */
  async _ensureBlobLoaded(txnId) {
    if (!txnId) return;
    if (this._blobTokenCache.has(txnId)) return;
    if (this._pendingTxnId === txnId) return;
    const thread = this._messageThread;
    const convId = thread?.conversation?.id;
    if (!convId) return;
    this._pendingTxnId = txnId;
    let success = false;
    try {
      const { default: workerManager } = await import('../services/worker-manager.js');
      const blob = /** @type {any} */ (await workerManager.getTransaction(convId, txnId));
      const inputTokens = Number(blob?.inputTokens) || 0;
      // The blob omits the key entirely when the provider reported no cache
      // usage for the call, and carries a real 0 when it reported a miss. The
      // two are different answers, so the absent key becomes null rather than
      // a zero the meter would draw as "all of this was new".
      const reportedCached = blob?.cachedTokens;
      const cachedTokens = reportedCached === undefined || reportedCached === null
        ? null
        : Number(reportedCached) || 0;
      const inputTokensApproximate = blob?.inputTokensApproximate === true;
      if (inputTokens > 0) {
        // Only cache positive results. The blob may not exist yet:
        // the worker stamps transactionId on the streaming assistant
        // item BEFORE SaveBlob runs at end-of-turn, so the footer's
        // first fetch can race the save. Leaving the cache empty
        // lets the next conversation:changed event retry.
        this._blobTokenCache.set(txnId, { inputTokens, cachedTokens, inputTokensApproximate });
        success = true;
      }
    } catch {
      // Network/RPC failure — don't cache. Next render retries.
    } finally {
      if (this._pendingTxnId === txnId) this._pendingTxnId = '';
      if (success && this.isConnected && this._messageThread === thread) {
        this._updateTokenDisplay();
      }
    }
  }

  /** @private */
  _updateTokenDisplay() {
    // Status-only: no meter is shown, so don't fetch blobs to fill one.
    if (this._statusOnly) return;
    const thread = this._messageThread;
    const tokenDisplay = this.querySelector('token-display');
    if (!thread || !tokenDisplay) return;

    const conv = thread.conversation;
    const budget = Number(conv?.contextWindow) || 0;
    // This column's own thread: a meter measures one transcript, so a sibling's
    // turn must neither fill it nor blank it.
    const processing = !!thread.isProcessing;
    const streamsLive = this._modelStreamsLiveUsage();

    // Live path: while a provider that reports authoritative per-step usage is
    // streaming, grow the meter against the running input total the worker has
    // stamped into this thread's processingState entry, rather than the frozen
    // previous-turn blob anchor. Falls through to the anchor before the first
    // usage chunk arrives (getLiveInputUsage null) and once the turn ends
    // (processing false), so the end-of-turn number takes over seamlessly.
    if (processing && streamsLive) {
      const live = conv?.llmState?.getLiveInputUsage?.(conv.id, thread.threadItemId);
      if (live) {
        /** @type {any} */ (tokenDisplay).setUsage({
          total: live.inputTokens,
          cached: live.cachedTokens,
          budget,
          processing: true,
        });
        return;
      }
    }

    // A provider that does not stream live per-step usage has no trustworthy
    // running count mid-turn — its only anchor is the previous turn's frozen
    // blob, which would sit visibly stale for the whole turn. Hide the meter
    // while such a turn runs; it reappears with the fresh count the moment the
    // turn ends (processing false → the anchor path below renders it).
    if (processing && !streamsLive) {
      /** @type {any} */ (tokenDisplay).clear();
      return;
    }

    // Anchor cache hit → render synchronously. Miss → kick a background
    // fetch and leave the existing display alone; clearing to zero while the
    // blob request is in flight causes the footer count to flicker/hide.
    const txnId = findLastAssistantTxnId(this._messageThread?.items);
    let anchor = null;
    if (txnId) {
      if (this._blobTokenCache.has(txnId)) anchor = this._blobTokenCache.get(txnId);
      else {
        this._ensureBlobLoaded(txnId);
        return;
      }
    }

    /** @type {any} */ (tokenDisplay).setUsage({
      total: anchor?.inputTokens ?? 0,
      cached: anchor?.cachedTokens ?? null,
      budget,
      processing,
      approximate: anchor?.inputTokensApproximate ?? false,
    });
  }

  connectedCallback() {
    this.innerHTML = `
            <footer-processing class="hidden">
                <juggler-spinner live></juggler-spinner>
                <span class="llm-busy-text"></span>
                <button class="message-action-btn footer-pause-btn" type="button" title="Pause as soon as possible, without cancelling any operations in progress">
                    <svg class="footer-pause-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z"/></svg>
                    <juggler-spinner class="footer-pause-spinner" style="--size: 1rem"></juggler-spinner>
                    <span class="footer-pause-label">Pause</span>
                </button>
                <button class="message-action-btn footer-stop-btn" type="button" title="Cancel all pending operations and stop">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m336-280-56-56 144-144-144-143 56-56 144 144 143-144 56 56-144 143 144 144-56 56-143-144-144 144Z"/></svg>
                    Stop
                </button>
            </footer-processing>
            <div class="llm-next-steps hidden"></div>
            <div class="footer-undo-offer hidden" role="status">
                <span class="footer-undo-text"></span>
                <button class="message-action-btn footer-undo-btn" type="button">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z"/></svg>
                    Undo
                </button>
            </div>
            <div class="footer-meta">
                <token-display></token-display>
                <div class="footer-activity hidden">
                    <span class="footer-last-activity"></span>
                    <button class="properties-panel-header-icon-btn footer-log-btn" type="button" title="Open this conversation's log" aria-label="Open conversation log">${LOG_ICON_SVG}</button>
                </div>
            </div>
            <footer-idle>
                <div class="footer-idle-row footer-idle-main">
                    <div class="footer-idle-left">
                        <div class="footer-paused hidden" role="status">
                            <span class="footer-paused-label">Paused</span>
                            <button class="message-action-btn footer-resume-btn" type="button" title="Lift the pause and carry on">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M240-240v-480h66.67v480H240Zm169.33 0 390-240-390-240v480ZM476-363.67v-232.66L665-480 476-363.67ZM476-480Z"/></svg>
                                Resume
                            </button>
                        </div>
                        <button class="message-action-btn add-context-item-btn hidden">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-120v-320H120v-80h320v-320h80v320h320v80H520v320h-80Z"/></svg>
                            Add Context Item
                        </button>
                    </div>
                    <div class="footer-idle-right">
                        <button class="message-action-btn duplicate-to-tab-btn hidden">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M448-160v-305.33L226.67-686.67V-570H160v-230h230v66.67H274l240.67 240.66V-160H448Zm126.67-368-47.34-47.33 158.67-158H570V-800h230v230h-66.67v-116.67L574.67-528Z"/></svg>
                            Duplicate as new conversation
                        </button>
                        <button class="message-action-btn continue-btn">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M240-240v-480h66.67v480H240Zm169.33 0 390-240-390-240v480ZM476-363.67v-232.66L665-480 476-363.67ZM476-480Z"/></svg>
                            Continue
                        </button>
                    </div>
                </div>
            </footer-idle>
        `;

    const continueBtn = this.querySelector('.continue-btn');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        this._messageThread.continue();
      });
    }

    // The token pill asks to see the round-trip its numbers came from; only the
    // footer knows which item that is, so it names it here and lets the tab do
    // the selecting.
    const tokenPill = this.querySelector('token-display');
    if (tokenPill) {
      tokenPill.addEventListener('token-display:show-transaction', (e) => {
        e.stopPropagation();
        const itemId = findLastAssistantItemId(this._messageThread?.items);
        if (!itemId) return;
        this.dispatchEvent(new CustomEvent('show-transaction-requested', {
          bubbles: true,
          composed: true,
          detail: { itemId }
        }));
      });
    }

    // The log is a reading of this conversation like the two beside it, and the
    // only other way to it is the Logs tab's picker — where you have to know
    // which of the listed files is yours. Few sessions ever want it, so it rides
    // along with the timestamp rather than taking a row of its own.
    const logBtn = this.querySelector('.footer-log-btn');
    if (logBtn) {
      logBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const conversationId = this._messageThread?.conversation?.id;
        if (conversationId) openSettings('logs', { conversationLog: conversationId });
      });
    }

    const duplicateTabBtn = this.querySelector('.duplicate-to-tab-btn');
    if (duplicateTabBtn) {
      duplicateTabBtn.addEventListener('click', () => {
        // Same entry point as the (removed) header button: app.js listens for
        // this on document and duplicates the visible conversation into a new conversation.
        this.dispatchEvent(new CustomEvent('duplicate-conversation', {
          bubbles: true,
          composed: true
        }));
      });
    }

    const addCIBtn = this.querySelector('.add-context-item-btn');
    if (addCIBtn) {
      addCIBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('context-item-add-requested', {
          bubbles: true,
          composed: true,
          detail: { button: addCIBtn, threadItemId: this._messageThread?.threadItemId ?? null }
        }));
      });
    }

    const undoBtn = this.querySelector('.footer-undo-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        const conversation = this._messageThread?.conversation;
        this._hideUndoOffer();
        void conversation?.undo();
      });
    }

    const processingEl = /** @type {HTMLElement|null} */ (this.querySelector('footer-processing'));
    if (processingEl) {
      processingEl.addEventListener('click', () => {
        const messageId = processingEl.dataset.messageId;
        if (messageId) {
          this.dispatchEvent(new CustomEvent('select-item-requested', {
            bubbles: true,
            composed: true,
            detail: { messageId }
          }));
        }
      });
    }

    const stopBtn = this.querySelector('.footer-stop-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', (e) => {
        // Don't let the click bubble to footer-processing's select-item handler.
        e.stopPropagation();
        this._stopOwnColumn();
      });
    }

    const pauseBtn = this.querySelector('.footer-pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', (e) => {
        // Don't let the click bubble to footer-processing's select-item handler.
        e.stopPropagation();
        this._pauseOwnColumn();
      });
    }

    const resumeBtn = this.querySelector('.footer-resume-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._resumeOwnColumn();
      });
    }

    this._applyStatusOnly();

    if (this._messageThread) this._updateTokenDisplay();
  }

  /**
   * Stop the thread this footer belongs to, from THIS column's vantage. The
   * footer-processing block (and so this button) is shown only on a column that
   * is actually processing. A sub-thread column INTERRUPTS that thread (stops
   * the work and leaves its run open) — the same own-vantage stop as Escape
   * inside the thread. The root column (threadItemId null) stops everything and
   * settles every sub-thread run still open under it. Both route through the
   * vantage-aware cancelLLMOperation.
   * @private
   */
  _stopOwnColumn() {
    const threadItemId = this._messageThread?.threadItemId ?? null;
    // @ts-ignore - jugglerApp is added dynamically in app.js
    if (window.jugglerApp && window.jugglerApp.cancelLLMOperation) {
      // @ts-ignore
      window.jugglerApp.cancelLLMOperation(threadItemId, { source: 'stop button' });
    }
  }

  /**
   * Request a polite stop (Pause) for the thread this footer belongs to, and
   * everything below it. Unlike Stop this is non-destructive: the work in flight
   * finishes and records its result, then rests before the next LLM turn —
   * nothing is cancelled and no run is settled. Scoped like Stop, through the
   * same vantage-aware cancelLLMOperation. Passes `toggle: true` so a second
   * click lifts the pause again — the button is a toggle, unlike the
   * shift+Escape shortcut which only ever requests one.
   * @private
   */
  _pauseOwnColumn() {
    const threadItemId = this._messageThread?.threadItemId ?? null;
    // @ts-ignore - jugglerApp is added dynamically in app.js
    if (window.jugglerApp && window.jugglerApp.cancelLLMOperation) {
      // @ts-ignore
      window.jugglerApp.cancelLLMOperation(threadItemId, { polite: true, toggle: true });
    }
  }

  /**
   * Lift the Pause standing over this column and carry on from where it stopped.
   *
   * Both halves are needed. Lifting the mark only says the thread MAY run again:
   * the pause left it at rest with nothing driving it, so a Resume that only
   * un-paused would look like a button that does nothing. The continuation is
   * what actually resumes the work — and it carries its own lift on the worker
   * side, since an explicit send into a thread is an unambiguous "resume now".
   * @private
   */
  _resumeOwnColumn() {
    const conversation = this._messageThread?.conversation;
    if (!conversation) return;
    conversation.cancelPoliteStop(this._messageThread?.threadItemId ?? null);
    this._messageThread.continue();
  }

  /**
   * Update footer display based on conversation state.
   * This is the ONLY way to change what the footer shows.
   *
   * In status-only mode the thread-level fields of `state` are ignored: the
   * footer shows the status line while `isProcessing`, and nothing at all
   * otherwise.
   * @param {FooterState} state - Current conversation state
   */
  update(state) {
    // A new turn supersedes the Undo offer: undo is locked out while the worker
    // is mutating the doc, so leaving the button up would leave a dead control
    // on screen. This is also what dismisses the offer once the user has moved
    // on and sent their next message.
    if (state.isProcessing && this._undoObserver) this._hideUndoOffer();

    if (this._statusOnly) {
      // A run that isn't doing anything has nothing to say, and an empty strip
      // would leave dead space under the last row — so the whole footer goes.
      this.classList.toggle('hidden', !state.isProcessing);
    }

    const processing = /** @type {HTMLElement|null} */ (this.querySelector('footer-processing'));
    const idle = /** @type {HTMLElement|null} */ (this.querySelector('footer-idle'));
    const text = this.querySelector('.llm-busy-text');
    const nextSteps = /** @type {HTMLElement|null} */ (this.querySelector('.llm-next-steps'));
    const continueBtn = /** @type {HTMLElement|null} */ (this.querySelector('.continue-btn'));
    const duplicateTabBtn = /** @type {HTMLElement|null} */ (this.querySelector('.duplicate-to-tab-btn'));
    const addCIBtn = /** @type {HTMLElement|null} */ (this.querySelector('.add-context-item-btn'));

    const hide = (/** @type {Element|null} */ el) => el?.classList.add('hidden');
    const show = (/** @type {Element|null} */ el) => el?.classList.remove('hidden');
    const toggle = (/** @type {Element|null} */ el, /** @type {boolean} */ visible) => visible ? show(el) : hide(el);
    // `el.textContent = x` ALWAYS replaces the child text node, even when x is
    // unchanged. update() runs on every streaming tick (many times a second),
    // so an unconditional write churns these nodes ~10×/s. That's harmless for
    // display — but if the user presses on a node that a tick then replaces
    // mid-gesture, the mousedown target is detached before mouseup and the
    // native `click` (which fires on the common ancestor of the two) never
    // reaches the button: the intermittent "first Pause click is ignored" bug.
    // Only write when the value actually changed, so a resting label/button is
    // a stable click target between ticks.
    const setText = (/** @type {Element|null} */ el, /** @type {string} */ value) => {
      if (el && el.textContent !== value) el.textContent = value;
    };

    // When the thread last changed, beside the meter — both are readings of the
    // thread rather than controls on it. Shown only at rest: mid-turn the answer
    // is "now", and the status line already dates the work. The label is an
    // absolute time, not "5 min ago", so nothing has to tick it to keep it true.
    // The log button is shown and hidden with it, as the other half of the same
    // reading: where this conversation's activity is written down.
    const activity = /** @type {HTMLElement|null} */ (this.querySelector('.footer-activity'));
    const lastActivity = /** @type {HTMLElement|null} */ (this.querySelector('.footer-last-activity'));
    if (activity && lastActivity) {
      const at = (state.isProcessing || this._statusOnly) ? 0 : (state.lastActivityAt || 0);
      if (at) {
        const { short, full } = formatRelativeDateTime(at);
        setText(lastActivity, `Updated ${short}`);
        const title = `Last updated ${full}`;
        if (lastActivity.title !== title) lastActivity.title = title;
      } else {
        setText(lastActivity, '');
      }
      toggle(activity, !!at);
    }

    if (state.isProcessing) {
      show(processing);
      hide(idle);
      setText(text, state.statusMessage || '');
      const spinner = this.querySelector('juggler-spinner');
      if (spinner) {
        toggle(spinner, state.showSpinner !== false);
        // Report the live work behind the spinner. Doing this on every tick is
        // free — the spinner ignores an unchanged count and deadbands the rate —
        // and it is ignored outright by any spinner not marked `live`.
        /** @type {any} */ (spinner).clubs = state.runningTools ?? 0;
        /** @type {any} */ (spinner).report({
          throughput: state.throughput ?? 0,
          toolWaitMs: state.toolWaitMs ?? null,
        });
        // One roll of the dice per turn, on the rising edge only.
        if (!this._wasProcessing) /** @type {any} */ (spinner).offerDrop();
      }
      this._wasProcessing = true;
      if (nextSteps) {
        // The plan belongs to the thread, not to a run of its tool calls.
        const text = this._statusOnly ? '' : (state.nextSteps || '');
        setText(nextSteps, text);
        toggle(nextSteps, !!text);
      }
      if (processing) {
        // Status-only carries no click affordance: the busy row it would select
        // is already on screen in this very column.
        if (state.busyItemMessageId && !this._statusOnly) {
          /** @type {HTMLElement} */ (processing).dataset.messageId = state.busyItemMessageId;
        } else {
          delete /** @type {HTMLElement} */ (processing).dataset.messageId;
        }
      }
      // Pause pending → render the Pause button in a visibly pending state while
      // this column's work finishes: the pause glyph is swapped for a spinner and
      // the label reads "Pausing…". It gives way to the idle row's "Paused" once
      // the pause has landed, so the two together say what happened — a pending
      // cue that merely disappeared was indistinguishable from a pause forgotten.
      const pauseBtn = this.querySelector('.footer-pause-btn');
      if (pauseBtn) {
        const pending = !!state.politePending;
        pauseBtn.classList.toggle('active', pending);
        pauseBtn.classList.toggle('pending', pending);
        setText(pauseBtn.querySelector('.footer-pause-label'), pending ? 'Pausing…' : 'Pause');
      }
    } else {
      // Idle state — show appropriate buttons.
      //
      // `footer-processing` is hidden the instant the turn ends, with nothing
      // held back for a closing flourish. Its visibility is not merely cosmetic:
      // it is this column's "still working" signal, read by the selection logic
      // that decides what the keyboard acts on (conversation-area's
      // _resolveSelectionTarget) and by the test harness's idle detection.
      // Keeping the row up a few hundred milliseconds past the end of the work
      // makes that signal false, and points the keyboard at a status row
      // describing a turn that is already over.
      this._wasProcessing = false;
      hide(processing);
      if (processing) delete /** @type {HTMLElement} */ (processing).dataset.messageId;
      if (nextSteps) { nextSteps.textContent = ''; hide(nextSteps); }

      // Status-only stops here: the idle row is entirely thread-level controls.
      if (this._statusOnly) { hide(idle); return; }

      // Add Context Item is offered on every idle column, so the row is always
      // worth showing; the other two controls decide what else sits in it.
      toggle(idle, true);

      // A landed Pause is the one thing an idle column has to say about itself:
      // this thread has come to rest and will not run again until it is lifted.
      const paused = !!state.politePaused;
      toggle(this.querySelector('.footer-paused'), paused);

      toggle(continueBtn, !!state.canContinue);
      // Duplicate tab is offered only on a conversation's root thread
      // (the owner sets showDuplicateTab), never on sub-threads.
      toggle(duplicateTabBtn, !!state.showDuplicateTab);

      show(addCIBtn);
    }
  }
}

customElements.define('conversation-footer', ConversationFooter);

export default ConversationFooter;
