//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * Inline folder glyph prefixed to a folder-grant `<code>` span, so a grant
 * reads as a directory rather than a command pattern. `currentColor` makes it
 * inherit the span's accent colour; sized to sit on the text baseline.
 */
const FOLDER_ICON_SVG = '<svg class="pattern-folder-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640H447l-80-80H160v480l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z"/></svg>';

/**
 * @typedef {object} ApprovalOption
 * @property {string} label - Button label
 * @property {string} value - Value returned when selected ('yes', 'yes-always', 'yes-always:N', 'no', 'cancel')
 * @property {string} style - Button style class (primary, primary-always, secondary, danger)
 * @property {string} [pattern] - Single pattern to display for "Don't ask again" options
 * @property {string[]} [patterns] - Multiple patterns to display, each as its own `<code>` span joined by a plain-font "or". Preferred over `pattern` when an option covers more than one pattern.
 * @property {Array<{kind: string, value: any}>} [rules] - Permission rules to persist when this "Don't ask again" option is chosen
 * @property {string[]} [allowedPaths] - Allowed-paths roots to add when this "Don't ask again" option is chosen (alternative to `rules`)
 * @property {string} [itemType] - Owning plugin id the `rules` belong to
 */

/**
 * @typedef {object} ActionConfirmationOptions
 * @property {string} [title] - Approval title (displayed by parent container)
 * @property {string} [message] - Approval message (displayed by parent container)
 * @property {ApprovalOption[]} options - The approval button options
 */

/**
 * ActionConfirmation - Inline approval buttons component
 *
 * Displays approval buttons for action confirmation with:
 * - Keyboard navigation (↑/↓/Enter/Esc)
 * - Pattern display for "Don't ask again" options
 * - "Enter to engage, Escape to disengage" widget mode
 *
 * The action details (diffs, commands, etc.) are displayed separately
 * by the parent container (tool-action-message).
 * @class
 * @augments HTMLElement
 */
class ActionConfirmation extends HTMLElement {
  constructor() {
    super();

    /** @type {ActionConfirmationOptions|null} @private */
    this._options = null;

    /** @type {((value: string) => void)|null} @private */
    this._resolveCallback = null;

    /** @type {number} @private */
    this._focusedIndex = 0;

    // Bind handlers for stable references (addEventListener/removeEventListener)
    this._handleButtonClick = this._handleButtonClick.bind(this);
    this._handleKeyDown = this._handleKeyDown.bind(this);
    this._handleFocusOut = this._handleFocusOut.bind(this);
  }

  connectedCallback() {
    this.setAttribute('tabindex', '-1');
    this._render();
    this._attachEventListeners();
  }

  disconnectedCallback() {
    this._removeEventListeners();
  }

  /**
   * Set confirmation options and promise resolver
   * @param {ActionConfirmationOptions} options - Button options
   * @param {(value: string) => void} resolve - Callback when user selects an option
   */
  setOptions(options, resolve) {
    this._options = options;
    this._resolveCallback = resolve;
    this._focusedIndex = 0;
    this._render();
    this._attachEventListeners();
  }

  /**
   * Render the approval buttons
   * @private
   */
  _render() {
    if (!this._options) {
      return;
    }

    const { options } = this._options;

    this.innerHTML = `
      <div class="action-approval-buttons">
        ${options.map((opt, index) => {
          const patternHtml = this._renderPatterns(opt);
          return `
          <button
            class="action-confirmation-button ${opt.style}"
            data-value="${opt.value}"
            data-index="${index}"
          >
            ${escapeHtml(opt.label)}${patternHtml}
          </button>
        `;
        }).join('')}
      </div>
    `;
  }

  /**
   * Render the trailing descriptor of a "Don't ask again" button.
   *
   * Two shapes, deliberately worded apart so the user can never mistake one for
   * the other:
   *   - a **command-pattern** option reads `… for <code>git push *</code>` — the
   *     `<code>` is a shell command glob that will be auto-approved;
   *   - a **folder-grant** option (carries `allowedPaths`) reads
   *     `… and allow access to <folder-icon> ~/notes` — the
   *     `<code>` is a directory added to the allowed-reads list, NOT a command.
   * Each entry is its own `<code>` span; multiple are joined by a plain-font
   * "or" (Oxford-style commas for three or more).
   * @param {ApprovalOption} opt
   * @returns {string} HTML for the descriptor suffix, or '' if there is none
   * @private
   */
  _renderPatterns(opt) {
    const isPathGrant = Array.isArray(opt.allowedPaths) && opt.allowedPaths.length > 0;
    const parts = (opt.patterns && opt.patterns.length)
      ? opt.patterns
      : (opt.pattern ? [opt.pattern] : []);
    if (parts.length === 0) {
      return '';
    }
    const prefix = isPathGrant ? FOLDER_ICON_SVG : '';
    const cls = isPathGrant ? 'pattern-highlight path-highlight' : 'pattern-highlight';
    const spans = parts.map(p => `<code class="${cls}">${prefix}${escapeHtml(p)}</code>`);
    const last = spans.pop();
    const joined = spans.length === 0
      ? last
      : `${spans.join(', ')}${spans.length > 1 ? ',' : ''} or ${last}`;
    // A folder grant whitelists reads under a directory; word it so it reads as
    // access, not a command pattern.
    return isPathGrant ? ` and allow access to ${joined}` : ` for ${joined}`;
  }

  /**
   * Attach event listeners
   * @private
   */
  _attachEventListeners() {
    this.addEventListener('click', this._handleButtonClick);
    this.addEventListener('keydown', this._handleKeyDown);
    this.addEventListener('focusout', this._handleFocusOut);
  }

  /**
   * Remove event listeners
   * @private
   */
  _removeEventListeners() {
    this.removeEventListener('click', this._handleButtonClick);
    this.removeEventListener('keydown', this._handleKeyDown);
    this.removeEventListener('focusout', this._handleFocusOut);
  }

  /**
   * Drop the visual focus cursor when keyboard focus leaves the widget entirely
   * (click elsewhere, tab away, switch conversation). Without this the `.focused`
   * ring lingers on a button that no longer holds focus, falsely implying that
   * ↑/↓/Enter still act here — they don't until the widget is re-engaged. Focus
   * moving between this widget's own buttons is kept (relatedTarget is inside).
   * @param {FocusEvent} event
   * @private
   */
  _handleFocusOut(event) {
    const next = /** @type {Node|null} */ (event.relatedTarget);
    if (next && this.contains(next)) return;
    this.querySelectorAll('.action-confirmation-button').forEach(
      btn => btn.classList.remove('focused'),
    );
  }

  /**
   * Handle button click
   * @param {MouseEvent} event
   * @private
   */
  _handleButtonClick(event) {
    const target = /** @type {HTMLElement|null} */ (event.target);
    if (!target) {
      return;
    }

    const button = target.closest('.action-confirmation-button');
    if (!button) {
      return;
    }

    const value = /** @type {HTMLElement} */ (button).dataset.value;
    if (value) {
      this._resolve(value);
    }
  }

  /**
   * Handle keyboard navigation
   * @param {KeyboardEvent} event
   * @private
   */
  _handleKeyDown(event) {
    if (!this._options) {
      return;
    }

    const buttons = this.querySelectorAll('.action-confirmation-button');
    if (buttons.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        this._focusedIndex = Math.max(0, this._focusedIndex - 1);
        this._focusButton(this._focusedIndex);
        break;

      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        this._focusedIndex = Math.min(buttons.length - 1, this._focusedIndex + 1);
        this._focusButton(this._focusedIndex);
        break;

      case 'Enter': {
        event.preventDefault();
        const enterButton = /** @type {HTMLElement} */ (buttons[this._focusedIndex]);
        if (enterButton) {
          enterButton.click();
        }
        break;
      }

      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this._disengage();
        break;
    }
  }

  /**
   * Enter widget mode — focuses the approval buttons for keyboard interaction.
   * Called externally (e.g. by conversation-tab) when Enter is pressed on a selected approval item.
   */
  engage() {
    this._focusButton(this._focusedIndex);
  }

  /**
   * Exit widget mode — blurs buttons, removes visual focus indicator,
   * and selects the parent item so keyboard navigation continues from here.
   * @private
   */
  _disengage() {
    const buttons = this.querySelectorAll('.action-confirmation-button');
    buttons.forEach(btn => btn.classList.remove('focused'));
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // Select the parent message item so arrow keys work from this position
    const parentItem = this.closest('[message-id]');
    if (parentItem) {
      const itemId = parentItem.getAttribute('message-id');
      const column = this.closest('conversation-area');
      if (itemId && column) {
        /** @type {any} */ (column).selectItem(itemId);
      }
    }
  }

  /**
   * Focus a button by index
   * @param {number} index
   * @private
   */
  _focusButton(index) {
    const buttons = this.querySelectorAll('.action-confirmation-button');
    buttons.forEach((btn, i) => {
      const button = /** @type {HTMLElement} */ (btn);
      if (i === index) {
        button.classList.add('focused');
        button.focus();
      } else {
        button.classList.remove('focused');
      }
    });
  }

  /**
   * Resolve with user's selection
   * @param {string} value - Selected option value
   * @private
   */
  _resolve(value) {
    if (this._resolveCallback) {
      this._resolveCallback(value);
      this._resolveCallback = null;
    }
    this._removeEventListeners();
    this.remove();
  }
}

customElements.define('action-confirmation', ActionConfirmation);

export default ActionConfirmation;
