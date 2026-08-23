//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<model-tuning>` — the two per-model dials for ONE model: thinking level and
 * serving speed.
 *
 * Dumb and controlled. It knows a model entry (what the provider advertises) and
 * a value (what is currently chosen), renders the segmented controls for them,
 * and emits `change` with the next `{thinking, serviceTier}` pair. It never
 * writes anything, never reads a conversation, and never talks to the server —
 * every host does that itself.
 *
 * Both dials express their neutral setting as the ABSENCE of a value: `''` means
 * the model's default level / standard serving, never an empty-string level or
 * tier. The two are independent, so a `change` always carries both — a host that
 * rebuilt its config from one dial alone would silently drop the other.
 *
 * Shown in two places, identically: the picker's detail column (both dials) and
 * the chip's mini popover (`sections="thinking"`, thinking only).
 * @module components/model-picker/model-tuning
 */

import { escapeHtml } from '../../../sdk/lib/html.js';

/**
 * @typedef {object} TuningModelEntry
 * @property {string[]} [thinkingLevels] - Levels the model advertises, in display order, each named in the provider's own vocabulary; absent/empty ⇒ no thinking control.
 * @property {string} [defaultThinkingLevel] - Level used when a turn carries none (presentation only).
 * @property {{id: string, name?: string, description?: string}[]} [serviceTiers] - Non-standard serving classes, in display order; absent/empty ⇒ no speed control.
 * @typedef {{thinking?: string, serviceTier?: string}} TuningValue
 */

/**
 * Title-case a native thinking-level string for the segmented control's full
 * label (e.g. "medium" → "Medium", "xhigh" → "Xhigh"). The button chip shows the
 * raw string verbatim.
 * @param {string} level - The native level string.
 * @returns {string} The level with its first letter upper-cased.
 */
export function thinkingLabel(level) {
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : level;
}

/**
 * The tier ids a model entry advertises. Standard serving is never a member —
 * it is the absence of a tier.
 * @param {TuningModelEntry|null} [modelEntry]
 * @returns {string[]} Advertised tier ids in display order.
 */
export function tierIds(modelEntry) {
  return (modelEntry?.serviceTiers || []).map(t => t.id);
}

class ModelTuning extends HTMLElement {
  constructor() {
    super();
    /** @type {TuningModelEntry|null} @private - What the model advertises. */
    this._modelEntry = null;
    /** @type {TuningValue} @private - The chosen pair; absent keys are the neutral setting. */
    this._value = {};
    /** @type {'all'|'thinking'} @private - Which dials to offer. */
    this._sections = 'all';
    /** @type {string|null} @private - Last markup written, for the no-op guard in render(). */
    this._lastHTML = null;
  }

  connectedCallback() {
    this.render();
  }

  /** @param {TuningModelEntry|null} entry - What the model advertises. */
  set modelEntry(entry) {
    this._modelEntry = entry;
    this.render();
  }

  /** @returns {TuningModelEntry|null} What the model advertises. */
  get modelEntry() {
    return this._modelEntry;
  }

  /** @param {TuningValue|null} value - The chosen `{thinking, serviceTier}` pair. */
  set value(value) {
    this._value = value || {};
    this.render();
  }

  /** @returns {TuningValue} The chosen pair. */
  get value() {
    return this._value;
  }

  /** @param {'all'|'thinking'} sections - Which dials to offer. */
  set sections(sections) {
    this._sections = sections === 'thinking' ? 'thinking' : 'all';
    this.render();
  }

  /** @returns {'all'|'thinking'} Which dials are offered. */
  get sections() {
    return this._sections;
  }

  /** @returns {boolean} True when the model advertises nothing to tune. */
  get isEmpty() {
    const levels = this._modelEntry?.thinkingLevels || [];
    const tiers = this._sections === 'thinking' ? [] : (this._modelEntry?.serviceTiers || []);
    return levels.length === 0 && tiers.length === 0;
  }

  /**
   * The effective thinking level: an explicit level counts only when the model
   * advertises it, so a stale stored level reads as the model's default — the
   * same gate the request path applies.
   * @returns {string} The active level, or '' for the model's default.
   * @private
   */
  _activeLevel() {
    const levels = this._modelEntry?.thinkingLevels || [];
    const wanted = this._value.thinking;
    return wanted && levels.includes(wanted) ? wanted : '';
  }

  /**
   * The effective serving tier, gated the same way as the level: a tier the
   * model no longer advertises means standard serving.
   * @returns {string} The active tier id, or '' for standard serving.
   * @private
   */
  _activeTier() {
    const wanted = this._value.serviceTier;
    return wanted && tierIds(this._modelEntry).includes(wanted) ? wanted : '';
  }

  /**
   * Segmented control for the thinking level, rendered only when the model
   * advertises `thinkingLevels`. "Default" (no explicit level) is always offered
   * first and, when picked, means the absence of a level; the advertised levels
   * follow in the provider's declared order, each shown by its native name.
   * @returns {string} HTML, or '' when the model exposes no thinking control.
   * @private
   */
  _thinkingControlHTML() {
    const levels = this._modelEntry?.thinkingLevels || [];
    if (levels.length === 0) return '';

    const active = this._activeLevel();
    const def = this._modelEntry?.defaultThinkingLevel;
    const defaultLabel = def ? `Default (${thinkingLabel(def)})` : 'Default';

    const seg = (/** @type {string} */ level, /** @type {string} */ label) => {
      const isActive = level === active;
      return `<button type="button" class="thinking-seg${isActive ? ' active' : ''}" data-thinking-level="${escapeHtml(level)}" role="radio" aria-checked="${isActive}">${escapeHtml(label)}</button>`;
    };

    // Advertised order, shown verbatim (title-cased) — the provider owns the set.
    const segments = [seg('', defaultLabel), ...levels.map(l => seg(l, thinkingLabel(l)))];

    return `
            <div class="model-thinking">
                <div class="model-thinking-label">Thinking</div>
                <div class="thinking-segmented" role="radiogroup" aria-label="Thinking level">${segments.join('')}</div>
            </div>`;
  }

  /**
   * Segmented control for the serving class, rendered only when the model
   * advertises `serviceTiers`. "Standard" (no explicit tier) is always offered
   * first; the advertised tiers follow in the provider's declared order, each
   * shown by the provider's own name and blurb — a tier costs materially more,
   * so the description it is sold with is the honest label for it.
   * @returns {string} HTML, or '' when the model exposes no speed control.
   * @private
   */
  _speedControlHTML() {
    const tiers = this._modelEntry?.serviceTiers || [];
    if (tiers.length === 0) return '';

    const active = this._activeTier();

    const seg = (/** @type {string} */ id, /** @type {string} */ label, /** @type {string} */ title) => {
      const isActive = id === active;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<button type="button" class="tier-seg${isActive ? ' active' : ''}" data-service-tier="${escapeHtml(id)}" role="radio" aria-checked="${isActive}"${titleAttr}>${escapeHtml(label)}</button>`;
    };

    const segments = [
      seg('', 'Standard', ''),
      ...tiers.map(t => seg(t.id, t.name || t.id, t.description || '')),
    ];

    return `
            <div class="model-speed">
                <div class="model-speed-label">Speed</div>
                <div class="tier-segmented" role="radiogroup" aria-label="Serving speed">${segments.join('')}</div>
            </div>`;
  }

  /**
   * Announce the next pair. Both dials ride along on every emit: they share one
   * stored config, so a host rebuilding it from one dial alone would drop the
   * other — silently reverting a choice the user is paying a premium for.
   * @param {{thinking: string, serviceTier: string}} detail - The next pair.
   * @private
   */
  _emit(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail, bubbles: true, composed: true }));
  }

  render() {
    const html = this._thinkingControlHTML()
      + (this._sections === 'thinking' ? '' : this._speedControlHTML());
    // Skip an identical rewrite: the picker re-renders on every provider push,
    // and replacing the segments would drop the pressed button out from under a
    // click already in flight.
    if (html === this._lastHTML) return;
    this._lastHTML = html;
    this.innerHTML = html;
    if (!html) return;

    this.querySelectorAll('.thinking-seg').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        e.stopPropagation();
        this._emit({
          thinking: seg.getAttribute('data-thinking-level') || '',
          serviceTier: this._activeTier(),
        });
      });
    });

    this.querySelectorAll('.tier-seg').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        e.stopPropagation();
        this._emit({
          thinking: this._activeLevel(),
          serviceTier: seg.getAttribute('data-service-tier') || '',
        });
      });
    });
  }
}

customElements.define('model-tuning', ModelTuning);

export default ModelTuning;
