//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import {
  isUserMessage,
  isAssistantMessage,
  isToolActionMessage,
  isThreadMessage,
} from '../../sdk/lib/message.js';
import './conversation-footer.js';
import './tool-action-message.js';
import './user-message.js';
import './assistant-message.js';
import './thinking-message.js';
import './context-item-message.js';
import './error-message.js';
import './notice-message.js';
import './thread-message.js';
import './tool-group-message.js';
import { buildDisplayItems, isGroupEntry } from '../utils/item-grouping.js';
import { isToolGroupingEnabled } from '../utils/tool-grouping-pref.js';
import { createIconBadge, createTypeBadge } from '../utils/icon-message-renderer.js';
import { badgeForItem } from '../utils/item-badge.js';
import { SCROLL_TOP_SVG, SCROLL_BOTTOM_SVG } from '../utils/icons.js';
import { setupColumnResize } from '../utils/column-resize.js';
import {
  hasPendingApprovalInTree,
  hasUnsettledToolInTree,
  runningToolsInTree,
} from '../model/thread-navigation.js';
import { itemGoal } from '../model/thread-alias.js';
import { appendDeleteControls } from '../utils/panel-delete-controls.js';
import { findNeighborItemId } from '../services/context-item-utilities.js';
import {
  ensureFooterExists,
  ensureThreadResult,
  removeAllElements,
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
  ensurePendingMessages,
  getItemId,
} from './conversation-area-rendering.js';
import * as scroll from './conversation-area-scroll.js';
import * as selection from './conversation-area-selection.js';
import { StatusMessageBuilder } from '../services/status-message-builder.js';

/**
 * Duration of the insert/relayout FLIP glide — the eased motion that replaces
 * the old smooth-scroll follow, without re-introducing any scroll bookkeeping.
 */
const INSERT_ANIM_MS = 220;

/**
 * Duration of the streaming-resize glide. When a tail bubble grows by a
 * streaming token we animate its height to the new size rather than letting it
 * snap, so the items above slide up smoothly while native column-reverse pinning
 * holds the footer perfectly still (no scroll position is ever touched). Kept
 * short so the bubble's height stays close to the live content during fast
 * streaming.
 */
const STREAM_RESIZE_MS = 140;

/** @returns {boolean} True when the OS asks for reduced motion. */
function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * Top-level transcript row tags eligible for the content-visibility skip (see
 * styles.css `.cv-off` and _reconcileRowVisibility). Deliberately excludes the
 * footer and pending-message bubbles, which must always render.
 */
const CV_ROW_TAGS = new Set([
  'USER-MESSAGE',
  'ASSISTANT-MESSAGE',
  'THINKING-MESSAGE',
  'TOOL-ACTION-MESSAGE',
  'THREAD-MESSAGE',
  'TOOL-GROUP-MESSAGE',
  'CONTEXT-ITEM-MESSAGE',
  'ERROR-MESSAGE',
  'NOTICE-MESSAGE',
]);

/**
 * Idle gap (ms) after scrolling stops before queued row collapses are flushed;
 * long enough to sit out macOS momentum scrolling. See _flushRowSkips.
 */
const SKIP_FLUSH_IDLE_MS = 200;

/**
 * Controls that own their own clicks. A click landing on one of these inside a
 * tile is an action on the item — answering a question, retrying, opening a
 * disclosure — not a request to navigate into the item's details, so it never
 * triggers a reveal of the item's child column.
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]';

/**
 * ConversationArea - Fixed conversation panel at bottom of viewport
 */
class ConversationArea extends HTMLElement {
  constructor() {
    super();
    /** @type {import('../model/conversation.js').default|null} @private */
    this._conversation = null;
    /** @type {number|null} @private */
    this._scrollAnimationFrame = null;
    /** @type {boolean} @private - Track if initial scroll restore has happened */
    this._initialScrollRestored = false;
    /** @type {((event: any, transaction: any) => void)|null} @private - Metadata observer for nextSteps */
    this._metadataObserver = null;
    /** @type {((event: any, transaction: any) => void)|null} @private - Items observer for streaming scroll */
    this._streamingScrollObserver = null;
    /** @type {'user'|'auto'|null} @private - Origin of current selection */
    this._selectionOrigin = null;
    /** @type {boolean} @private - Whether the last pointer press began inside an action-confirmation widget */
    this._mousedownInApproval = false;
    /** @type {boolean} @private - Whether the last pointer press began on a control inside a tile */
    this._mousedownOnControl = false;
    /** @type {boolean} @private - Whether the click being handled is an approval action rather than navigation */
    this._clickIsApprovalAction = false;
    /** @type {boolean} @private - Whether the click being handled landed on a control inside a tile */
    this._clickOnControl = false;
    /** @type {import('../model/message-thread.js').MessageThread|null} @private */
    this._messageThread = null;
    /** @type {string|null} @private - Locally tracked selected item ID (per-column) */
    this._localSelectedItemId = null;
    /** @type {*} @private - Thread Y.Map this column represents (null for root). FOR READS AND OBSERVATION ONLY — use messageThread methods for mutations. */
    this._threadYMap = null;
    /** @type {((event: any) => void)|null} @private - Yjs observer on thread Y.Map */
    this._threadStatusObserver = null;
    /** @type {IntersectionObserver|null} @private - Watches selected element visibility while origin='user' */
    this._selectedVisibilityObserver = null;
    /** @type {number|null} @private - Pending timer to demote origin after offscreen dwell */
    this._offscreenResumeTimer = null;
    /** @type {boolean} @private - True once this column has done its initial bulk render, so later structural inserts/removals animate (FLIP) while the first populate stays instant. */
    this._animationsPrimed = false;
    /** @type {ResizeObserver|null} @private - Recomputes scroll-control visibility on viewport/content resize */
    this._scrollControlsResizeObserver = null;
    /** @type {ResizeObserver|null} @private - Holds the reader's place when content resizes while they are scrolled away (see _setupReaderAnchor) */
    this._readerAnchorObserver = null;
    /** @type {{el: HTMLElement, top: number, contentHeight: number}|null} @private - The row the reader's place is measured from, where it sat when last recorded, and the content height it was recorded against */
    this._readerAnchor = null;
    /** @type {IntersectionObserver|null} @private - Strips `cv-off` (renders a row) once it enters the inner margin; the near edge of the content-visibility hysteresis band */
    this._rowRenderObserver = null;
    /** @type {IntersectionObserver|null} @private - Applies `cv-off` (skips a row) once it leaves the outer margin; the far edge of the content-visibility hysteresis band */
    this._rowSkipObserver = null;
    /** @type {WeakSet<Element>} @private - Rows already handed to the row-visibility observers, so reconcile only observes new ones */
    this._observedRows = new WeakSet();
    /** @type {Set<HTMLElement>} @private - Rows past the skip margin whose collapse is deferred until scrolling goes idle (see _flushRowSkips) */
    this._pendingSkip = new Set();
    /** @type {number|null} @private - Pending scroll-idle timer that flushes _pendingSkip */
    this._skipFlushTimer = null;
    /** @type {boolean} @private - True when this column IS a group's contents, so its rows are never re-folded */
    this._isGroupColumn = false;
    /** @type {any[]|null} @private - The folded rows this column shows, when it is a group column (null otherwise) */
    this._groupItems = null;
    /** @type {Map<string, string>} @private - itemId of a folded tool row → display id of the group standing in for it */
    this._memberToGroup = new Map();
  }

  /**
   * Set conversation reference
   * @param {import('../model/conversation.js').default|null} conversation
   */
  set conversation(conversation) {
    // Skip if same conversation (avoids tearing down observers on every sync)
    if (conversation === this._conversation) return;

    // Clean up old observers
    if (this._conversation && this._metadataObserver) {
      this._conversation.unobserveMetadata(this._metadataObserver);
      this._metadataObserver = null;
    }
    if (this._streamingScrollObserver && this._observedContainer) {
      this._observedContainer.unobserveDeep(this._streamingScrollObserver);
      this._streamingScrollObserver = null;
      this._observedContainer = null;
    }
    selection.teardownSelectionVisibilityWatcher(this);
    this._conversation = conversation;

    // Set up new observer for nextSteps metadata
    if (conversation) {
      this._metadataObserver = (/** @type {any} */ event) => {
        // Conversation metadata holds only the ROOT thread's plan; a sub-thread
        // column reads its own plan off its thread Y.Map (see the thread
        // observer in setThreadContext). Refreshing here is harmless for a
        // sub-thread column (it re-reads its own Y.Map, not this key).
        if (event.keysChanged.has('nextSteps')) {
          this._refreshNextStepsIndicator();
        }
        // Selection is local per-column, tracked in _localSelectedItemId.
      };
      conversation.observeMetadata(this._metadataObserver);

      // Check initial state
      this._refreshNextStepsIndicator();

      // Set up streaming scroll observer if message thread is already available.
      // Otherwise, it will be set up when setMessageThread() is called.
      if (this._messageThread) {
        this._setupStreamingScrollObserver(conversation);
      }
    }
  }

  /**
   * Set the message thread for this column.
   * @param {import('../model/message-thread.js').MessageThread} messageThread
   */
  setMessageThread(messageThread) {
    const containerChanged = this._observedContainer !== messageThread?.container;
    this._messageThread = messageThread;
    // Mode before thread: a group column's footer must know it shows no token
    // meter before it is handed a thread to fetch one for.
    /** @type {any} */ (this._getFooter()).setStatusOnly(this._isGroupColumn);
    /** @type {any} */ (this._getFooter()).setMessageThread(messageThread);

    // Re-target the streaming observer whenever the thread's container changes.
    // Columns are reused across thread navigations (the same conversation-area
    // element is repurposed for a different sub-thread), and without this
    // retarget the observer would stay attached to the previous container and
    // miss streaming chunks on the new one.
    if (this._conversation && containerChanged) {
      if (this._streamingScrollObserver && this._observedContainer) {
        this._observedContainer.unobserveDeep(this._streamingScrollObserver);
        this._streamingScrollObserver = null;
        this._observedContainer = null;
      }
      if (messageThread) {
        this._setupStreamingScrollObserver(this._conversation);
      }
    }

    // The next-steps (`<plan>`) indicator is thread-scoped; columns are reused
    // across thread navigations, so re-evaluate it against this column's
    // (possibly new) thread.
    this._refreshNextStepsIndicator();
  }

  /**
   * Get the message thread for this column
   * @returns {import('../model/message-thread.js').MessageThread|null} The message thread or null
   */
  getMessageThread() {
    return this._messageThread;
  }

  /**
   * Set the thread context for this column.
   * @param {*} threadYMap - The thread Y.Map, or null for root column behavior
   */
  setThreadContext(threadYMap) {
    // A different thread context means a fresh bulk populate — don't FLIP it in.
    if (threadYMap !== this._threadYMap) this._animationsPrimed = false;

    // Clean up old observer
    if (this._threadStatusObserver && this._threadYMap) {
      this._threadYMap.unobserve(this._threadStatusObserver);
      this._threadStatusObserver = null;
    }

    this._threadYMap = threadYMap;

    if (threadYMap) {
      // Observe thread Y.Map for header button visibility AND this thread's own
      // `nextSteps` (<plan>) — both are per-thread state on this Y.Map.
      this._threadStatusObserver = () => {
        this._refreshThreadFooter(threadYMap);
        this._refreshNextStepsIndicator();
      };
      threadYMap.observe(this._threadStatusObserver);
    }

    // Re-evaluate the plan indicator for this column's (possibly new) thread:
    // columns are reused across thread navigations, and root vs sub-thread read
    // the plan from different sources.
    this._refreshNextStepsIndicator();
  }

  /**
   * Set up observer for streaming content changes. This path handles ONLY
   * pure content growth of an existing bubble (a streaming token, which carries
   * no array-level delta): it refreshes the changed elements and, when pinned,
   * smooths their height change. It deliberately never moves the scroll position
   * — see the note at the end of the handler.
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _setupStreamingScrollObserver(conversation) {
    this._streamingScrollObserver = (/** @type {any} */ events) => {
      const scroller = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));

      // A structural change (item inserted/removed) carries an array-level delta
      // and is animated by the FLIP path in _renderFromItemsInner. Only PURE
      // growth of an existing item — a streaming token extending the tail bubble,
      // which has no array delta — is glided here. Letting both run for one change
      // would make the two animations fight, so this path bows out when structural.
      const structural = Array.isArray(events) && events.some(e => e?.changes?.delta?.length);
      // Only smooth growth while pinned to the very bottom: there, native
      // column-reverse pinning holds the footer steady on its own, so animating
      // the grown bubble's HEIGHT (never the scroll position) slides the items
      // above up without nudging the footer. When merely near — but not at — the
      // bottom, we leave the scroll position exactly where the user put it (no
      // catch-up scroll; see the note at the end of the handler).
      const pinned = !!scroller && Math.abs(scroller.scrollTop) <= 1;
      const animate = pinned && !structural && !prefersReducedMotion();

      const growEls = animate
        ? Array.from(scroller.querySelectorAll('assistant-message, thinking-message, thread-message'))
        : [];
      // Capture each streamable element's CURRENT visual height (which, mid-glide,
      // is its in-flight animated height) before the content update lands.
      const fromHeights = growEls.map((el) => /** @type {HTMLElement} */ (el).offsetHeight);

      // Hold the reader's place across this mutation (see _holdReaderAnchorOver).
      // While pinned we don't: native column-reverse anchoring keeps the newest
      // text in view, and the height glide below smooths it. Auto-follow of new
      // items / approvals / busy-status comes from onItemsInserted and showBusy,
      // never from here.
      this._holdReaderAnchorOver(() => {
        this._notifyChangedElements(events, conversation);

        growEls.forEach((el, i) => {
          this._animateStreamingResize(/** @type {HTMLElement} */ (el), fromHeights[i] ?? 0);
        });
      }, { skip: pinned });
    };
    const container = /** @type {import('../model/message-thread.js').MessageThread} */ (this._messageThread).container;
    this._observedContainer = container;
    container.observeDeep(this._streamingScrollObserver);
  }

  /**
   * Apply the tool-grouping display transform to this column's items.
   *
   * Display-only: the returned entries are the same Y.Maps, with each run of
   * adjacent tool rows standing behind one group entry. A column that IS a
   * group's contents never re-folds (that would hide what the user just opened).
   * The member → group lookup is cached because selection, visibility and
   * scrolling all have to speak in the ids that are actually in the DOM.
   * @param {any[]} items - The column's items, in document order.
   * @returns {{entries: any[], memberToGroup: Map<string, string>}} Display entries + lookup.
   * @private
   */
  _computeDisplay(items) {
    const enabled = !this._isGroupColumn && isToolGroupingEnabled();
    const display = buildDisplayItems(items, { enabled });
    this._memberToGroup = display.memberToGroup;
    return display;
  }

  /**
   * The id this column actually renders for an item: a folded tool row is
   * represented by its group, everything else by itself. Every selection,
   * visibility and scroll path funnels through here, so the rest of the
   * selection machinery keeps working in document itemIds and lands on the
   * right row either way.
   * @param {string|null|undefined} itemId - A document itemId (or a display id already).
   * @returns {string} The id present in this column's DOM.
   * @private
   */
  _displayIdFor(itemId) {
    if (!itemId) return '';
    return this._memberToGroup.get(itemId) || itemId;
  }

  /**
   * Notify message elements when their items change.
   * Builds a Map of items for O(1) lookup, then iterates streamable elements once.
   * Total complexity: O(N) where N = number of items.
   * @param {any[]} events - Array of Yjs events from observeDeep
   * @param {import('../model/conversation.js').default} _conversation
   * @private
   */
  _notifyChangedElements(events, _conversation) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;

    // observeDeep passes an array of Y.Event objects (one per nesting level).
    // Content updates within a Y.Map item won't have a top-level array delta,
    // so we just check that we received any events at all.
    if (!events || (Array.isArray(events) && events.length === 0)) return;

    // Build Map of itemId -> item for O(1) lookup
    const items = this._messageThread ? this._messageThread.items : [];
    /** @type {Map<string, any>} */
    const itemMap = new Map();
    for (const item of items) {
      const msg = /** @type {any} */ (item);
      if (msg && msg.get('itemId')) {
        itemMap.set(msg.get('itemId'), msg);
      }
    }

    // Notify all streamable message elements with their current item data
    // Elements that support streaming (assistant, thinking) implement updateFromItem()
    const streamableElements = Array.from(messageList.querySelectorAll('assistant-message, thinking-message, thread-message'));
    const live = this._snapshotLiveStatus();
    for (const element of streamableElements) {
      const itemId = element.getAttribute('message-id');
      if (!itemId) continue;

      const item = itemMap.get(itemId);
      if (item) {
        if (element.tagName === 'THREAD-MESSAGE') {
          /** @type {any} */ (element).updateFromItem?.(item, live);
        } else {
          /** @type {any} */ (element).updateFromItem?.(item);
        }
      }
    }

    // Group tiles read the aggregate state of the rows they hide (a member
    // going pending must turn the tile orange), so they're refreshed from the
    // re-derived groups rather than from itemMap.
    const groupElements = Array.from(messageList.querySelectorAll('tool-group-message'));
    if (groupElements.length > 0) {
      const { entries } = this._computeDisplay(items);
      /** @type {Map<string, any>} */
      const groupMap = new Map();
      for (const entry of entries) {
        if (isGroupEntry(entry)) groupMap.set(entry.get('itemId'), entry);
      }
      for (const element of groupElements) {
        const group = groupMap.get(element.getAttribute('message-id') || '');
        if (group) /** @type {any} */ (element).updateFromItem?.(group, live);
      }
    }

    // Pending queued messages live beside `items` on the same thread container;
    // a pendingItems-only change has no committed-item structural delta, so refresh
    // the queue zone from the deep observer too.
    const content = /** @type {HTMLElement} */ (this.querySelector('#message-list-inner'));
    if (content) {
      const footer = ensureFooterExists(this, content);
      ensureThreadResult(this, content, footer);
      ensurePendingMessages(this, content);
    }
  }

  /**
   * Height "FLIP" for a streaming bubble: the content update has already grown
   * the element to its natural new height. Pin it back to `fromHeight` and
   * transition to the new height, so the items above slide up smoothly. Because
   * this only ever animates the element's own height — never the scroller's
   * scrollTop — native column-reverse pinning keeps the footer perfectly still.
   *
   * Interruptible: a token arriving mid-glide re-baselines from the current
   * in-flight height (captured by the caller) to the fresh natural height, so
   * rapid streaming reads as one continuous resize rather than a stutter.
   * @param {HTMLElement} el - The streamable element that may have grown.
   * @param {number} fromHeight - Its visual height captured before the update.
   * @private
   */
  _animateStreamingResize(el, fromHeight) {
    // Drop any in-flight glide and its forced styles so the element reports its
    // true natural height for this token (otherwise the pinned height clips it).
    this._clearStreamingResize(el);
    const toHeight = el.offsetHeight;
    if (Math.abs(toHeight - fromHeight) < 0.5) return;

    el.style.height = `${fromHeight}px`;
    el.style.overflow = 'hidden';
    // Commit the from-height before transitioning to the target.
    void el.offsetHeight;
    el.style.transition = `height ${STREAM_RESIZE_MS}ms ease-out`;
    el.style.height = `${toHeight}px`;

    const done = (/** @type {TransitionEvent} */ e) => {
      if (e.target !== el || e.propertyName !== 'height') return;
      this._clearStreamingResize(el);
    };
    /** @type {any} */ (el)._streamResizeDone = done;
    el.addEventListener('transitionend', done);
  }

  /**
   * Tear down a streaming-resize glide: detach its listener and clear the forced
   * height/overflow/transition so the element returns to natural sizing.
   * @param {HTMLElement} el
   * @private
   */
  _clearStreamingResize(el) {
    const done = /** @type {any} */ (el)._streamResizeDone;
    if (done) {
      el.removeEventListener('transitionend', done);
      /** @type {any} */ (el)._streamResizeDone = null;
    }
    el.style.transition = '';
    el.style.height = '';
    el.style.overflow = '';
  }

  /**
   * Snapshot the conversation's live LLM status the same way the footer
   * reads it. Threads whose `itemId` matches `threadId` mirror this message.
   * @returns {import('../utils/thread-display.js').ThreadLiveStatus|null} Live status snapshot, or null if idle.
   * @private
   */
  _snapshotLiveStatus() {
    const conv = this._conversation;
    const llmState = conv?.llmState;
    if (!llmState || !conv?.id) return null;
    const message = llmState.getStatusMessage(conv.id) || '';
    if (!message) return null;
    const threadId = llmState.getStatusThreadId(conv.id);
    return { message, threadId };
  }

  /**
   * Push a live LLM status snapshot to every self-rendering status tile in this
   * column (sub-threads and folded tool groups). Called from updateFooter so the
   * tile face and the footer always derive from the same snapshot in the same
   * code path.
   * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} live
   * @private
   */
  _broadcastLiveStatusToTiles(live) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;
    for (const el of Array.from(messageList.querySelectorAll('thread-message, tool-group-message'))) {
      /** @type {any} */ (el).setLiveStatus?.(live);
    }
  }

  /**
   * Get conversation reference
   * @returns {import('../model/conversation.js').default|null} The conversation instance or null
   */
  get conversation() {
    return this._conversation;
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
  }

  disconnectedCallback() {
    // Tear down all observers attached via setters. The Yjs observers hold
    // strong references back to `this`, so leaving them attached prevents
    // the element (and its captured Conversation) from being collected.
    this.conversation = null;
    this.setThreadContext(null);
    selection.teardownSelectionVisibilityWatcher(this);
    if (this._scrollAnimationFrame !== null) {
      cancelAnimationFrame(this._scrollAnimationFrame);
      this._scrollAnimationFrame = null;
    }
    if (this._scrollControlsResizeObserver) {
      this._scrollControlsResizeObserver.disconnect();
      this._scrollControlsResizeObserver = null;
    }
    if (this._readerAnchorObserver) {
      this._readerAnchorObserver.disconnect();
      this._readerAnchorObserver = null;
      this._readerAnchor = null;
    }
    if (this._rowRenderObserver) {
      this._rowRenderObserver.disconnect();
      this._rowRenderObserver = null;
    }
    if (this._rowSkipObserver) {
      this._rowSkipObserver.disconnect();
      this._rowSkipObserver = null;
    }
    if (this._skipFlushTimer !== null) {
      clearTimeout(this._skipFlushTimer);
      this._skipFlushTimer = null;
    }
    this._pendingSkip.clear();
  }

  get composer() {
    return this.querySelector('composer-box');
  }

  render() {
    this.innerHTML = `
      <header class="thread-column-header hidden">
        <properties-panel-section>
          <header class="properties-panel-header">
            <thread-column-icon-box></thread-column-icon-box>
            <h3 class="properties-panel-title thread-column-goal"></h3>
          </header>
        </properties-panel-section>
      </header>
      <conversation-message-list-wrapper>
        <section class="conversation-message-list" id="message-list">
          <div class="conversation-message-list-inner" id="message-list-inner">
            <thread-column-actions class="hidden">
              <button class="properties-panel-btn thread-expand-btn" title="Expand this thread back into the parent">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M120-120v-320h80v184l504-504H520v-80h320v320h-80v-184L256-200h184v80H120Z"/></svg>
                Expand into parent
              </button>
              <button class="properties-panel-btn thread-copy-tab-btn" title="Copy this thread (with inherited context) to a new conversation">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-160v-326L336-382l-56-58 200-200 200 200-56 58-104-104v326h-80ZM160-600v-120q0-33 23.5-56.5T240-800h480q33 0 56.5 23.5T800-720v120h-80v-120H240v120h-80Z"/></svg>
                Copy thread to new conversation
              </button>
            </thread-column-actions>
            <conversation-footer></conversation-footer>
          </div>
        </section>
        <div class="scroll-controls" id="scroll-controls">
          <button type="button" class="scroll-control-btn hidden" data-scroll="top" title="Scroll to top" aria-label="Scroll to top">${SCROLL_TOP_SVG}</button>
          <button type="button" class="scroll-control-btn hidden" data-scroll="bottom" title="Scroll to bottom" aria-label="Scroll to bottom">${SCROLL_BOTTOM_SVG}</button>
        </div>
      </conversation-message-list-wrapper>
      <composer-box id="composer-box"></composer-box>
      <col-resize-handle></col-resize-handle>
    `;

    // Give new users (no persisted width) a sensible fixed 50rem.
    setupColumnResize(this, 'juggler-column-width', undefined, 50);
  }

  /**
   * Show thread column header with goal, status badge, and action buttons
   * @param {string} goal - The thread's goal text
   * @param {*} threadYMap - The thread Y.Map for return operations
   * @param {import('../model/message-thread.js').default} [parentMessageThread] - The parent message thread where the thread item lives
   * @param {string} [viewItemId] - The parent item this column was opened through
   */
  showThreadHeader(goal, threadYMap, parentMessageThread, viewItemId) {
    this._parentMessageThread = parentMessageThread || null;
    const displayGoal = itemGoal(threadYMap) || goal;

    const header = this.querySelector('.thread-column-header');
    if (!header) return;

    header.classList.remove('hidden');
    const actionsEl = /** @type {HTMLElement|null} */ (this.querySelector('thread-column-actions'));
    actionsEl?.classList.remove('hidden');
    const goalEl = header.querySelector('.thread-column-goal');
    if (goalEl) goalEl.textContent = displayGoal;

    // Circular icon + "Thread" lozenge from the one shared badge resolver and
    // component — the identical .message-icon-badge the conversation tile and
    // properties-panel header render, so every thread badge stays in lockstep.
    const iconPlaceholder = header.querySelector('thread-column-icon-box');
    if (iconPlaceholder) {
      const badge = badgeForItem(threadYMap, { fallbackType: 'thread' });
      iconPlaceholder.replaceWith(createIconBadge(badge, createTypeBadge(badge.typeName)));
    }

    // Update status badge
    this._refreshThreadFooter(threadYMap);

    // Expand: splice this thread's items back into the parent and drop the tile.
    // Clone to clear listeners from a prior show.
    const expandBtn = actionsEl?.querySelector('.thread-expand-btn');
    if (expandBtn) {
      const newExpandBtn = expandBtn.cloneNode(true);
      expandBtn.parentNode?.replaceChild(newExpandBtn, expandBtn);
      const tid = threadYMap.get('itemId');
      newExpandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!tid) return;
        this.dispatchEvent(new CustomEvent('expand-thread-requested', {
          detail: { threadItemId: tid },
          bubbles: true,
          composed: true
        }));
      });
    }

    // Wire up Copy to new conversation — the promote-thread-requested event
    // (conversation-tab handles it via promoteThreadToNewTab). Clone to clear
    // listeners from a prior show.
    const copyTabBtn = actionsEl?.querySelector('.thread-copy-tab-btn');
    if (copyTabBtn) {
      const newCopyTabBtn = copyTabBtn.cloneNode(true);
      copyTabBtn.parentNode?.replaceChild(newCopyTabBtn, copyTabBtn);
      const tid = threadYMap.get('itemId');
      newCopyTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!tid) return;
        this.dispatchEvent(new CustomEvent('promote-thread-requested', {
          detail: { threadItemId: tid },
          bubbles: true,
          composed: true
        }));
      });
    }

    // Remove old dynamically-added delete controls and re-add via shared utility
    actionsEl?.querySelectorAll('.properties-panel-btn.danger').forEach(b => b.remove());

    // Delete acts on the tile the user opened this column through, which for a
    // thread called more than once is one of several views of the same
    // transcript. Targeting the canonical the column resolves to would delete a
    // different item than the one that was clicked.
    const threadItemId = viewItemId || threadYMap.get('itemId');
    const parentThread = this._parentMessageThread;
    if (actionsEl && parentThread && threadItemId) {
      const idx = parentThread.findIndexByItemId(threadItemId);
      if (idx >= 0) {
        appendDeleteControls(actionsEl, parentThread, idx, (e) => {
          e.stopPropagation();
          const neighborId = findNeighborItemId(parentThread.items, idx, parentThread);
          if (neighborId) {
            this.dispatchEvent(new CustomEvent('request-item-selection', {
              detail: { itemId: neighborId },
              bubbles: true,
              composed: true
            }));
          }
          this.dispatchEvent(new CustomEvent('thread-deleted', {
            detail: { threadItemId },
            bubbles: true,
            composed: true
          }));
        });
      }
    }
  }

  /**
   * Refresh this thread column's footer after a change to its thread Y.Map.
   *
   * The composer is deliberately untouched: a thread is running or stopped, and
   * a stopped thread accepts a message either way. Whether a column shows a box
   * at all is the tab's business (it alone knows the full column chain),
   * expressed through the CSS `conversation-area[data-hide-input] composer-box`
   * rule, so nothing here may force an inline display value that would fight it.
   * @param {*} threadYMap
   * @private
   */
  _refreshThreadFooter(threadYMap) {
    if (!threadYMap) return;
    this.updateFooter();
  }

  /**
   * Hide thread column header
   */
  hideThreadHeader() {
    const header = this.querySelector('.thread-column-header');
    if (header) header.classList.add('hidden');
    this.querySelector('thread-column-actions')?.classList.add('hidden');
  }

  setupEventListeners() {
    const wrapper = this.querySelector('conversation-message-list-wrapper');
    const composer = this.querySelector('#composer-box');

    if (wrapper && composer) {
      // Capture-phase pre-check: detect clicks that originate inside an
      // action-confirmation widget. The bubble-phase handler below can't do
      // this with closest() because the approve/deny resolve callback mutates
      // Yjs synchronously, which re-renders the tool-action-message and
      // orphans the clicked button before bubbling completes. By the time
      // closest('action-confirmation') runs at bubble, the ancestor is gone.
      // Capture runs before _resolve, so the DOM is still intact.
      //
      // Clicks inside an action-confirmation are *actions on* the item, not
      // navigation. We must NOT mark them as 'user'-origin selection — that
      // would suppress rule 2b's auto-handoff to the next pending approval.
      // Track where a pointer press BEGINS. A native `click` fires on the
      // nearest common ancestor of the mousedown and mouseup targets; if the
      // approval box shifts between press and release (autoscroll while
      // streaming, or a pending re-render), the click target can resolve onto
      // the selectable item ABOVE even though the user pressed an approval
      // button. Keying the approval-action decision off the press location
      // makes it immune to that shift, so a press that began on a button is
      // never mistaken for navigation onto a neighbour.
      wrapper.addEventListener('mousedown', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        this._mousedownInApproval = !!target?.closest?.('action-confirmation');
        this._mousedownOnControl = !!target?.closest?.(INTERACTIVE_SELECTOR);
      }, true);

      wrapper.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        // The press location is authoritative: a click whose target shifted off
        // the button onto a neighbour after a layout move is still an approval
        // action, not navigation.
        const insideApproval = !!target.closest?.('action-confirmation') || this._mousedownInApproval;
        this._clickIsApprovalAction = insideApproval;
        // Same press-location reasoning for controls that live outside an
        // approval widget — an extension's custom form (the question options),
        // a retry button, a link. Decided here, while the DOM the press landed
        // on is still intact, and consumed by the bubble handler below.
        this._clickOnControl = !!target.closest?.(INTERACTIVE_SELECTOR) || this._mousedownOnControl;
        this._mousedownInApproval = false;
        this._mousedownOnControl = false;
        // Approving / denying is an act of "advance, I'm done with this
        // item", not navigation. Clear the user-origin pin so rule 2b can
        // hand selection to the next pending approval. Otherwise users
        // who clicked to select an item before approving would see
        // selection stay glued to the now-completed item.
        if (insideApproval && this._selectionOrigin === 'user') {
          this._selectionOrigin = null;
          selection.teardownSelectionVisibilityWatcher(this);
        }
      }, true);

      // Click handling for item selection. Listener lives on the wrapper (not
      // the inner #message-list) so background clicks that miss the list —
      // e.g. the scrollbar-gap margin, list padding, footer whitespace — still
      // count as "click on the background of the column" and deselect.
      wrapper.addEventListener('click', (e) => {
        const wasApprovalAction = this._clickIsApprovalAction;
        const onControl = this._clickOnControl;
        this._clickIsApprovalAction = false;
        this._clickOnControl = false;
        if (wasApprovalAction) return;

        const target = /** @type {HTMLElement} */ (e.target);

        // Check if user has selected any text
        const textSelection = window.getSelection();
        if (textSelection && textSelection.toString().length > 0) {
          // User is selecting text, don't steal focus or select
          return;
        }

        // Check if clicked on a selectable item (any message element)
        const selectableItem = target.closest(
          'user-message, assistant-message, thinking-message, context-item-message, ' +
          'error-message, notice-message, tool-action-message, thread-message, tool-group-message'
        );
        if (selectableItem) {
          const itemId = selectableItem.getAttribute('message-id');
          if (itemId) {
            if (this._localSelectedItemId === itemId) {
              // Already selected — interactive controls inside the tile still own
              // their clicks (let those pass through untouched). But a plain
              // repeat click is a deliberate "show me more about this" gesture:
              // ask the tab to reveal this item's details column if it's drifted
              // mostly off-screen. The reveal only scrolls, so even a click that
              // also hits some other handler is unaffected. User/assistant
              // messages are exempt: a repeat click on prose is almost always the
              // start of a text selection, not a request to see details.
              const tag = selectableItem.tagName;
              const isProse = tag === 'USER-MESSAGE' || tag === 'ASSISTANT-MESSAGE';
              if (!isProse && !onControl) {
                selection.dispatchItemSelected(this, itemId, 'user', true);
              }
              return;
            }
            // A click on a control inside an unselected tile still selects it —
            // the action belongs to that item — but it is not a request to see
            // the item's details, so it must not reveal the child column. Same
            // rule as the repeat click above: without it, answering a question
            // on a narrow viewport pages the columns away mid-answer.
            this._selectItem(itemId, 'user', { allowReveal: !onControl });
            // Move focus out of textarea so keyboard navigation works
            if (document.activeElement?.tagName === 'TEXTAREA') {
              /** @type {HTMLElement} */ (document.activeElement).blur();
            }
            // A click on a link selects the item AND follows the link: the
            // app's link safety net is a delegated handler on document, so
            // stopping propagation here would leave the anchor to its default
            // same-window navigation — off the app's page, with no way back.
            if (!target.closest?.('a[href]')) {
              e.stopPropagation();
            }
            return;
          }
        }

        // Clicked on the background — deselect any current item in this column,
        // then focus the input so the next keystroke starts composing.
        selection.clearSelection(this);
        const textarea = composer.querySelector('textarea');
        if (textarea) {
          textarea.focus();
        }
      });

      // Rule B: focusing the prompt textarea re-arms auto-follow. The user is
      // composing the next turn, not inspecting a pinned item. Use delegated
      // focusin so we survive any re-creation of the textarea inside composer-box.
      composer.addEventListener('focusin', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t && t.tagName === 'TEXTAREA') {
          this._selectionOrigin = null;
          selection.teardownSelectionVisibilityWatcher(this);
        }
      });
    }

    this.addEventListener('select-item-requested', (e) => {
      const { messageId } = /** @type {CustomEvent} */ (e).detail;
      if (messageId) this._selectItem(messageId, 'user');
    });

    this._setupScrollControls();
  }

  /**
   * Wire the subtle scroll-to-top / scroll-to-bottom controls overlaid on the
   * top-right of the message list. Each button smooth-scrolls to its end and is
   * shown only when the list overflows AND there's further to travel in that
   * direction (so a short, fully-visible thread shows neither, and the end you're
   * already at hides its own button). Visibility is recomputed on scroll and on
   * any size change of the viewport or its content.
   * @private
   */
  _setupScrollControls() {
    const messageList = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const controls = /** @type {HTMLElement|null} */ (this.querySelector('#scroll-controls'));
    if (!messageList || !controls) return;

    controls.querySelector('[data-scroll="top"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._scrollToConversationStart();
    });
    controls.querySelector('[data-scroll="bottom"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      scroll.scrollEndIntoView(this, true);
    });

    messageList.addEventListener('scroll', () => {
      this._updateScrollControls();
      // Wherever the reader has just put the view is their place to hold.
      this._recordReaderAnchorFromScroll();
      // Any scroll — even a slow drag that crosses no skip margin — counts as
      // activity, so hold off flushing queued collapses until it stops.
      if (this._pendingSkip.size) this._armSkipFlush();
    }, { passive: true });

    // Recompute on content growth (streaming, inserts) and viewport resize, both
    // of which change whether — and how far — the list can scroll.
    this._scrollControlsResizeObserver = new ResizeObserver(() => this._updateScrollControls());
    this._scrollControlsResizeObserver.observe(messageList);
    const inner = this.querySelector('#message-list-inner');
    if (inner) this._scrollControlsResizeObserver.observe(inner);

    // Drive the content-visibility skip (styles.css `.cv-off`) explicitly, via two
    // observers forming a hysteresis band: a row RENDERS at the inner margin and
    // SKIPS only past the wider outer margin, so a collapse-induced geometry shift
    // can't carry it back across the render edge and re-toggle it forever.
    // Renders apply immediately (a row must paint before it scrolls into view);
    // skips are only queued and flushed once scrolling goes idle (_flushRowSkips),
    // because collapsing a row below the viewport shifts content mid-gesture — the
    // clunk the user sees — in this bottom-anchored (column-reverse) scroller.
    const RENDER_MARGIN = '150% 0px'; // render within ~1.5 viewports (near edge)
    const SKIP_MARGIN = '300% 0px'; // queue skip beyond ~3 viewports (far edge)
    if (typeof IntersectionObserver !== 'undefined') {
      // Near edge: render now and cancel any queued skip — the row is back in range.
      this._rowRenderObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = /** @type {HTMLElement} */ (entry.target);
          target.classList.remove('cv-off');
          this._pendingSkip.delete(target);
        }
      }, { root: messageList, rootMargin: RENDER_MARGIN });
      // Far edge: queue for collapse and (re)arm the idle timer. Crossings fire
      // throughout a scroll, so the timer keeps resetting until the gesture stops.
      this._rowSkipObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) continue;
          this._pendingSkip.add(/** @type {HTMLElement} */ (entry.target));
        }
        this._armSkipFlush();
      }, { root: messageList, rootMargin: SKIP_MARGIN });
      this._reconcileRowVisibility();
    }

    this._updateScrollControls();
    this._setupReaderAnchor();
  }

  /**
   * Reader anchor: while the reader is scrolled away from the end, hold the
   * lines under their eyes still, whatever arrives below them.
   *
   * The scroller is column-reverse, which anchors the BOTTOM edge: anything
   * added at the end — an appended row, a streaming bubble growing, a tool row
   * that fills in its body a tick later, the footer changing height — shoves the
   * content above it up, and a reader who has scrolled up to read watches their
   * place walk off the top with nothing they can do about it while a turn runs.
   *
   * Why an observer rather than a correction around each mutation: the content
   * does not settle when the mutation returns. Rendering a row can land in a
   * later task, so an anchor scoped to one DOM write holds only the part of the
   * growth that happened inside it. A ResizeObserver on the content column sees
   * every layout change however it arrives, and its callback runs in the
   * rendering steps BEFORE paint, so the correction is never a visible jump.
   *
   * Nothing to do while near the end — there, being pinned to the bottom is the
   * point, native anchoring does it for free, and the streaming height glide
   * (_animateStreamingResize, which only runs while pinned) smooths the rest.
   * @private
   */
  _setupReaderAnchor() {
    const inner = this.querySelector('#message-list-inner');
    if (!inner || typeof ResizeObserver === 'undefined') return;
    this._recordReaderAnchor();
    this._readerAnchorObserver = new ResizeObserver(() => this._holdReaderAnchor());
    this._readerAnchorObserver.observe(inner);
  }

  /**
   * Record where the reader's place currently is, so a later layout change can
   * be measured against it. Called whenever the scroll position changes: after
   * the user scrolls, the top-visible row IS their new place.
   * @private
   */
  _recordReaderAnchor() {
    if (scroll.isScrolledNearBottom(this)) {
      this._readerAnchor = null;
      return;
    }
    const el = scroll.topVisibleMessageElement(this);
    const inner = /** @type {HTMLElement|null} */ (this.querySelector('#message-list-inner'));
    this._readerAnchor = el
      ? { el, top: el.getBoundingClientRect().top, contentHeight: inner?.offsetHeight ?? 0 }
      : null;
  }

  /**
   * Run a DOM mutation with the reader's place held across it: measure a visible
   * row before, and afterwards nudge the scroll by however far that row moved.
   *
   * The observer above is the general mechanism, but it can only correct what it
   * is told about, one frame later. This closes the mutation itself, where the
   * bulk of the movement happens and where the correction can land in the same
   * task the content changed in — measured, corrected, and never painted apart.
   * Rect-derived and relative, so it is sign-agnostic in the reversed scroller,
   * and instant: a glide here would be the very movement it prevents.
   * @param {() => void} mutate - The DOM mutation to run.
   * @param {{skip?: boolean}} [opts] - `skip`: the caller is following the end of
   *   the conversation, where native bottom-anchoring is what's wanted and there
   *   is no reader's place to keep.
   * @private
   */
  _holdReaderAnchorOver(mutate, { skip = false } = {}) {
    const scroller = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const el = (skip || !scroller) ? null : scroll.topVisibleMessageElement(this);
    const before = el ? el.getBoundingClientRect().top : 0;

    mutate();

    // A row the mutation removed is no anchor; the observer picks the reader's
    // place up again from the next scroll or resize.
    if (!el || !scroller || !el.isConnected) return;
    const shift = el.getBoundingClientRect().top - before;
    if (Math.abs(shift) <= 0.5) return;
    scroller.scrollTo({ top: scroller.scrollTop + shift, behavior: 'instant' });
    this._recordReaderAnchor();
  }

  /**
   * Record the reader's place from a scroll event — unless the content is what
   * moved, in which case this scroll is the drift we exist to undo.
   *
   * A scroll event is not evidence that the reader scrolled. Growing the content
   * of this bottom-anchored scroller moves the scroll offset by itself, and the
   * browser fires the scroll steps BEFORE it delivers resize observations: take
   * that event at face value and the anchor is re-recorded at the drifted
   * position, so the correction that follows measures a shift of zero and the
   * reader is left where the content put them. Content size is what tells the
   * two apart — the reader moving the view doesn't change it.
   * @private
   */
  _recordReaderAnchorFromScroll() {
    const inner = /** @type {HTMLElement|null} */ (this.querySelector('#message-list-inner'));
    if (this._readerAnchor && inner && inner.offsetHeight !== this._readerAnchor.contentHeight) return;
    this._recordReaderAnchor();
  }

  /**
   * Put the anchored row back where it was, by nudging the scroll position by
   * however far it drifted. Relative and rect-derived, so it is sign-agnostic
   * across the reversed scroller, and instant — a glide here would be the very
   * movement it exists to prevent.
   * @private
   */
  _holdReaderAnchor() {
    const anchor = this._readerAnchor;
    if (!anchor) return;
    // An anchor whose row the rebuild removed can't be measured; take the new
    // top-visible row as the place instead, from this position on.
    if (!anchor.el.isConnected || scroll.isScrolledNearBottom(this)) {
      this._recordReaderAnchor();
      return;
    }
    const scroller = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    if (!scroller) return;
    const shift = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) <= 0.5) return;
    scroller.scrollTo({ top: scroller.scrollTop + shift, behavior: 'instant' });
    // Re-measure rather than assume the nudge landed in full: scrollTop clamps
    // at both ends of the range, and a clamped correction is the true new place.
    anchor.top = anchor.el.getBoundingClientRect().top;
    anchor.contentHeight = /** @type {HTMLElement} */ (this.querySelector('#message-list-inner'))?.offsetHeight ?? 0;
  }

  /**
   * Observe any transcript rows not yet handed to the row-visibility observers.
   * Each new row is registered with BOTH edges of the hysteresis band — the
   * render observer (near margin) and the skip observer (far margin). Idempotent
   * and cheap (the WeakSet skips already-observed rows), so it is safe to call on
   * every render; rows removed from the DOM are auto-dropped by both observers,
   * so no explicit unobserve is needed.
   * @private
   */
  _reconcileRowVisibility() {
    if (!this._rowRenderObserver || !this._rowSkipObserver) return;
    const content = this.querySelector('#message-list-inner');
    if (!content) return;
    for (const child of Array.from(content.children)) {
      if (!CV_ROW_TAGS.has(child.tagName) || this._observedRows.has(child)) continue;
      this._observedRows.add(child);
      this._rowRenderObserver.observe(child);
      this._rowSkipObserver.observe(child);
    }
  }

  /**
   * (Re)arm the scroll-idle timer that flushes queued row collapses. Each
   * skip-crossing and scroll event pushes it out, so it fires only once scrolling
   * has been quiet for SKIP_FLUSH_IDLE_MS.
   * @private
   */
  _armSkipFlush() {
    if (this._skipFlushTimer !== null) clearTimeout(this._skipFlushTimer);
    this._skipFlushTimer = window.setTimeout(() => {
      this._skipFlushTimer = null;
      this._flushRowSkips();
    }, SKIP_FLUSH_IDLE_MS);
  }

  /**
   * Collapse the rows queued past the skip margin without moving the view. The
   * freeze into contain-intrinsic-size should make each collapse height-neutral,
   * but WebKit doesn't honour it exactly and this column-reverse scroller pins the
   * bottom, so a residual shrink below the viewport lurches the content. So we
   * don't trust the freeze: anchor on the row at the viewport centre, apply the
   * batch, then correct scrollTop by however far that anchor actually moved — all
   * synchronously, so only the corrected frame paints.
   * @private
   */
  _flushRowSkips() {
    if (!this._pendingSkip.size) return;
    const list = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const rows = Array.from(this._pendingSkip).filter((row) => row.isConnected);
    this._pendingSkip.clear();
    if (!rows.length || !list) return;

    // Anchor on the visible row at the viewport centre (elementFromPoint keeps
    // this O(1)) — never one of the far-offscreen rows being collapsed.
    const listRect = list.getBoundingClientRect();
    let anchor = /** @type {Element|null} */ (
      document.elementFromPoint(listRect.left + listRect.width / 2, listRect.top + listRect.height / 2)
    );
    while (anchor && !CV_ROW_TAGS.has(anchor.tagName)) anchor = anchor.parentElement;
    const anchorTopBefore = anchor ? anchor.getBoundingClientRect().top : 0;

    // Read all heights first (one shared layout flush), then apply freeze + cv-off.
    const measured = rows.map((row) => ({ row, height: row.getBoundingClientRect().height }));
    for (const { row, height } of measured) {
      if (height > 0) row.style.containIntrinsicSize = `${height}px`;
      row.classList.add('cv-off');
    }

    // Cancel the anchor's displacement, forced instant (the list scrolls smooth).
    if (!anchor) return;
    const shift = anchor.getBoundingClientRect().top - anchorTopBefore;
    if (!shift) return;
    const prevBehavior = list.style.scrollBehavior;
    list.style.scrollBehavior = 'auto';
    list.scrollTop += shift;
    list.style.scrollBehavior = prevBehavior;
  }

  /**
   * Toggle each scroll-control button's visibility from the live scroll metrics.
   * In the reversed scroller the bottom (newest) is scrollTop 0 and the magnitude
   * grows toward the top, so |scrollTop| is the distance from the bottom and the
   * max magnitude is scrollHeight − clientHeight — both sign-agnostic.
   * @private
   */
  _updateScrollControls() {
    const messageList = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const controls = /** @type {HTMLElement|null} */ (this.querySelector('#scroll-controls'));
    if (!messageList || !controls) return;

    const topBtn = controls.querySelector('[data-scroll="top"]');
    const bottomBtn = controls.querySelector('[data-scroll="bottom"]');
    if (!topBtn || !bottomBtn) return;

    // Distance from the bottom (0) to the top, always >= 0.
    const range = messageList.scrollHeight - messageList.clientHeight;
    // "Long enough to be useful" — don't clutter a thread that barely overflows.
    const USEFUL_OVERFLOW_PX = 48;
    // Hide a direction's button once we're within a couple of rems of that end —
    // close enough that a flick finishes the trip.
    const EDGE_PX = 32;
    const fromBottom = Math.abs(messageList.scrollTop);

    if (range <= USEFUL_OVERFLOW_PX) {
      topBtn.classList.add('hidden');
      bottomBtn.classList.add('hidden');
      return;
    }

    // Hide the button for the end we're already resting near.
    topBtn.classList.toggle('hidden', fromBottom >= range - EDGE_PX);
    bottomBtn.classList.toggle('hidden', fromBottom <= EDGE_PX);
  }

  /**
   * Smooth-scroll to the very start (oldest message) of the conversation. Uses a
   * relative, viewport-rect-based nudge (like scrollElementIntoView) so it's
   * agnostic to the reversed scroller's scrollTop sign, and clamped so it lands
   * exactly at the top rather than overshooting.
   * @private
   */
  _scrollToConversationStart() {
    const messageList = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const content = /** @type {HTMLElement|null} */ (this.querySelector('#message-list-inner'));
    if (!messageList || !content) return;
    const first = content.firstElementChild;
    if (!first) return;
    const delta = first.getBoundingClientRect().top - messageList.getBoundingClientRect().top;
    messageList.scrollTo({ top: messageList.scrollTop + delta, behavior: 'smooth' });
  }

  // --- Public API for keyboard navigation (called by conversation-tab) ---

  /** Select the next item in the list */
  selectNextItem() {
    selection.selectNextItem(this);
  }

  /** Select the previous item in the list */
  selectPreviousItem() {
    selection.selectPreviousItem(this);
  }

  /** Skip forward to the next user message */
  selectNextUserMessage() {
    selection.selectNextUserMessage(this);
  }

  /** Skip backward to the previous user message */
  selectPreviousUserMessage() {
    selection.selectPreviousUserMessage(this);
  }

  /**
   * Select a specific item by ID
   * @param {string} itemId
   */
  selectItem(itemId) {
    this._selectItem(itemId);
  }

  /** Clear the current selection */
  clearSelection() {
    selection.clearSelection(this);
  }

  /** @returns {string[]} List of selectable item IDs */
  getSelectableItemIds() {
    return selection.getSelectableItemIds(this);
  }

  /** @returns {string|null} Currently selected item ID */
  getSelectedItemId() {
    return this._localSelectedItemId;
  }

  /** @returns {HTMLElement|null} The currently selected item's DOM element */
  getSelectedElement() {
    if (!this._localSelectedItemId) return null;
    return this.querySelector(`[message-id="${this._localSelectedItemId}"]`);
  }

  /**
   * Whether the selected row opens a column of its own: a sub-thread, or a
   * folded group of tool rows. Both are containers the user drills into, so
   * arrow-right treats them identically.
   * @returns {boolean} True if the selected item can be navigated into
   */
  isSelectedItemDrillable() {
    if (!this._localSelectedItemId) return false;
    const el = this.querySelector(
      `thread-message[message-id="${this._localSelectedItemId}"], ` +
      `tool-group-message[message-id="${this._localSelectedItemId}"]`
    );
    return el !== null;
  }

  // ── Selection & scrolling ────────────────────────────────────────
  //
  // Both engines live in companion modules: the selection rules (1-5b) in
  // conversation-area-selection.js, the scroll rules (6-11) in
  // conversation-area-scroll.js. The UX rules they implement, and why each
  // scroll is clamped scrollTop math rather than scrollIntoView, are written up
  // in those two module docs. What stays here are the entry points other files
  // call.
  //
  // The underscore-prefixed delegates below are not private in practice:
  // conversation-tab reaches into them to apply a selection made during a
  // column rebuild without re-entering the event path, and the browser tests
  // drive _selectItem directly.
  // ────────────────────────────────────────────────────────────────

  /**
   * Handle newly inserted items — auto-select the best candidate.
   * Called by conversation-tab when conversation:changed carries insertedItemIds.
   * @param {string[]} insertedItemIds
   * @param {Array<any>} items - Current full items array
   */
  onItemsInserted(insertedItemIds, items) {
    selection.onItemsInserted(this, insertedItemIds, items);
  }

  /**
   * Rule 2b: the itemId of the pending-approval item that should become the
   * next auto-selection, or null. Called by conversation-tab.
   * @returns {string|null} itemId to auto-select, or null
   */
  getNextPendingApprovalToSelect() {
    return selection.getNextPendingApprovalToSelect(this);
  }

  /**
   * @param {string} itemId
   * @param {'user'|'auto'} [origin='user']
   * @param {{allowReveal?: boolean}} [opts]
   * @private
   */
  _selectItem(itemId, origin = 'user', opts = {}) {
    selection.selectItem(this, itemId, origin, opts);
  }

  /**
   * @param {string|null} selectedId
   * @private
   */
  applySelectedClass(selectedId) {
    selection.applySelectedClass(this, selectedId);
  }

  /**
   * @param {string} itemId
   * @param {boolean} [smooth=false]
   * @private
   */
  scrollItemIntoView(itemId, smooth = false) {
    scroll.scrollItemIntoView(this, itemId, smooth);
  }

  /**
   * Rule 11's test, read from outside: is this column following the end of the
   * conversation, or has its reader scrolled away? conversation-tab asks before
   * making any tab-level move that would pull a column out from under them.
   * @returns {boolean} True when the view is within ~20rem of the end.
   */
  isScrolledNearBottom() {
    return scroll.isScrolledNearBottom(this);
  }

  /**
   * Persist current scroll state (atBottom + element anchor) to localStorage.
   * Called on pagehide.
   */
  saveScrollPositionImmediately() {
    scroll.saveScrollPositionImmediately(this);
  }

  /**
   * Restore scroll position from localStorage. Called by conversation-tab
   * after messages are rendered. Only restores once per conversation load.
   */
  restoreScrollPosition() {
    scroll.restoreScrollPosition(this);
  }

  /**
   * Scroll to bottom if conditions allow
   * @param {boolean} [force=false] - If true, scroll regardless of user position
   */
  scrollToBottom(force = false) {
    scroll.scrollToBottom(this, force);
  }

  /**
   * Reset scroll restore flag (called when conversation changes)
   */
  resetScrollRestoreFlag() {
    this._initialScrollRestored = false;
    this._animationsPrimed = false;
  }

  // ============================================================
  // DOM RENDERING (orchestration)
  // ============================================================
  //
  // The heavy lifting — element creation, ID-based diffing, position
  // shuffling — lives in conversation-area-rendering.js as pure
  // functions. This block contains only the orchestration that knows
  // about widget state (selection, footer, scroll).
  //
  // ============================================================

  /**
   * Render conversation from items array using ID-based diffing.
   *
   * Reentrancy guard: selecting and clearing dispatch item-selected,
   * which can trigger _rebuildColumns → renderFromItems in conversation-tab.
   * @param {Array<any>} items
   */
  renderFromItems(items) {
    if (this._isRendering) return;
    this._isRendering = true;

    try {
      this._renderFromItemsInner(items);
    } finally {
      this._isRendering = false;
    }
  }

  /**
   * @param {Array<any>} items
   * @private
   */
  _renderFromItemsInner(items) {
    // The content lives in the normal-order inner column, not the reversed
    // scroller. All the structural helpers operate on direct children, so they
    // are handed the inner container.
    const content = /** @type {HTMLElement|null} */ (this.querySelector('#message-list-inner'));
    if (!content) return;

    const footer = ensureFooterExists(this, content);

    if (!items || items.length === 0) {
      this._memberToGroup = new Map();
      removeAllElements(content);
      return;
    }

    // Everything below works on DISPLAY entries: the same Y.Maps, except that a
    // run of adjacent tool rows arrives as one group entry. Group entries carry
    // an itemId and a type like any item, so the id-based diff below is unaware
    // of the difference.
    items = this._computeDisplay(items).entries;

    const currentElements = buildElementMap(content);
    const elementsToKeep = identifyElementsToKeep(items, currentElements);

    // FLIP "First": capture pre-mutation positions, but ONLY when a real
    // structural change (an insert or a removal) is about to happen AND the user
    // is at the bottom — the one case where the column-reverse relayout would
    // otherwise jump. _renderFromItemsInner also runs on every streaming token
    // (an existing bubble growing has no structural change), so this gate keeps
    // those ticks on the cheap, instant native pinning and animates only genuine
    // item changes.
    const structuralChange =
      items.some((it) => it && !currentElements.has(getItemId(it)))
      || currentElements.size > elementsToKeep.size;
    const nearBottom = scroll.isScrolledNearBottom(this);
    const animate = structuralChange
      && this._animationsPrimed
      && !prefersReducedMotion()
      && nearBottom;
    const beforeTops = animate ? this._captureItemTops(content) : null;

    this._holdReaderAnchorOver(() => {
      removeDeletedElements(currentElements, elementsToKeep);
      positionElements(this, content, footer, items, currentElements);

      // Hand any newly inserted rows to the visibility observer that drives the
      // content-visibility skip. New rows start without `cv-off` (rendered), so the
      // just-inserted tail is never born blank; the observer applies cv-off only
      // once it confirms a row has scrolled far out of view.
      this._reconcileRowVisibility();

      // Terminal "Result" block, synthesized from the thread's `result` field
      // (after positioning items so it lands just before the footer). No-op in
      // the root column.
      ensureThreadResult(this, content, footer);

      // Queued (pending) messages, rendered after the footer. Before the selection
      // re-apply below so a selected queued bubble is seen as visible.
      ensurePendingMessages(this, content);

      // Re-apply .selected class after DOM reconciliation. If the selected item
      // was removed, silently clear — the tab owns selection state. Never
      // dispatch item-selected here (it would loop back via conversation-tab).
      if (this._localSelectedItemId) {
        if (!selection.isItemVisible(this, this._localSelectedItemId)) {
          this._localSelectedItemId = null;
          this._selectionOrigin = null;
          selection.teardownSelectionVisibilityWatcher(this);
          this.applySelectedClass(null);
        } else {
          this.applySelectedClass(this._localSelectedItemId);
        }
      }

      this.updateFooter();
    }, { skip: nearBottom });

    // FLIP "Invert + Play": now the DOM is in its final position, glide the
    // moved items from where they were and fade newly-inserted ones in.
    if (beforeTops) this._playInsertAnimation(content, beforeTops);
    this._animationsPrimed = true;
  }

  /**
   * FLIP "First": record the viewport-relative top of each on-screen message
   * element, keyed by message-id. Off-screen items above the fold are clipped by
   * the scroller, so animating them would be wasted work — only the visible band
   * is captured.
   * @param {HTMLElement} content - The inner content column.
   * @returns {Map<string, number>} message-id → top (px, viewport-relative).
   * @private
   */
  _captureItemTops(content) {
    /** @type {Map<string, number>} */
    const tops = new Map();
    const scroller = this.querySelector('#message-list');
    if (!scroller) return tops;
    const listRect = scroller.getBoundingClientRect();
    for (const el of Array.from(content.children)) {
      const id = el.getAttribute?.('message-id');
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < listRect.top || rect.top > listRect.bottom) continue;
      tops.set(id, rect.top);
    }
    return tops;
  }

  /**
   * FLIP "Invert + Play": with the new DOM already in its final (instantly
   * relaid-out) position, transform each surviving message back to where it was
   * and start newly-inserted ones slightly faded/offset, then release everything
   * with a transition so the column-reverse jump reads as a glide. Pure
   * transform/opacity — never touches scrollTop, so it composes with the reversed
   * scroller's native bottom pinning.
   * @param {HTMLElement} content - The inner content column.
   * @param {Map<string, number>} beforeTops - Positions captured by _captureItemTops.
   * @private
   */
  _playInsertAnimation(content, beforeTops) {
    const scroller = this.querySelector('#message-list');
    if (!scroller) return;
    const listRect = scroller.getBoundingClientRect();
    /** @type {HTMLElement[]} */
    const touched = [];

    for (const el of Array.from(content.children)) {
      const node = /** @type {HTMLElement} */ (el);
      const id = node.getAttribute?.('message-id');
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < listRect.top || rect.top > listRect.bottom) continue;

      const before = beforeTops.get(id);
      if (before === undefined) {
        // Newly inserted and on-screen: rise + fade in.
        node.style.transition = 'none';
        node.style.opacity = '0';
        node.style.transform = 'translateY(10px)';
        touched.push(node);
      } else {
        const delta = before - rect.top;
        if (Math.abs(delta) < 0.5) continue;
        node.style.transition = 'none';
        node.style.transform = `translateY(${delta}px)`;
        touched.push(node);
      }
    }

    if (touched.length === 0) return;

    // Flush the inverted state, then play it back on the next frame.
    void content.offsetHeight;

    requestAnimationFrame(() => {
      for (const node of touched) {
        node.style.transition = `transform ${INSERT_ANIM_MS}ms ease, opacity ${INSERT_ANIM_MS}ms ease`;
        node.style.transform = '';
        node.style.opacity = '';
        const done = (/** @type {Event} */ e) => {
          if (e.target !== node) return;
          node.style.transition = '';
          node.style.transform = '';
          node.style.opacity = '';
          node.removeEventListener('transitionend', done);
        };
        node.addEventListener('transitionend', done);
      }
    });
  }


  /**
   * Get the conversation footer component
   * @returns {import('./conversation-footer.js').default} The footer component
   * @private
   */
  _getFooter() {
    return /** @type {import('./conversation-footer.js').default} */ (
      this.querySelector('conversation-footer')
    );
  }

  /**
   * Current next steps text for the footer
   * @type {string}
   * @private
   */
  _nextSteps = '';

  /**
   * Whether the Continue button should be visible.
   * Mirrors the runtime guards in MessageThread.continue().
   * @returns {boolean} true if the Continue button should be shown
   * @private
   */
  _canContinue() {
    const mt = this._messageThread;
    if (!mt) return false;
    // While the conversation is busy driving ANY thread, continueThread() bails
    // (its `conversation.isProcessing` guard). This thread's own column can look
    // idle from its vantage — e.g. a sibling sub-thread is the live one and this
    // one is "Waiting for its turn…", so `hasBusyItems()` below is false — yet
    // Continue would be a silent no-op. Hide it rather than offer a dead button.
    if (mt.isProcessing) return false;
    const hasEffective = mt.getMessages().some(m => isUserMessage(m) || isAssistantMessage(m) || isToolActionMessage(m) || isThreadMessage(m));
    if (!hasEffective) return false;
    // A summary does not bar continuing: a thread carrying one has come to rest,
    // which is exactly the state Continue drives it out of.
    // Don't show Continue while items are busy (tool running, thread pending)
    if (mt.hasBusyItems()) return false;
    return true;
  }

  /**
   * Update the footer based on current conversation state.
   * This is the ONLY method that should modify the footer display.
   * Call this whenever conversation state changes.
   *
   * SINGLE SOURCE OF TRUTH: Status message from LLMState determines isProcessing.
   * If there's a message, we're processing. If not, we're not.
   * This makes it structurally impossible to show a spinner without a message.
   */
  updateFooter() {
    const footer = this._getFooter();

    // Single source for both the footer and any thread-message tiles in this
    // column: the conversation's live LLM status. We resolve it once and use
    // the same `live` object to drive footer copy AND to push into tiles via
    // setLiveStatus — that way the parent tile's status string is literally
    // the same string the sub-thread's footer would render.
    const live = this._snapshotLiveStatus();
    this._broadcastLiveStatusToTiles(live);

    // Footer source 1: LLM status targeting THIS column (so a column whose
    // threadItemId is the active one shows the rich "Streaming • 250 tokens"
    // text; columns whose tiles represent the active thread leave that to
    // the tile face).
    const myThreadId = this._messageThread?.threadItemId || null;
    // A group column is a SLICE of its parent thread: it shares the parent's
    // message thread outright (conversation-tab._buildConversationColumn), so
    // every thread-level signal below matches in EVERY group column of a busy
    // thread — including runs that finished long ago. Scope those signals to the
    // rows this column actually shows, so only the run holding the live work
    // reports it.
    const groupItems = this._isGroupColumn ? (this._groupItems || []) : null;
    /** @type {{message: string, spinner: boolean}|null} */
    let llmStatus = null;
    if (live && live.threadId === myThreadId &&
        (!groupItems || hasUnsettledToolInTree(groupItems))) {
      llmStatus = { message: live.message, spinner: true };
    }

    // Footer source 2: last busy item that wants to be reflected in the
    // footer (tool actions, etc.). Thread-message tiles render themselves
    // and return null here so the footer doesn't double up.
    const itemBusy = this._getLastBusyItemState();

    // LLM status takes priority (most time-sensitive), then item states
    const busyState = llmStatus || itemBusy;

    const hasPendingApprovals = groupItems
      ? hasPendingApprovalInTree(groupItems)
      : (this._messageThread?.getPendingApprovalMessages().length ?? 0) > 0;
    // While the loop is parked on an approval the worker keeps publishing
    // `processing_tools`, so any busyState here is the LLM loop's idea of
    // "still working" — but the actual blocker is user input. Override the
    // footer text (and drop the spinner) so the status reflects reality.
    const isProcessing = hasPendingApprovals || !!busyState;

    // Spinner inputs, computed ONLY while a turn is running. Both are read by
    // the busy spinner and by nothing else, and updateFooter runs on every
    // streaming tick — several times a second, on every column — so doing this
    // work on an idle footer would walk the whole item tree many times a second
    // to feed an indicator that isn't on screen.
    //
    // How much is genuinely executing at once, for the club count. Scoped the
    // same way as the status signals above: a group column reports only the run
    // it shows, everything else the whole thread (nested threads included).
    const running = isProcessing
      ? runningToolsInTree(groupItems || this._messageThread?.items)
      : { count: 0, oldestStart: 0 };
    const runningTools = running.count;
    // How long we have been waiting on the tool call we are STILL waiting on,
    // for the tool-wait ramp. Null when nothing is executing, which is what
    // tells the spinner to read the speed off throughput instead. A running
    // tool with no claim stamp yet counts as freshly started (0) rather than as
    // no tool at all — the wait is real, we just can't date it.
    const toolWaitMs = runningTools > 0
      ? Math.max(0, running.oldestStart ? Date.now() - running.oldestStart : 0)
      : null;
    // How fast output is arriving, for the speed while streaming. Zero while
    // parked on a tool call or waiting on the network — the truth of those
    // moments rather than a missing reading.
    const throughput = isProcessing
      ? (this._conversation?.llmState?.getThroughput?.(this._conversation.id) ?? 0)
      : 0;
    const statusMessage = hasPendingApprovals
      ? StatusMessageBuilder.withBusyMarker('Waiting for user approval')
      : (busyState?.message || '');
    const showSpinner = hasPendingApprovals ? false : (busyState?.spinner ?? true);

    // A group column is a lens on a run of tool rows, not a thread. The rows are
    // the parent thread's, and this column shares that thread outright, so every
    // control below (Continue, Close, Duplicate, Add Context Item) would act on
    // the parent from inside the lens, and the meter would count the parent's
    // context. Everything but the status line — which the group-scoped signals
    // above have already narrowed to this run — is left out.
    if (this._isGroupColumn) {
      footer.setStatusOnly(true);
      footer.update({ isProcessing, canContinue: false, statusMessage, showSpinner, runningTools, throughput, toolWaitMs });
      return;
    }
    footer.setStatusOnly(false);

    const canContinue = this._canContinue();

    // Duplicate tab button lives only on the conversation's root thread
    // (threadItemId null), and only when there's content worth cloning.
    const isRootThread = !this._messageThread?.threadItemId;
    const showDuplicateTab = isRootThread && canContinue;

    // When the thread last changed, for the idle row's timestamp. Read only at
    // rest, for the same reason as the spinner inputs above in reverse: it
    // walks the item list, and the row that shows it is hidden mid-turn.
    const lastActivityAt = isProcessing ? 0 : (this._messageThread?.lastActivityAt ?? 0);

    footer.update({
      isProcessing,
      canContinue,
      statusMessage,
      showSpinner,
      nextSteps: this._nextSteps,
      showDuplicateTab,
      busyItemMessageId: itemBusy?.messageId,
      politePending: !!this._conversation?.isPolitePending?.(),
      runningTools,
      throughput,
      toolWaitMs,
      lastActivityAt,
    });
  }

  /**
   * Find the last busy item's state by querying getBusyState() on each conversation-item.
   * The footer has no knowledge of specific item types - it just asks.
   * @returns {{message: string, spinner: boolean, messageId?: string}|null} The last busy item's state, or null if no items are busy
   * @private
   */
  _getLastBusyItemState() {
    /** @type {{message: string, spinner: boolean, messageId?: string}|null} */
    let lastBusy = null;
    for (const el of Array.from(this.querySelectorAll('.conversation-item'))) {
      const state = /** @type {any} */ (el).getBusyState?.();
      if (state) lastBusy = { ...state, messageId: el.getAttribute('message-id') || undefined };
    }
    return lastBusy;
  }

  /**
   * Trigger footer update (called by LLMState when status changes)
   */
  showBusy() {
    // Rule 10: scroll follow target into view (only if near bottom)
    const wasNearBottom = scroll.isScrolledNearBottom(this);
    this.updateFooter();
    if (wasNearBottom) {
      scroll.scrollToFollowIfNeeded(this);
    }
  }

  /**
   * Trigger footer update (called by LLMState when status changes)
   */
  updateBusyMessage() {
    this.updateFooter();
  }

  /**
   * Trigger footer update and clear next steps (called by LLMState when processing stops)
   */
  hideBusy() {
    this._nextSteps = '';
    this.updateFooter();
  }

  /**
   * Show or hide the next-steps (`<plan>`) indicator for THIS column. The plan
   * is per-thread state: a sub-thread column reads it from its own thread Y.Map
   * (like goal/result/resultSpec), the root column from conversation metadata
   * (root has no Y.Map). So a sub-thread's plan surfaces only on its own
   * column's footer — never on the root or a sibling — and concurrent threads
   * never share one slot.
   * @private
   */
  _refreshNextStepsIndicator() {
    if (!this._conversation) return;
    const plan = this._threadYMap
      ? (this._threadYMap.get('nextSteps') || '')
      : (this._conversation.getMetadata('nextSteps') || '');
    if (plan) {
      this.showNextStepsIndicator(plan);
    } else {
      this.clearNextStepsIndicator();
    }
  }

  /**
   * Show next steps indicator
   * @param {string} text - Next steps text
   */
  showNextStepsIndicator(text) {
    this._nextSteps = text;
    this.updateFooter();
  }

  /**
   * Clear next steps indicator
   */
  clearNextStepsIndicator() {
    this._nextSteps = '';
    this.updateFooter();
  }

}

customElements.define('conversation-area', ConversationArea);
