//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { formatTokens as fmtTokens } from '../utils/format.js';

/** Uncached delta above this earns the `cache-warn` treatment (tokens). */
const UNCACHED_WARN_TOKENS = 5000;

/** Fullness above which the pill carries a plain-language note (percent). */
const NEARLY_FULL_PCT = 95;

/**
 * Footer token-status pill. Numbers come from transaction blobs; input usage
 * may be provider-reported or an explicitly marked fallback estimate. There is
 * no client-side estimator. State is a pure function of (total, cached, budget,
 * processing, approximate).
 *
 * UX rules:
 *   1. Count text is always neutral grey. The number is data, not a status.
 *   2. The bar + denominator render only when budget is known. Half-states
 *      (empty track, "?", etc.) just confuse — show the count, omit the meter.
 *   3. Bar fill colour escalates: <60% grey, 60-80% amber, >80% red.
 *      No "green at low usage" — quiet is correct for a 5%-full meter.
 *   4. Cache-warn is localised to the `+Nk new` segment, not the total.
 *   5. While `processing` is true, the cached portion is suppressed — the
 *      anchor is from the previous turn and can transiently disagree with
 *      the in-flight Yjs state.
 *   6. A null (or absent) `cached` means the provider reported no cache usage
 *      for the turn: unknown, not zero. Unknown draws nothing — no cached
 *      parenthetical, no `+Nk new`, no cache-warn, no cached bar segment —
 *      and says so in the tooltip. A reported 0 is a real miss and warns.
 * @typedef {object} TokenUsage
 * @property {number} total - Total input tokens for the most recent turn
 * @property {number|null} [cached] - Cached portion of `total`; null or absent when the provider reported no cache usage
 * @property {number} [budget] - Context window (0/undefined = unknown)
 * @property {boolean} [processing] - True while a turn is streaming
 * @property {boolean} [approximate] - Input total is a local fallback estimate
 */
class TokenDisplay extends HTMLElement {
  constructor() {
    super();
    /** @type {number}  @private */ this.total = 0;
    /** @type {number|null} @private */ this.cached = null;
    /** @type {number}  @private */ this.budget = 0;
    /** @type {boolean} @private */ this.processing = false;
    /** @type {boolean} @private */ this.approximate = false;
    /** @type {boolean} @private */ this._hasData = false;
  }

  connectedCallback() { this.render(); }

  /**
   * Set the full usage payload and re-render if anything changed.
   * @param {TokenUsage} usage
   */
  setUsage(usage) {
    const total = Math.max(0, Number(usage.total) || 0);
    // Null or absent is the provider declining to report cache usage: it is
    // carried through as null so nothing downstream reads it as a miss. A
    // reported number — including 0 — stays a number.
    const cached = usage.cached === null || usage.cached === undefined
      ? null
      : Math.max(0, Math.min(total, Number(usage.cached) || 0));
    const budget = Math.max(0, Number(usage.budget) || 0);
    const processing = !!usage.processing;
    const approximate = !!usage.approximate;
    const hasData = total > 0;
    if (this.total === total && this.cached === cached &&
              this.budget === budget && this.processing === processing &&
              this.approximate === approximate && this._hasData === hasData) return;
    this.total = total;
    this.cached = cached;
    this.budget = budget;
    this.processing = processing;
    this.approximate = approximate;
    this._hasData = hasData;
    this.render();
  }

  /** Clear all state and hide the element. */
  clear() {
    this.setUsage({ total: 0, cached: null, budget: 0, processing: false });
  }

  render() {
    if (!this._hasData) {
      this.innerHTML = '';
      this.classList.remove('token-medium', 'token-high', 'cache-warn');
      this.removeAttribute('title');
      return;
    }

    // The cached count the render works from: null wherever there is nothing
    // trustworthy to say about the cache, whether because the provider did not
    // report it or because a turn is in flight (rule 5). Every cache-derived
    // figure below is guarded on it, so unknown states the total and stops.
    const cached = this.processing ? null : this.cached;

    const hasBudget = this.budget > 0;
    const totalPct = hasBudget ? Math.min(100, (this.total / this.budget) * 100) : 0;
    const cachedPct = (!hasBudget || cached === null) ? 0
      : Math.min(totalPct, (cached / this.budget) * 100);
    const usedPct = Math.max(0, totalPct - cachedPct);

    this.classList.remove('token-medium', 'token-high');
    if (hasBudget) {
      if (totalPct > 80) this.classList.add('token-high');
      else if (totalPct > 60) this.classList.add('token-medium');
    }

    const uncached = cached === null ? 0 : Math.max(0, this.total - cached);
    const warn = uncached > UNCACHED_WARN_TOKENS;
    this.classList.toggle('cache-warn', warn);

    let leftText = `${this.approximate ? '~' : ''}${fmtTokens(this.total)}`;
    if (cached !== null && cached > 0) {
      const newPart = warn ? ` · <span class="token-new">+${fmtTokens(uncached)} new</span>` : '';
      leftText += ` <span class="token-cached">(${fmtTokens(cached)} cached${newPart})</span>`;
    }

    const meterHTML = hasBudget
      ? `<div class="token-bar"><div class="token-fill-cached" style="width: ${cachedPct}%;"></div><div class="token-fill" style="width: ${usedPct}%;"></div></div><span class="token-text token-denominator">/ ${fmtTokens(this.budget)}</span>`
      : '';

    // Rule 1 keeps the visible count neutral, so a nearly-full window says so
    // in the tooltip rather than in the pill itself. The tooltip is also where
    // an unreported cache figure is accounted for: the pill states the total
    // and leaves the cache out, and the tooltip says why it is missing.
    if (hasBudget && totalPct >= NEARLY_FULL_PCT) {
      this.title = `${Math.round(totalPct)}% full. Something’s got to give.`;
    } else if (!this.processing && this.cached === null) {
      this.title = 'Cache use not reported for this turn.';
    } else {
      this.removeAttribute('title');
    }

    this.innerHTML = `<span class="token-text">${leftText}</span>${meterHTML}`;
  }
}

customElements.define('token-display', TokenDisplay);
