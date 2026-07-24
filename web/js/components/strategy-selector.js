//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import strategyRegistry from '../registries/strategy-registry.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import { presentPopup } from '../utils/popup-surface.js';
import { DROPDOWN_ARROW_SVG } from '../utils/icons.js';

/**
 * Strategy Selector - Dropdown component for selecting conversation strategy
 * @typedef {object} StrategyManifestInfo
 * @property {string} id - Strategy ID
 * @property {import('juggler/strategy-type').StrategyManifest} manifest - Strategy manifest
 */

class StrategySelector extends HTMLElement {
  constructor() {
    super();
    /** @type {import('../model/message-thread.js').default|null} @private */
    this._messageThread = null;
    /** @type {string} @private */
    this._currentStrategyId = 'default';
    /**
     * True while a hold-to-cycle gesture is in progress: each hop updates the
     * visible selection (local id + in-place render) but its `setStrategy` doc
     * write — the value the engine and any running turn read — is buffered until
     * commit. See `beginCycle`.
     * @type {boolean} @private
     */
    this._deferWrites = false;
    /** @type {boolean} @private - Whether the deferred gesture applied at least one hop worth flushing. */
    this._deferDirty = false;
    /** @type {StrategyManifestInfo[]} @private */
    this._strategies = [];
    /** @type {boolean} @private */
    this._dropdownOpen = false;
    /** @type {(() => void)|null} @private - presentPopup release for the open dropdown. */
    this._popupRelease = null;
    /**
     * This selector's own dropdown while open (relocated to <body>), else null.
     * Instance-scoped so render() never finds a sibling's surface: multiple
     * selectors coexist (root + each open sub-thread column).
     * @type {HTMLElement|null} @private
     */
    this._liveDropdown = null;
    /** @type {(() => void)|null} @private */
    this._boundRegistriesReloaded = null;
  }

  connectedCallback() {
    this.loadStrategies();
    this.render();
    this.setupListeners();
  }

  disconnectedCallback() {
    if (this._boundRegistriesReloaded) {
      document.removeEventListener(REGISTRIES_RELOADED, this._boundRegistriesReloaded);
      this._boundRegistriesReloaded = null;
    }
    // Tear down the open dropdown (surface, scrim, observer, dismissal wiring).
    if (this._popupRelease) {
      this._popupRelease();
      this._popupRelease = null;
    }
    this._liveDropdown = null;
  }

  /**
   * Load strategies from registry
   * @private
   */
  loadStrategies() {
    this._strategies = strategyRegistry.getAllManifests();
  }

  /**
   * Set the message thread this strategy selector is bound to
   * @param {import('../model/message-thread.js').default|null} messageThread
   */
  setMessageThread(messageThread) {
    this._messageThread = messageThread;
    if (messageThread) {
      this._currentStrategyId = messageThread.currentStrategyId || 'default';
    } else {
      this._currentStrategyId = 'default';
    }
    this.render();
  }

  /** @private */
  setupListeners() {
    // Refresh the menu when strategies are enabled/disabled (catalog toggle
    // or plugin hot reload). The registry is the source of truth; reload from
    // it and re-render so the dropdown reflects the new set of strategies.
    this._boundRegistriesReloaded = () => {
      this.loadStrategies();
      this.render();
    };
    document.addEventListener(REGISTRIES_RELOADED, this._boundRegistriesReloaded);
  }

  /** @private */
  toggleDropdown() {
    if (this._dropdownOpen) {
      this.closeDropdown();
      return;
    }
    this._dropdownOpen = true;
    this.render();

    // presentPopup owns body-append, dismissal wiring, the reposition observer
    // (which also re-anchors on the in-place content refresh in render()), and
    // the anchored-vs-sheet decision.
    requestAnimationFrame(() => {
      const dropdown = /** @type {HTMLElement|null} */(this.querySelector('.strategy-dropdown'));
      const button = /** @type {HTMLElement|null} */(this.querySelector('.strategy-selector-button'));
      if (!dropdown || !button) return;
      dropdown.setAttribute('data-strategy-selector', 'true');
      this._liveDropdown = dropdown;
      this._popupRelease = presentPopup({
        surface: dropdown,
        anchor: button,
        id: 'strategy-selector',
        onClose: () => this.closeDropdown(),
        align: 'left',
        gap: 8,
        insideSelectors: ['strategy-selector', '.strategy-dropdown[data-strategy-selector="true"]'],
      });
    });
  }

  /** @private */
  closeDropdown() {
    if (this._dropdownOpen) {
      this._dropdownOpen = false;
      // Release tears down the surface, scrim, observer and dismissal wiring.
      if (this._popupRelease) {
        this._popupRelease();
        this._popupRelease = null;
      }
      this._liveDropdown = null;
      // Just update button state without full re-render to avoid focus disruption
      const button = this.querySelector('.strategy-selector-button');
      if (button) {
        button.classList.remove('open');
      }
    }
  }

  /**
   * Select a strategy
   * @param {string} strategyId
   * @private
   */
  selectStrategy(strategyId) {
    if (!this._messageThread) {
      console.error('[StrategySelector] No message thread bound');
      this.closeDropdown();
      return;
    }

    if (this._currentStrategyId === strategyId) {
      this.closeDropdown();
      return;
    }

    // Update the conversation's strategy
    this._writeStrategyToDoc(strategyId);

    // Close dropdown first so render() sees dropdownOpen = false
    this.closeDropdown();

    // Update local display
    this._currentStrategyId = strategyId;
    this.render();
  }

  /**
   * Get the current strategy name for display
   * @returns {string} The display name of the current strategy
   * @private
   */
  getCurrentStrategyName() {
    const strategy = this._strategies.find(s => s.id === this._currentStrategyId);
    return strategy ? strategy.manifest.name : 'Select Strategy';
  }

  /**
   * Generate the dropdown menu content
   * @returns {string} HTML string for the dropdown menu items
   * @private
   */
  generateDropdownContent() {
    if (this._strategies.length === 0) {
      return `
                <li class="strategy-item unavailable">
                    <p class="strategy-item-description">No strategies available</p>
                </li>
            `;
    }

    return this._strategies.map(({ id, manifest }) => {
      const isActive = id === this._currentStrategyId;
      const colorStyle = manifest.color ? `style="--strategy-color: ${manifest.color}"` : '';

      const iconHtml = manifest.icon
        ? `<span class="strategy-item-icon ${manifest.icon}" aria-hidden="true"></span>`
        : '';

      return `
                <li class="strategy-item ${isActive ? 'active' : ''}" data-strategy-id="${id}" ${colorStyle}>
                    <header class="strategy-item-header">
                        <span class="strategy-item-label">
                            ${iconHtml}
                            <span class="strategy-item-name">${manifest.name}</span>
                        </span>
                        ${isActive ? '<span class="strategy-check">&#10003;</span>' : ''}
                    </header>
                    <p class="strategy-item-description">${manifest.description}</p>
                </li>
            `;
    }).join('');
  }

  /**
   * Get the current strategy's color for visual identification
   * @returns {string|null} The CSS color value or null if not defined
   * @private
   */
  getCurrentStrategyColor() {
    const strategy = this._strategies.find(s => s.id === this._currentStrategyId);
    return strategy?.manifest.color || null;
  }

  /**
   * Get the current strategy's icon class for display next to its name
   * @returns {string|null} The icon CSS class or null if not defined
   * @private
   */
  getCurrentStrategyIcon() {
    const strategy = this._strategies.find(s => s.id === this._currentStrategyId);
    return strategy?.manifest.icon || null;
  }

  /**
   * Open the dropdown (for keyboard shortcut)
   */
  open() {
    if (!this._dropdownOpen) {
      this.toggleDropdown();
    }
  }

  /**
   * Close the dropdown (for keyboard shortcut)
   */
  close() {
    this.closeDropdown();
  }

  /**
   * Cycle to next strategy (wraps around), keeping the dropdown open if it was
   * open. `render()` refreshes the open menu and its anchor button IN PLACE
   * (see the live-dropdown branch), so cycling never tears the body-hosted
   * popup down and re-presents it — the teardown/re-present that made the menu
   * flicker on every hop. During a hold-to-cycle gesture the `setStrategy`
   * write is buffered (see `beginCycle`); the local id + render still update so
   * the HUD highlights the landing strategy.
   */
  cycleNext() {
    if (!this._messageThread || this._strategies.length <= 1) return;

    const currentIndex = this._strategies.findIndex(s => s.id === this._currentStrategyId);
    const nextIndex = (currentIndex + 1) % this._strategies.length;
    const next = this._strategies[nextIndex];
    if (!next) return;

    this._writeOrDeferStrategy(next.id);
    this._currentStrategyId = next.id;
    this.render();
  }

  /**
   * Persist a strategy id to the bound thread — the doc the engine (and any
   * running turn) reads. The single write path shared by `selectStrategy` and
   * `cycleNext`/`commitCycle`.
   * @param {string} strategyId
   * @private
   */
  _writeStrategyToDoc(strategyId) {
    this._messageThread?.setStrategy(strategyId);
  }

  /**
   * Write `strategyId` now, or — during a hold-to-cycle gesture (`beginCycle`)
   * — buffer it so a running turn never observes an intermediate strategy; the
   * local id and in-place render still update on every hop, and `commitCycle`
   * flushes the landing strategy once.
   * @param {string} strategyId
   * @private
   */
  _writeOrDeferStrategy(strategyId) {
    if (this._deferWrites) {
      this._deferDirty = true;
      return;
    }
    this._writeStrategyToDoc(strategyId);
  }

  /**
   * Enter deferred-write mode for a hold-to-cycle gesture: subsequent
   * `cycleNext` hops update the visible selection but hold their `setStrategy`
   * write until `commitCycle`. Idempotent.
   */
  beginCycle() {
    if (this._deferWrites) return;
    this._deferWrites = true;
    this._deferDirty = false;
  }

  /**
   * Flush a deferred gesture: leave deferred mode and, if any hop was applied,
   * write the landing strategy to the doc exactly once — so a running turn only
   * ever sees the final choice. A pure hold-to-peek writes nothing.
   */
  commitCycle() {
    const dirty = this._deferDirty;
    this._deferWrites = false;
    this._deferDirty = false;
    if (dirty) this._writeStrategyToDoc(this._currentStrategyId);
  }

  /**
   * Abandon a deferred gesture (Escape): the doc was never written, so restore
   * the visible selection to the thread's still-committed strategy and
   * re-render. A pure peek leaves the display untouched.
   */
  cancelCycle() {
    const dirty = this._deferDirty;
    this._deferWrites = false;
    this._deferDirty = false;
    if (!dirty) return;
    this._currentStrategyId = this._messageThread?.currentStrategyId || 'default';
    this.render();
  }

  render() {
    const strategyName = this.getCurrentStrategyName();
    const strategyColor = this.getCurrentStrategyColor();
    const strategyIcon = this.getCurrentStrategyIcon();
    const dropdownContent = this.generateDropdownContent();

    // Build style attribute for color if defined
    const colorStyle = strategyColor ? `style="--strategy-color: ${strategyColor}"` : '';
    const hasColorAttr = strategyColor ? 'data-has-color="true"' : '';

    // While open, the dropdown has been relocated out of this element to
    // <body> (see toggleDropdown) and positioned against our button. A
    // re-render here — e.g. the bound thread changed when the conversation
    // switches — must NOT clobber innerHTML: that recreates (detaches) the
    // button the body-hosted menu is anchored to, so the menu's
    // MutationObserver repositions against a detached node (rect = 0) and the
    // menu jumps to the top-left corner, while the button visibly flashes.
    // When the live surface and its anchor button both exist, update the
    // button IN PLACE and refresh + reposition the menu, leaving both intact.
    //
    // Scope to this instance's own surface, never a document-wide query: with a
    // sub-thread open, several selectors coexist and the query would return
    // whichever one is open — so a closed sibling re-rendering (its thread
    // rebuilds on every doc update) rebound the open menu's clicks to its own
    // thread, landing every selection on the wrong thread.
    const liveDropdown = this._liveDropdown;
    const liveButton = /** @type {HTMLElement|null} */ (
      this.querySelector('.strategy-selector-button'));

    if (this._dropdownOpen && liveDropdown && liveButton) {
      this._updateButton(liveButton, strategyName, strategyColor, strategyIcon);
      const menu = liveDropdown.querySelector('menu');
      if (menu) menu.innerHTML = dropdownContent;
      this._attachItemListeners(liveDropdown);
      // presentPopup's MutationObserver catches this content change and
      // re-anchors the surface (or leaves the sheet untouched on a phone).
      return;
    }

    const dropdownHtml = (this._dropdownOpen && !liveDropdown)
      ? `<nav class="dropdown-menu strategy-dropdown show" id="strategy-dropdown"><menu>${dropdownContent}</menu></nav>`
      : '';

    const buttonIconHtml = strategyIcon
      ? `<span class="strategy-icon ${strategyIcon}" aria-hidden="true"></span>`
      : '';

    this.innerHTML = `
            <button class="strategy-selector-button input-ctrl-btn ${this._dropdownOpen ? 'open' : ''}" id="strategy-button" tabindex="-1" title="Select Strategy" ${colorStyle} ${hasColorAttr}>
                ${buttonIconHtml}
                <span class="strategy-name">${strategyName}</span>
                <span class="strategy-chevron">${DROPDOWN_ARROW_SVG}</span>
            </button>
            ${dropdownHtml}
        `;

    // Attach event listeners
    const button = this.querySelector('#strategy-button');
    if (button) {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleDropdown();
      });
    }

    // Wire the strategy items wherever they now live: the relocated surface
    // when one is open, otherwise the freshly-rendered inner <nav> (which
    // toggleDropdown's rAF moves to <body>, listeners and all).
    if (liveDropdown) {
      const menu = liveDropdown.querySelector('menu');
      if (menu) menu.innerHTML = dropdownContent;
      this._attachItemListeners(liveDropdown);
    } else {
      this._attachItemListeners(this);
    }
  }

  /**
   * Update an existing button's label, colour and open-state in place, without
   * replacing the element. Used while the menu is open so the body-hosted menu
   * keeps a live, attached anchor to position against.
   * @param {HTMLElement} button - The existing `.strategy-selector-button`
   * @param {string} strategyName - Current strategy display name
   * @param {string|null} strategyColor - Current strategy colour, or null
   * @param {string|null} strategyIcon - Current strategy icon class, or null
   * @private
   */
  _updateButton(button, strategyName, strategyColor, strategyIcon) {
    const nameEl = button.querySelector('.strategy-name');
    if (nameEl) nameEl.textContent = strategyName;

    // Sync the leading icon in place so the body-hosted menu's anchor button
    // is never recreated (which would detach the menu's positioning target).
    let iconEl = button.querySelector('.strategy-icon');
    if (strategyIcon) {
      if (!iconEl) {
        iconEl = document.createElement('span');
        iconEl.setAttribute('aria-hidden', 'true');
        button.insertBefore(iconEl, nameEl);
      }
      iconEl.className = `strategy-icon ${strategyIcon}`;
    } else if (iconEl) {
      iconEl.remove();
    }

    if (strategyColor) {
      button.style.setProperty('--strategy-color', strategyColor);
      button.setAttribute('data-has-color', 'true');
    } else {
      button.style.removeProperty('--strategy-color');
      button.removeAttribute('data-has-color');
    }
    button.classList.toggle('open', this._dropdownOpen);
  }

  /**
   * Wire click handlers on the strategy items under `root`.
   * @param {ParentNode} root - Element containing the `.strategy-item` nodes.
   * @private
   */
  _attachItemListeners(root) {
    root.querySelectorAll('.strategy-item[data-strategy-id]').forEach(item => {
      item.addEventListener('click', () => {
        const strategyId = item.getAttribute('data-strategy-id');
        if (strategyId) {
          this.selectStrategy(strategyId);
        }
      });
    });
  }
}

customElements.define('strategy-selector', StrategySelector);

export { StrategySelector };
