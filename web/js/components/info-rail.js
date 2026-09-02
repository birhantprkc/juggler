//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <info-rail> — the ambient stack of "info cards" parked in the empty sidebar
 * space just above the Bin (Tips, Git status, …). Each card gets the same chrome:
 * an eyebrow label, a × that hides it (bring it back from the info-cards menu the
 * rail heads the stack with), and a content region the card fills itself. The
 * gate-1 enabled card instances are supplied by
 * {@link module:services/info-cards-manager}; the cards themselves are plugins of
 * the `@juggler/core` extension.
 *
 * The rail also hosts the {@link module:components/info-cards-button|"i" menu} as
 * the first child of its stack, so the control rides immediately above the cards
 * it manages. It is a rail child rather than a sibling because the rail is the
 * flex:1 child: anything placed beside it would be stranded at the top of the free
 * space instead of resting with the bottom-aligned cards.
 *
 * CSS makes this rail the flex child that grows into whatever the tab list doesn't
 * use (`flex: 1 1 0`), so the rail's own height IS the free space — no sibling
 * geometry. The list is capped at a share of the column while the rail has cards to
 * put there, and takes the whole column when it hasn't; the rail publishes which of
 * those it is as the `data-has-cards` attribute CSS keys off. Cards stack
 * top-priority-first, and below the first one they are shown *whole or not at all*:
 * any that don't fully fit are dropped from the tail. The first card is the
 * exception — rather than leave a card-sized hole above the Bin, it is kept and
 * allowed to run off the rail's top edge, faded, while enough of it stays visible to
 * be worth reading. A single ResizeObserver watches the rail (for the
 * leftover space: list grows/shrinks, sidebar/window resize) and every mounted card
 * (for content that grows after it was measured), and reconciles synchronously —
 * the observer runs after layout but before paint, so a shrink never paints a
 * half-clipped card. Surviving cards are reused across reconciles, so tip rotation
 * isn't reset as the sidebar resizes.
 *
 * Nothing polls the rail. A dropped card is torn down, so a periodic re-fit would
 * rebuild — and remount, and refetch — every card that doesn't fit, once per tick.
 *
 * Not an ARIA live region — rotating tip text would spam a screen reader.
 * @module components/info-rail
 */

import { providers, isHidden, hideCard, INFO_CARDS_CHANGED_EVENT } from '../services/info-cards-manager.js';
import { TIPS_CHANGED_EVENT } from '../services/tips-manager.js';
import './info-cards-button.js';
import JugglerElement from './juggler-element.js';

/**
 * How much of the top card has to stay visible, in rem, for showing it clipped to
 * beat showing nothing. Twice the fade the CSS signs the cut with
 * (`--info-card-fade`), so there is always as much solid card as faded card —
 * below that the whole thing is fade and reads as a rendering fault. Under this,
 * the rail is visibly just its "i" row and no space looks unaccounted for.
 * @type {number}
 */
const MIN_CLIPPED_REVEAL_REM = 3;

/**
 * The runtime shape of a mounted card — an {@link import('juggler/info-card-type').default}
 * instance. Cards expose their manifest metadata as instance getters (id, name,
 * eyebrow) alongside the lifecycle methods.
 * @typedef {import('juggler/info-card-type').default} InfoCardProvider
 */

class InfoRail extends JugglerElement {
  constructor() {
    super();
    /**
     * The cards currently in the DOM, in priority order (top → bottom).
     * @type {Array<{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}>}
     * @private
     */
    this._mounted = [];
    /** @type {boolean} @private Reentrancy guard: a reconcile must not nest. */
    this._reconciling = false;
    /** @type {import('../model/session.js').default|undefined} @private */
    this._session = undefined;
    /** @type {HTMLElement|null} @private The "i" menu heading the stack. */
    this._cardsButton = null;
    /**
     * Watches the rail's box (the free space) and every mounted card's box
     * (content that grows after it was measured). The sole re-fit trigger.
     * @type {ResizeObserver|null} @private
     */
    this._resizeObserver = null;
  }

  connectedCallback() {
    // The "i" menu leads the stack, so it sits immediately above the topmost card
    // (and just above the Bin when no card is showing). Appended before any card,
    // and cards only ever append after it, so it stays first.
    if (!this._cardsButton) {
      this._cardsButton = document.createElement('info-cards-button');
      this.appendChild(this._cardsButton);
    }

    this.onWindow(INFO_CARDS_CHANGED_EVENT, () => this._reconcile());
    this.onWindow(TIPS_CHANGED_EVENT, () => this._reconcile());

    // The rail's own height IS the free space (CSS flex: 1 1 0). Observe it and
    // reconcile SYNCHRONOUSLY: a ResizeObserver callback runs after layout but
    // before paint, so dropping a card that no longer fits here means the clipped
    // frame is never painted. This observer is the ONLY thing that drives a
    // re-fit, and it covers every way the fit can change: the rail's own box for
    // the leftover space (the tab list growing/shrinking, the sidebar drag, the
    // window resizing), and each mounted card's box for content that grows after
    // it was measured. Nothing polls the rail — a periodic re-fit would tear down
    // and rebuild every card that doesn't fit, once per tick (see _reconcile).
    //
    // Our own add/remove doesn't change the rail's height (overflow-hidden,
    // flex-basis 0), so it can't feed back into a loop; a dropped card is
    // unobserved before it leaves the DOM, so its removal queues no callback.
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._reconcile());
      this._resizeObserver.observe(this);
      this.addCleanup(() => {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
      });
    }
    this._reconcile();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._teardownAll();
  }

  /**
   * Supply the owning conversation session to newly mounted card providers.
   * @param {import('../model/session.js').default} session
   * @returns {void}
   */
  setSession(session) {
    if (this._session === session) return;
    this._session = session;
    this._teardownAll();
    this._reconcile();
  }

  /** @private */
  _teardownAll() {
    for (const entry of this._mounted) this._teardownEntry(entry);
    this._mounted = [];
  }

  /**
   * Tear down one card entry: stop its content, remove it from the DOM.
   * Unobserved BEFORE it leaves the DOM, so the removal doesn't queue a resize
   * callback that would reconcile again and rebuild the card we just dropped.
   * @param {{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}} entry
   * @private
   */
  _teardownEntry(entry) {
    this._resizeObserver?.unobserve(entry.card);
    try { entry.teardown(); } catch { /* card cleanup is best-effort */ }
    entry.card.remove();
  }

  /**
   * How many of the currently-mounted cards, taken from the top (highest priority),
   * fully fit the rail's content box — summing each card's own offsetHeight plus the
   * inter-card gap. offsetHeight is a card's true rendered height even while the
   * parent is clipping it, so this is engine-independent (unlike scrollHeight, which
   * ignores the top-edge overflow our bottom-aligned stack produces). The "i" menu
   * shares the stack, so its own height (and the gap below it) comes off the budget
   * first — it is never the thing that gets dropped.
   *
   * When not even the first card fits, it is kept anyway and left to overflow,
   * provided {@link MIN_CLIPPED_REVEAL_REM} of the rail is there to show it in. The
   * stack is bottom-aligned, so what overflows leaves past the rail's TOP edge and
   * the card keeps the end its content builds towards. Dropping it instead is what
   * leaves a card-sized hole above the Bin that reads as a card failing to render.
   * @returns {{count: number, clipped: boolean}} How many leading cards to keep, and
   *   whether the topmost of them overflows the rail.
   * @private
   */
  _fitCount() {
    const cs = getComputedStyle(this);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gap = parseFloat(cs.rowGap) || 0;
    const buttonHeight = this._cardsButton ? this._cardsButton.offsetHeight : 0;
    const available = this.clientHeight - padY - (buttonHeight > 0 ? buttonHeight + gap : 0);
    let used = 0;
    let count = 0;
    for (const entry of this._mounted) {
      const next = used + (count === 0 ? 0 : gap) + entry.card.offsetHeight;
      if (next > available + 1) break;
      used = next;
      count += 1;
    }
    if (count === 0 && this._mounted.length > 0) {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      if (available >= MIN_CLIPPED_REVEAL_REM * remPx) return { count: 1, clipped: true };
    }
    // Anything kept by the loop fits whole, so only the forced card is ever clipped.
    return { count, clipped: false };
  }

  /**
   * Show the enabled, has-content cards top-priority-first, and only those that
   * FULLY fit the rail's height — a card is shown whole or not at all, never
   * clipped. Surviving cards are reused (so tip rotation isn't reset as the sidebar
   * resizes); only the lowest-priority cards that no longer fit are removed. Run
   * synchronously from the ResizeObserver so a shrink never paints a clipped card.
   * @private
   */
  _reconcile() {
    if (!this.isConnected || this._reconciling) return;
    this._reconciling = true;
    try {
      // Never intrude during automated UI tests (matches the old tip-rail).
      if (/** @type {any} */ (window).JUGGLER_TEST_MODE) {
        this._teardownAll();
        this.removeAttribute('data-has-cards');
        this.removeAttribute('data-clipped');
        this.hidden = true;
        return;
      }
      if (this.hidden) this.hidden = false;

      const eligible = providers().filter(
        (p) => !isHidden(p.id) && (typeof p.hasContent !== 'function' || p.hasContent()),
      );

      // Tell CSS whether there is anything worth reserving column space for: with
      // cards to show, the tab list is capped and scrolls rather than squeezing the
      // rail down to its "i" row; with every card hidden or empty, the cap lifts and
      // the list takes the whole column. The signal is what is ELIGIBLE, never how
      // many are mounted — mounting depends on the space the cap creates, so keying
      // on the mounted count would feed itself. Eligibility is decided upstream of
      // layout, so the attribute settles in one pass. toggleAttribute is a no-op
      // when the value already matches, which matters: this runs on every doc change
      // while a turn streams, and a redundant write would invalidate styles ~100
      // times a second.
      this.toggleAttribute('data-has-cards', eligible.length > 0);

      // Reconcile the mounted set to the eligible providers, in priority order,
      // reusing existing cards so their state (tip rotation) survives.
      const existing = new Map(this._mounted.map((e) => [e.provider.id, e]));
      /** @type {Array<{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}>} */
      const next = [];
      // Walk the stack placing each card after the "i" menu in priority order,
      // but move ONLY the cards genuinely out of position — the same rule the
      // conversation bar's tab reorder follows. Re-inserting a connected node is
      // a remove+insert: it restarts the card's CSS animations, and a card that
      // moves between a click's mousedown and mouseup swallows that click. This
      // reconciles on every doc change while a turn streams, so an unconditional
      // re-append would churn the whole stack ~100 times a second.
      let expected = this._cardsButton ? this._cardsButton.nextSibling : this.firstChild;
      for (const provider of eligible) {
        let entry = existing.get(provider.id);
        if (entry) {
          existing.delete(provider.id);
        } else {
          const built = this._buildCard(provider);
          entry = { provider, card: built.card, teardown: built.teardown };
          // Watch the new card so content that grows past the space it was
          // measured into triggers a re-fit rather than being clipped.
          this._resizeObserver?.observe(entry.card);
        }
        if (entry.card !== expected) {
          this.insertBefore(entry.card, expected);
        }
        expected = entry.card.nextSibling;
        next.push(entry);
      }
      for (const stale of existing.values()) this._teardownEntry(stale);
      this._mounted = next;

      // Keep only the top cards that fully fit, and drop the rest from the tail
      // (the lower-priority ones). Measured by summing each card's own offsetHeight
      // rather than reading scrollHeight: with the stack bottom-aligned it overflows
      // the *top* edge, and scrollHeight doesn't count start-edge overflow in every
      // engine (Chrome reports none) — so scrollHeight would silently miss the clip.
      const { count: fit, clipped } = this._fitCount();
      while (this._mounted.length > fit) {
        const dropped = this._mounted.pop();
        if (dropped) this._teardownEntry(dropped);
      }
      // Let CSS fade the top card's cut edge. Safe to set from here: a mask paints,
      // it doesn't lay out, so it can't resize the rail back into this observer.
      this.toggleAttribute('data-clipped', clipped);
      // Left intentionally present even when empty: as the flex:1 child it holds
      // the Bin at the bottom of the column, just as the tabs menu used to.
    } finally {
      this._reconciling = false;
    }
  }

  /**
   * Build one card: shared chrome (eyebrow + × close) around the provider's
   * content region.
   * @param {InfoCardProvider} provider
   * @returns {{card: HTMLElement, teardown: () => void}} The card element and its
   *   content teardown.
   * @private
   */
  _buildCard(provider) {
    const card = document.createElement('div');
    card.className = 'info-card';
    card.setAttribute('role', 'note');
    card.dataset.cardId = provider.id;

    const header = document.createElement('div');
    header.className = 'info-card__header';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'info-card__eyebrow';
    eyebrow.textContent = provider.eyebrow;
    header.appendChild(eyebrow);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'info-card__close';
    close.setAttribute('aria-label', `Hide ${provider.name}`);
    close.title = `Hide ${provider.name}`;
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); hideCard(provider.id); });
    header.appendChild(close);

    card.appendChild(header);

    const content = document.createElement('div');
    content.className = 'info-card__content';
    card.appendChild(content);

    let cleanup;
    try {
      cleanup = provider.mount(content, this._session);
    } catch {
      cleanup = undefined;
    }
    const teardown = typeof cleanup === 'function' ? cleanup : () => {};
    return { card, teardown };
  }
}

customElements.define('info-rail', InfoRail);

export default InfoRail;
