//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Drag one item of a strip to a new place in it. Shared by the conversation
 * sidebar's stacked tabs and the pinboard's wrapping tab strip, which want the
 * same gesture and differ only in geometry.
 *
 * A press becomes a drag only past a threshold, so an ordinary click still does
 * whatever a click does. Past it, the item is replaced in the flow by an
 * invisible placeholder and a clone floats free under the pointer; the
 * remaining items animate into the arrangement the drop would produce, so the
 * strip shows the result rather than a marker predicting it. Release commits
 * once, with the indices, and the caller does the editing — a strip is not the
 * place that owns the order.
 *
 * The siblings move by FLIP: the placeholder is put where it would land, every
 * item is measured before and after, and each is transformed back to where it
 * was and released. Nothing here computes an offset from a row height, so a
 * strip that wraps is not a special case — an item crossing from the end of one
 * row to the start of the next travels the diagonal it actually travels.
 *
 * Pointer events are taken on the document rather than on the item: a strip
 * that re-renders mid-drag takes the pointerdown target out of the DOM, and
 * with it the implicit capture, stranding the gesture.
 * @module utils/reorder-drag
 */

/** How far a pointer must travel before a press becomes a drag. */
const DEFAULT_THRESHOLD_PX = 5;

/** How close to an edge the pointer must be for the strip to scroll itself. */
const EDGE_HOTZONE_PX = 30;

/** The fastest one frame of edge-scrolling may travel. */
const MAX_SCROLL_STEP_PX = 18;

/**
 * Only auto-scroll a genuinely overflowing strip. A hair of sub-pixel overflow
 * (bottom padding plus rounding) must not make a fully-fitting one creep while
 * you drag near its edge.
 */
const SCROLL_OVERFLOW_MIN_PX = 4;

/**
 * @typedef {object} ReorderDragOptions
 * @property {HTMLElement} item - The element being dragged.
 * @property {() => HTMLElement[]} items - The reorderable items, in strip order. Called live, and must exclude the floating clone.
 * @property {HTMLElement} [captureTarget] - Which element takes the pointer. Must be the one carrying the click handler. Defaults to the item.
 * @property {HTMLElement} [strip] - The element holding the items, marked while a drag is live so a stylesheet can gate its transitions. Defaults to the item's parent.
 * @property {HTMLElement} [ghostHost] - Where the clone is parked. Defaults to the item's parent; give a host outside any clipping scroll box.
 * @property {HTMLElement|null} [scrollContainer] - The strip's scroll box, for edge auto-scrolling. Omit for a strip that does not scroll.
 * @property {'x'|'y'|'xy'} [axis] - Which way the clone follows the pointer, and which distance arms the threshold. Default `'y'`.
 * @property {boolean} [wrap] - Whether the strip wraps onto more than one row, which decides how a drop position is read. Default `false`.
 * @property {number} [thresholdPx] - How far to move before this is a drag.
 * @property {{ghost?: string, source?: string, dragging?: string}} [classes] - Class for the clone, for the placeholder left behind, and for the strip while a drag is live.
 * @property {(clone: HTMLElement) => void} [prepareGhost] - Scrub the clone before it is shown — identity attributes, transient state.
 * @property {(detail: {item: HTMLElement, fromIndex: number, toIndex: number}) => void} [onCommit] - The drop landed somewhere new. `toIndex` indexes the strip WITHOUT the dragged item.
 * @property {() => void} [onDragStart] - The threshold was passed.
 * @property {(detail: {dragged: boolean, moved: boolean}) => void} [onDragEnd] - The gesture is over: whether it ever became a drag, and whether it committed.
 */

/**
 * @typedef {object} ReorderDragHandle
 * @property {() => boolean} isActive - Whether the threshold has been passed and a drag is live.
 * @property {() => void} cancel - Abandon the gesture, committing nothing.
 */

/**
 * Begin a reorder gesture from a pointerdown.
 *
 * The caller decides what counts as a grab — which button, which descendants
 * are excluded, whether touch needs a handle — and calls this once it has.
 * @param {PointerEvent} event - The pointerdown that started it.
 * @param {ReorderDragOptions} options - The strip, and what to do with the result.
 * @returns {ReorderDragHandle} A handle on the gesture.
 */
export function startReorderDrag(event, options) {
  const {
    item,
    items,
    captureTarget = item,
    strip = /** @type {HTMLElement} */ (item.parentElement),
    ghostHost = /** @type {HTMLElement} */ (item.parentElement),
    scrollContainer = null,
    axis = 'y',
    wrap = false,
    thresholdPx = DEFAULT_THRESHOLD_PX,
    classes = {},
    prepareGhost,
    onCommit,
    onDragStart,
    onDragEnd,
  } = options;

  const ghostClass = classes.ghost || 'drag-ghost';
  const sourceClass = classes.source || 'drag-source';
  const draggingClass = classes.dragging || 'is-dragging';

  const startOrder = items();
  const fromIndex = startOrder.indexOf(item);

  /** Where the placeholder currently sits, as an index into the strip without it. */
  let dropIndex = fromIndex < 0 ? 0 : fromIndex;
  let active = false;
  let finished = false;
  /** @type {HTMLElement|null} */
  let ghost = null;
  /** @type {number|null} */
  let autoScrollRaf = null;
  let lastClientX = event.clientX;
  let lastClientY = event.clientY;

  // Where the placeholder goes back to if the gesture is abandoned.
  const homeParent = item.parentElement;
  const homeNext = item.nextSibling;

  /**
   * Take the pointer for the rest of the gesture.
   *
   * Capture retargets the release, and the click the browser fires afterwards
   * goes to the common ancestor of the press and the release — so capture taken
   * anywhere but the element carrying the click handler puts that click out of
   * its reach. Hence `captureTarget`, which for a strip whose item is a wrapper
   * around the clickable thing is not the item.
   *
   * It is taken at the threshold rather than at the press for the same reason
   * the DOM is left alone below it: a press that stays a click must leave no
   * trace for the click to trip over. Nothing here depends on holding it — the
   * listeners are on the document either way.
   */
  const capturePointer = () => {
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that has already been released cannot be captured.
    }
  };

  /**
   * Build the clone that travels, and hide the original in place.
   *
   * The clone is `position: fixed` on a host outside the strip's own clipping,
   * so it can leave the strip. Its anchor is the item's resting rect, so
   * translating it by the pointer delta keeps it under the finger exactly.
   *
   * `left`/`top` on a fixed element resolve against the viewport only while no
   * ancestor establishes a containing block for fixed positioning — and a
   * `transform` anywhere on the path does establish one (the phone sidebar
   * slides in under exactly that). Feeding it viewport coordinates there drops
   * the clone a whole header's height from the finger. So place it at the
   * origin, measure where that origin actually landed, and offset from there:
   * correct under either regime, and it stays correct for any transform,
   * filter or containment added to the path later.
   */
  const createGhost = () => {
    const rect = item.getBoundingClientRect();
    const clone = /** @type {HTMLElement} */ (item.cloneNode(true));
    clone.classList.add(ghostClass);
    clone.setAttribute('aria-hidden', 'true');
    clone.style.transform = 'none';
    clone.style.left = '0';
    clone.style.top = '0';
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    try {
      prepareGhost?.(clone);
    } catch (err) {
      console.error('[ReorderDrag] Could not prepare the drag clone:', err);
    }
    ghostHost.appendChild(clone);
    const origin = clone.getBoundingClientRect();
    clone.style.left = `${rect.left - origin.left}px`;
    clone.style.top = `${rect.top - origin.top}px`;
    ghost = clone;
    item.classList.add(sourceClass);
  };

  /**
   * Which position in the strip — counted without the dragged item — a pointer
   * here would drop into.
   *
   * A strip on one line is read along its axis: an item is passed once the
   * pointer is beyond its midpoint. A strip that wraps is read the way its
   * order reads, across rows: an item is passed if the pointer is below its row
   * entirely, or on its row and past its midpoint. So a pointer in the gutter
   * to the right of a short row lands at the end of that row rather than
   * skipping to the next.
   * @param {number} clientX - Pointer x in client coordinates.
   * @param {number} clientY - Pointer y in client coordinates.
   * @returns {number} The target index.
   */
  const indexAt = (clientX, clientY) => {
    const others = items().filter((el) => el !== item);
    for (let i = 0; i < others.length; i++) {
      const box = /** @type {HTMLElement} */ (others[i]).getBoundingClientRect();
      if (wrap) {
        if (clientY >= box.bottom) continue;
        if (clientY < box.top || clientX < box.left + box.width / 2) return i;
        continue;
      }
      const past = axis === 'x'
        ? clientX < box.left + box.width / 2
        : clientY < box.top + box.height / 2;
      if (past) return i;
    }
    return others.length;
  };

  /**
   * Show the arrangement the drop would produce: put the placeholder where it
   * would land, then FLIP everything from where it was to where it now is.
   * @param {number} index - The target index, without the dragged item.
   */
  const shiftTo = (index) => {
    const before = items();
    /** @type {Map<HTMLElement, DOMRect>} */
    const first = new Map();
    for (const el of before) first.set(el, el.getBoundingClientRect());

    const others = before.filter((el) => el !== item);
    const anchor = others[index] || null;
    // Already there: inserting before the node it already precedes moves
    // nothing, and doing it every frame churns the DOM for no reason.
    if (anchor !== item.nextElementSibling) item.parentElement?.insertBefore(item, anchor);

    for (const el of before) {
      const start = first.get(el);
      if (!start || el === item) continue;
      const end = el.getBoundingClientRect();
      const dx = start.left - end.left;
      const dy = start.top - end.top;
      el.style.transition = 'none';
      el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
    }
    // Two frames: one for the browser to accept the inverted position as the
    // starting point, one for the transition to run from it.
    requestAnimationFrame(() => {
      for (const el of before) {
        if (el === item) continue;
        el.style.transition = '';
        el.style.transform = '';
      }
    });
  };

  /**
   * Read the drop position, and rearrange if it has changed.
   * @param {number} clientX - Pointer x in client coordinates.
   * @param {number} clientY - Pointer y in client coordinates.
   */
  const recompute = (clientX, clientY) => {
    const index = indexAt(clientX, clientY);
    if (index === dropIndex) return;
    dropIndex = index;
    shiftTo(index);
  };

  /** Scroll the strip while the pointer rests near one of its edges. */
  const updateAutoScroll = () => {
    if (finished || !scrollContainer) {
      stopAutoScroll();
      return;
    }
    const horizontal = axis === 'x';
    const rect = scrollContainer.getBoundingClientRect();
    const overflow = horizontal
      ? scrollContainer.scrollWidth - scrollContainer.clientWidth
      : scrollContainer.scrollHeight - scrollContainer.clientHeight;
    const along = horizontal ? lastClientX : lastClientY;
    const nearStart = along - (horizontal ? rect.left : rect.top);
    const nearEnd = (horizontal ? rect.right : rect.bottom) - along;
    const scrolled = horizontal ? scrollContainer.scrollLeft : scrollContainer.scrollTop;
    const visible = horizontal ? scrollContainer.clientWidth : scrollContainer.clientHeight;
    const total = horizontal ? scrollContainer.scrollWidth : scrollContainer.scrollHeight;

    let delta = 0;
    if (overflow > SCROLL_OVERFLOW_MIN_PX) {
      if (nearStart < EDGE_HOTZONE_PX && scrolled > 0) {
        delta = -Math.ceil(MAX_SCROLL_STEP_PX * (1 - Math.max(0, nearStart) / EDGE_HOTZONE_PX));
      } else if (nearEnd < EDGE_HOTZONE_PX && scrolled + visible < total) {
        delta = Math.ceil(MAX_SCROLL_STEP_PX * (1 - Math.max(0, nearEnd) / EDGE_HOTZONE_PX));
      }
    }
    if (delta === 0) {
      autoScrollRaf = null;
      return;
    }
    if (horizontal) scrollContainer.scrollLeft += delta;
    else scrollContainer.scrollTop += delta;
    // The drop position can change when the strip moves under a pointer that
    // has not. The clone sits outside the scroll box, so it stays under the
    // pointer on its own — there is nothing to reposition here.
    recompute(lastClientX, lastClientY);
    autoScrollRaf = requestAnimationFrame(updateAutoScroll);
  };

  const maybeStartAutoScroll = () => {
    if (scrollContainer && autoScrollRaf === null) {
      autoScrollRaf = requestAnimationFrame(updateAutoScroll);
    }
  };

  const stopAutoScroll = () => {
    if (autoScrollRaf !== null) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }
  };

  /**
   * Whether the pointer has travelled far enough to mean a drag.
   * @param {number} dx - Distance moved in x.
   * @param {number} dy - Distance moved in y.
   * @returns {boolean} True once this is a drag.
   */
  const passedThreshold = (dx, dy) => {
    if (axis === 'x') return Math.abs(dx) >= thresholdPx;
    if (axis === 'y') return Math.abs(dy) >= thresholdPx;
    return Math.hypot(dx, dy) >= thresholdPx;
  };

  /** Put every trace of the drag away, leaving the strip as the caller found it. */
  const cleanUp = () => {
    stopAutoScroll();
    ghost?.remove();
    ghost = null;
    item.classList.remove(sourceClass);
    for (const el of items()) {
      el.style.transition = '';
      el.style.transform = '';
    }
    strip?.classList.remove(draggingClass);
    try {
      captureTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released, or never held — either way there is nothing to give back.
    }
  };

  /** @param {PointerEvent} move - A pointermove. */
  const onMove = (move) => {
    if (finished) return;
    // A gesture can lose its release. A native context menu, an OS window
    // switch, or a pointer that leaves the webview all swallow the pointerup,
    // and a gesture still listening for one arms itself on the next stray
    // movement — the item then follows a pointer with nothing held down, and
    // there is no release coming to put it back. A move reporting no button is
    // that gesture's proof it is over.
    if (move.buttons === 0) {
      finish(false);
      return;
    }
    const dx = move.clientX - event.clientX;
    const dy = move.clientY - event.clientY;
    if (!active) {
      if (!passedThreshold(dx, dy)) return;
      active = true;
      capturePointer();
      strip?.classList.add(draggingClass);
      createGhost();
      try {
        onDragStart?.();
      } catch (err) {
        console.error('[ReorderDrag] Drag start handler failed:', err);
      }
    }

    lastClientX = move.clientX;
    lastClientY = move.clientY;
    if (ghost) {
      const tx = axis === 'y' ? 0 : dx;
      const ty = axis === 'x' ? 0 : dy;
      ghost.style.transform = `translate(${tx}px, ${ty}px) scale(1.02)`;
    }
    recompute(move.clientX, move.clientY);
    maybeStartAutoScroll();
  };

  /**
   * End the gesture.
   * @param {boolean} commit - Whether a landing counts, or is being abandoned.
   */
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);

    const moved = active && commit && dropIndex !== fromIndex && fromIndex >= 0;
    // The strip may be showing an arrangement nobody asked for, and it has to go
    // back before anything measures it — but only when the item is genuinely
    // somewhere else. insertBefore is a remove and an insert even when the node
    // is already exactly there, and doing that on pointerup tears the element
    // out from under the click the browser is about to fire: the click never
    // arrives, and every CSS animation on the element restarts. So a press that
    // stayed a click, and a drag that wandered back into its own slot, both
    // leave the DOM strictly untouched.
    // The anchor is read at the press and the strip is not ours alone: the item
    // that followed this one can have been removed by the time the gesture is
    // abandoned, and insertBefore against a node that is no longer a child
    // throws. Everything below is the tidying up — the clone, the classes, the
    // listeners, the owner's drag flag — so a throw here would leave the strip
    // stranded mid-gesture for good. Fall back to the end of the strip, which
    // is where a home anchor that no longer exists now is.
    if (active && !moved && item.nextSibling !== homeNext) {
      const anchor = homeNext && homeNext.parentNode === homeParent ? homeNext : null;
      homeParent?.insertBefore(item, anchor);
    }
    cleanUp();

    if (moved) {
      try {
        onCommit?.({ item, fromIndex, toIndex: dropIndex });
      } catch (err) {
        console.error('[ReorderDrag] Commit handler failed:', err);
      }
    }
    try {
      onDragEnd?.({ dragged: active, moved });
    } catch (err) {
      console.error('[ReorderDrag] Drag end handler failed:', err);
    }
  };

  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onCancel);

  return {
    isActive: () => active && !finished,
    cancel: () => finish(false),
  };
}
