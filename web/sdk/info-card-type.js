//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Info-card manifest — static metadata that describes an info-card plugin.
 * Define this as a static MANIFEST property on your card class.
 * @typedef {object} InfoCardManifest
 * @property {string} id - Unique card identifier (kebab-case, e.g. 'git-status')
 * @property {string} name - Human-readable display name (shown in the catalog and the info-cards menu)
 * @property {string} version - Semantic version (e.g. '1.0.0')
 * @property {string} description - Help text shown in the extensions catalog
 * @property {string} eyebrow - Small-caps label shown in the card header
 * @property {number} [priority] - Stacking order in the sidebar rail: cards stack
 *   highest-priority first and the lowest-priority ones are dropped first when the
 *   column runs out of room. Defaults to 0.
 */

// ============================================================================
// InfoCardType Base Class
// ============================================================================

/**
 * InfoCardType — base class for Juggler "info card" plugins.
 *
 * Info cards are the ambient tiles parked in the empty sidebar space above the
 * Bin (Tips, Usage, Git status, …). Each card fills a content region the host
 * chrome (eyebrow label + × close) wraps around. Cards are **viewer-only** — they
 * touch the DOM and never run in the engine worker, so unlike strategy/
 * context-item/command there is no `-worker.js` twin of this base class.
 *
 * ## Creating a card
 *
 * Cards ship inside an **extension** (a directory with a `juggler.extension.json`
 * manifest). Add a file named `*-card.js` under the extension's `cards/`
 * directory — the manifest's `provides.infoCards` glob registers it
 * automatically.
 *
 * 1. Import and extend InfoCardType: `import InfoCardType from 'juggler/info-card-type';`
 * 2. Define a static MANIFEST with the required fields (id, name, version,
 *    description, eyebrow).
 * 3. Implement `mount(contentEl, session)`; optionally override `hasContent()`
 *    and `onEnabled()`.
 *
 * ```javascript
 * import InfoCardType from 'juggler/info-card-type';
 *
 * export default class MyCard extends InfoCardType {
 *   static MANIFEST = {
 *     id: 'my-card',
 *     name: 'My Card',
 *     version: '1.0.0',
 *     description: 'Shows something useful in the sidebar',
 *     eyebrow: 'My Card',
 *     priority: 10,
 *   };
 *
 *   mount(contentEl) {
 *     contentEl.textContent = 'Hello';
 *     return () => {}; // teardown
 *   }
 * }
 * ```
 * @class
 * @abstract
 */
class InfoCardType {
  /**
   * Info-card manifest (static property set by subclasses).
   * @type {InfoCardManifest}
   * @static
   */
  static MANIFEST;

  constructor() {
    if (new.target === InfoCardType) {
      throw new Error('InfoCardType is an abstract class and cannot be instantiated directly');
    }
  }

  /** @returns {InfoCardManifest} This card's manifest. */
  getManifest() {
    return /** @type {typeof InfoCardType} */ (this.constructor).MANIFEST;
  }

  /** @returns {string} The card id (from MANIFEST). */
  get id() {
    return this.getManifest().id;
  }

  /** @returns {string} The card display name (from MANIFEST). */
  get name() {
    return this.getManifest().name;
  }

  /** @returns {string} The card-header eyebrow label (from MANIFEST). */
  get eyebrow() {
    return this.getManifest().eyebrow;
  }

  /** @returns {number} The rail stacking priority (from MANIFEST, default 0). */
  get priority() {
    return this.getManifest().priority ?? 0;
  }

  /**
   * Whether the card has anything to show right now. Override to drop the card
   * from the rail when it has no content (the Tips card does this once every tip
   * is seen). Defaults to always-renderable.
   * @returns {boolean} True if the card should be mounted.
   */
  hasContent() {
    return true;
  }

  /**
   * Hook run when the card transitions from hidden to shown (the user un-hides it
   * from the info-cards menu). Optional — the Tips card uses it to replay its
   * tips. Default is a no-op.
   * @returns {void}
   */
  onEnabled() {}

  /**
   * Fill the card's content region. Return a teardown function to stop any timers
   * or listeners when the card is removed (a rail resize, a hide, teardown).
   * @abstract
   * @param {HTMLElement} contentEl - The content region to populate.
   * @param {import('../js/model/session.js').default} [session] - The owning conversation session.
   * @returns {(() => void)|void} Optional teardown.
   */
  mount(contentEl, session) {
    void contentEl;
    void session;
    throw new Error('mount() must be implemented by subclass');
  }
}

export default InfoCardType;
