//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <info-rail> — the ambient stack of "info cards" parked in the empty sidebar
 * space just above the Bin (Tips, Git status, …). Each card gets the same chrome:
 * an eyebrow label, a × that hides it (re-enable in Settings › Info cards), and a
 * content region the card fills itself. Cards are supplied as providers by
 * {@link module:services/info-cards-manager}; their content lives in
 * `components/cards/`.
 *
 * The conversation tabs always win the column. CSS makes this rail the flex child
 * that grows into whatever the list doesn't use (`flex: 1 1 0`), so the rail's own
 * height IS the free space — no sibling geometry. Cards stack top-priority-first,
 * and a card is shown *whole or not at all*: any that don't fully fit are dropped
 * from the tail (never clipped). A single ResizeObserver on the rail catches every
 * way the leftover changes (list grows/shrinks, sidebar/window resize) and
 * reconciles synchronously — the observer runs after layout but before paint, so a
 * shrink never paints a half-clipped card. Surviving cards are reused across
 * reconciles, so tip rotation isn't reset as the sidebar resizes.
 *
 * Not an ARIA live region — rotating tip text would spam a screen reader.
 * @module components/info-rail
 */

import { providers, isCardEnabled, setCardEnabled, INFO_CARDS_CHANGED_EVENT } from '../services/info-cards-manager.js';
import { TIPS_CHANGED_EVENT } from '../services/tips-manager.js';

/**
 * @typedef {object} InfoCardProvider
 * @property {string} id - Stable id; also the enabled-state key.
 * @property {string} eyebrow - Small-caps label shown in the card header.
 * @property {string} settingsLabel - Toggle label on the Settings page.
 * @property {string} settingsDescription - Toggle description on the Settings page.
 * @property {boolean} defaultEnabled - Whether the card is on before the user chooses.
 * @property {() => boolean} [hasContent] - Whether the card has anything to show
 *   right now (omit to always show).
 * @property {() => void} [onEnabled] - Optional hook run when the card transitions
 *   from disabled to enabled (the Tips card replays its tips here).
 * @property {(contentEl: HTMLElement) => (() => void)|void} mount - Fill the
 *   content region; return a teardown to stop any timers/listeners.
 */

class InfoRail extends HTMLElement {
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
    /** @type {ResizeObserver|null} @private */
    this._resizeObserver = null;
    /** @type {(() => void)|null} @private Content/enabled-state change listener. */
    this._onChange = null;
  }

  connectedCallback() {
    this._onChange = () => this._reconcile();
    window.addEventListener(INFO_CARDS_CHANGED_EVENT, this._onChange);
    window.addEventListener(TIPS_CHANGED_EVENT, this._onChange);

    // The rail's own height IS the free space (CSS flex: 1 1 0). Observe it and
    // reconcile SYNCHRONOUSLY: a ResizeObserver callback runs after layout but
    // before paint, so dropping a card that no longer fits here means the clipped
    // frame is never painted. This one observer covers every way the leftover
    // changes — the list growing/shrinking, the sidebar drag, the window resizing.
    // Our own add/remove doesn't change the rail's height (overflow-hidden,
    // flex-basis 0), so it can't feed back into a loop.
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._reconcile());
      this._resizeObserver.observe(this);
    }
    this._reconcile();
  }

  disconnectedCallback() {
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._onChange) {
      window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onChange);
      window.removeEventListener(TIPS_CHANGED_EVENT, this._onChange);
      this._onChange = null;
    }
    this._teardownAll();
  }

  /**
   * Re-evaluate which cards fit. Called by conversation-bar after it lays out the
   * tabs, so the rail's height reflects the real leftover space.
   * @returns {void}
   */
  update() {
    this._reconcile();
  }

  /** @private */
  _teardownAll() {
    for (const entry of this._mounted) this._teardownEntry(entry);
    this._mounted = [];
  }

  /**
   * Tear down one card entry: stop its content, remove it from the DOM.
   * @param {{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}} entry
   * @private
   */
  _teardownEntry(entry) {
    try { entry.teardown(); } catch { /* card cleanup is best-effort */ }
    entry.card.remove();
  }

  /**
   * How many of the currently-mounted cards, taken from the top (highest priority),
   * fully fit the rail's content box — summing each card's own offsetHeight plus the
   * inter-card gap. offsetHeight is a card's true rendered height even while the
   * parent is clipping it, so this is engine-independent (unlike scrollHeight, which
   * ignores the top-edge overflow our bottom-aligned stack produces).
   * @returns {number} The count of leading cards that fit.
   * @private
   */
  _fitCount() {
    const cs = getComputedStyle(this);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gap = parseFloat(cs.rowGap) || 0;
    const available = this.clientHeight - padY;
    let used = 0;
    let count = 0;
    for (const entry of this._mounted) {
      const next = used + (count === 0 ? 0 : gap) + entry.card.offsetHeight;
      if (next > available + 1) break;
      used = next;
      count += 1;
    }
    return count;
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
        this.hidden = true;
        return;
      }
      if (this.hidden) this.hidden = false;

      const eligible = providers().filter(
        (p) => isCardEnabled(p.id) && (typeof p.hasContent !== 'function' || p.hasContent()),
      );

      // Reconcile the mounted set to the eligible providers, in priority order,
      // reusing existing cards so their state (tip rotation) survives.
      const existing = new Map(this._mounted.map((e) => [e.provider.id, e]));
      /** @type {Array<{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}>} */
      const next = [];
      for (const provider of eligible) {
        let entry = existing.get(provider.id);
        if (entry) {
          existing.delete(provider.id);
        } else {
          const built = this._buildCard(provider);
          entry = { provider, card: built.card, teardown: built.teardown };
        }
        this.appendChild(entry.card); // re-append keeps DOM order == priority order
        next.push(entry);
      }
      for (const stale of existing.values()) this._teardownEntry(stale);
      this._mounted = next;

      // Keep only the top cards that fully fit, and drop the rest from the tail
      // (the lower-priority ones). Measured by summing each card's own offsetHeight
      // rather than reading scrollHeight: with the stack bottom-aligned it overflows
      // the *top* edge, and scrollHeight doesn't count start-edge overflow in every
      // engine (Chrome reports none) — so scrollHeight would silently miss the clip.
      const fit = this._fitCount();
      while (this._mounted.length > fit) {
        const dropped = this._mounted.pop();
        if (dropped) this._teardownEntry(dropped);
      }
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
    close.setAttribute('aria-label', `Hide ${provider.settingsLabel}`);
    close.title = `Hide ${provider.settingsLabel}`;
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); setCardEnabled(provider.id, false); });
    header.appendChild(close);

    card.appendChild(header);

    const content = document.createElement('div');
    content.className = 'info-card__content';
    card.appendChild(content);

    let cleanup;
    try {
      cleanup = provider.mount(content);
    } catch {
      cleanup = undefined;
    }
    const teardown = typeof cleanup === 'function' ? cleanup : () => {};
    return { card, teardown };
  }
}

customElements.define('info-rail', InfoRail);

export default InfoRail;
