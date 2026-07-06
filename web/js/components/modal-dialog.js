//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {object} ModalOptions
 * @property {string} [title] - Dialog title
 * @property {string} [message] - Dialog message
 * @property {'alert'|'confirm'|'prompt'|'choice'} [type] - Dialog type
 * @property {string} [confirmText] - Confirm button text
 * @property {string} [cancelText] - Cancel button text
 * @property {boolean} [danger] - Use danger styling for confirm button
 * @property {string} [defaultValue] - Default value for prompt input
 * @property {string[]} [choices] - Array of choice options
 * @property {boolean} [allowCustom] - Allow custom text input for choice type
 */

// Extend Window interface for modal helper functions
/**
 * @typedef {object} WindowWithModals
 * @property {function(ModalOptions): Promise<any>} showModal - Show a modal dialog
 * @property {function(string, string=): Promise<void>} showAlert - Show an alert dialog
 * @property {function(string, string=, ConfirmOptions=): Promise<boolean>} showConfirm - Show a confirmation dialog
 * @property {function(string, string=, string=): Promise<string|null>} showPrompt - Show a prompt dialog
 * @property {function(string, string[], string=, boolean=): Promise<string|null>} showChoice - Show a choice dialog
 */

/**
 * ModalDialog - Reusable modal dialog component
 *
 * IMPORTANT: ALWAYS use this instead of browser alerts (alert, confirm, prompt)
 *
 * Usage:
 *   const modal = document.createElement('modal-dialog');
 *   modal.show({
 *     title: 'Confirm Action',
 *     message: 'Are you sure?',
 *     type: 'confirm',
 *     confirmText: 'Yes',
 *     cancelText: 'No',
 *     danger: true
 *   }).then(result => {
 *     if (result) {
 *       // User confirmed
 *     }
 *   });
 *
 * Types:
 *   - 'alert': Show message with OK button
 *   - 'confirm': Show message with Yes/No buttons
 *   - 'prompt': Show input field with OK/Cancel buttons
 */
import { markPopupOpen } from '../utils/popup-manager.js';

class ModalDialog extends HTMLElement {
  constructor() {
    super();
    /** @type {((value: unknown) => void)|null} @private */
    this.resolvePromise = null;
    /** @type {((e: KeyboardEvent) => void)|null} @private */
    this.handleKeydown = null;
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {(() => void)|null} @private */
    this._backdropClickHandler = null;
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    if (this.handleKeydown) {
      document.removeEventListener('keydown', this.handleKeydown);
      this.handleKeydown = null;
    }
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }

    // Resolve any pending promises with null
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
  }

  render() {
    this.innerHTML = `
            <modal-backdrop class="modal-backdrop-el"></modal-backdrop>
      <modal-panel class="modal-container">
        <header class="modal-header">
          <h2 class="modal-title">Dialog</h2>
        </header>
        <div class="modal-body">
          <div class="modal-message"></div>
          <input type="text" class="modal-input hidden" autocorrect="off" autocapitalize="off" spellcheck="false" />
          <div class="modal-choice-options hidden"></div>
          <input type="text" class="modal-custom-input hidden" placeholder="Enter your answer..." autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <footer class="modal-footer">
          <!-- Buttons will be added dynamically -->
        </div>
      </modal-panel>
    `;

    // Close on backdrop click
    const backdrop = this.querySelector('.modal-backdrop-el');
    if (backdrop) {
      backdrop.addEventListener('click', () => {
        this.close(null);
      });
    }
  }

  /**
   * Show modal dialog
   * @param {ModalOptions} [options] - Dialog options
   * @returns {Promise<any>} Resolves with dialog result (boolean for confirm, string for prompt/choice, null if cancelled)
   */
  show(options = {}) {
    const {
      title = 'Dialog',
      message = '',
      type = 'alert',
      confirmText = 'OK',
      cancelText = 'Cancel',
      danger = false,
      defaultValue = '',
      choices = [],
      allowCustom = false
    } = options;

    // Per-show reset: this is a reused singleton, so clear any stale key handler
    // (e.g. a previous choice dialog's arrow/Enter navigation) before this call
    // decides whether it needs one. Escape-to-close is handled by popup-manager.
    if (this.handleKeydown) document.removeEventListener('keydown', this.handleKeydown);
    this.handleKeydown = null;

    // Set title and message
    const titleEl = this.querySelector('.modal-title');
    const messageEl = this.querySelector('.modal-message');
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    // Setup input for prompt type
    const input = /** @type {HTMLInputElement|null} */ (this.querySelector('.modal-input'));
    const choiceOptions = /** @type {HTMLElement|null} */ (this.querySelector('.modal-choice-options'));
    const customInput = /** @type {HTMLInputElement|null} */ (this.querySelector('.modal-custom-input'));

    // Hide all by default
    if (input) input.classList.add('hidden');
    if (choiceOptions) choiceOptions.classList.add('hidden');
    if (customInput) customInput.classList.add('hidden');

    if (type === 'prompt' && input) {
      input.classList.remove('hidden');
      input.value = defaultValue;
      setTimeout(() => {
        input.focus();
        input.select();
      }, 100);
    } else if (type === 'choice' && choiceOptions && customInput) {
      choiceOptions.classList.remove('hidden');
      this.setupChoices(choices, allowCustom, choiceOptions, customInput);
    }

    // Setup buttons
    const footer = /** @type {HTMLElement|null} */ (this.querySelector('.modal-footer'));
    if (!footer) return Promise.resolve(null);
    footer.innerHTML = '';
    footer.classList.remove('hidden'); // Reset visibility from previous modals

    if (type === 'alert') {
      const okButton = this.createButton(confirmText, 'primary', () => {
        this.close(true);
      });
      footer.appendChild(okButton);
      setTimeout(() => okButton.focus(), 100);
    } else if (type === 'confirm') {
      const cancelButton = this.createButton(cancelText, 'secondary', () => {
        this.close(false);
      });
      const confirmButton = this.createButton(confirmText, danger ? 'danger' : 'primary', () => {
        this.close(true);
      });
      footer.appendChild(cancelButton);
      footer.appendChild(confirmButton);
      setTimeout(() => confirmButton.focus(), 100);
    } else if (type === 'prompt' && input) {
      const cancelButton = this.createButton(cancelText, 'secondary', () => {
        this.close(null);
      });
      const confirmButton = this.createButton(confirmText, 'primary', () => {
        this.close(input.value);
      });
      footer.appendChild(cancelButton);
      footer.appendChild(confirmButton);

      // Submit on Enter
      input.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter') {
          this.close(input.value);
        }
      });
    } else if (type === 'choice') {
      // Choice type doesn't use footer buttons - everything is in the choice options
      footer.classList.add('hidden');
    }

    // Show modal
    this.classList.add('show');
    if (this.handleKeydown) {
      document.addEventListener('keydown', this.handleKeydown);
    }
    // Release any prior token first (the singleton element is reused per call).
    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (this._releasePopupOpen) this._releasePopupOpen();
    this._releasePopupOpen = markPopupOpen(() => this.close(null));

    // Return promise
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  /**
   * Setup choice buttons with keyboard navigation
   * @param {string[]} choices - Array of choice options
   * @param {boolean} allowCustom - Whether to show "Other" option
   * @param {HTMLElement} container - Container element for choices
   * @param {HTMLInputElement} customInput - Custom input element
   */
  setupChoices(choices, allowCustom, container, customInput) {
    container.innerHTML = '';
    let focusedIndex = 0;
    /** @type {HTMLButtonElement[]} */
    const allButtons = [];

    // Create button for each choice
    choices.forEach((choice, index) => {
      const button = document.createElement('button');
      button.className = 'modal-choice-button';
      button.textContent = choice;
      button.dataset.index = String(index);
      button.addEventListener('click', () => {
        this.close(choice);
      });
      container.appendChild(button);
      allButtons.push(button);
    });

    // Add "Other" option if custom input is allowed
    if (allowCustom) {
      const otherButton = document.createElement('button');
      otherButton.className = 'modal-choice-button';
      otherButton.textContent = 'Other (enter custom answer)';
      otherButton.dataset.index = String(allButtons.length);
      otherButton.addEventListener('click', () => {
        // Show custom input and focus it
        customInput.style.display = 'block';
        customInput.focus();
        customInput.select();
      });
      container.appendChild(otherButton);
      allButtons.push(otherButton);

      // Handle custom input submission
      customInput.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter' && customInput.value.trim()) {
          this.close(customInput.value.trim());
        } else if (e.key === 'Escape') {
          // Hide the custom input first. stopPropagation keeps this Escape from
          // bubbling to popup-manager, which would otherwise close the whole
          // choice dialog instead of just retreating from the custom field.
          e.preventDefault();
          e.stopPropagation();
          customInput.style.display = 'none';
          customInput.value = '';
          allButtons[focusedIndex]?.focus();
        }
      });
    }

    // Add "None of the above" option
    const noneButton = document.createElement('button');
    noneButton.className = 'modal-choice-button modal-choice-button-none';
    noneButton.textContent = 'None of the above';
    noneButton.dataset.index = String(allButtons.length);
    noneButton.addEventListener('click', () => {
      this.close(null);
    });
    container.appendChild(noneButton);
    allButtons.push(noneButton);

    // Focus first button initially
    setTimeout(() => {
      allButtons[0]?.classList.add('focused');
      allButtons[0]?.focus();
    }, 100);

    // Keyboard navigation
    const handleChoiceKeydown = (/** @type {KeyboardEvent} */ e) => {
      // Don't handle if custom input is visible and focused
      if (customInput.style.display === 'block' && document.activeElement === customInput) {
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        allButtons[focusedIndex]?.classList.remove('focused');
        focusedIndex = (focusedIndex + 1) % allButtons.length;
        allButtons[focusedIndex]?.classList.add('focused');
        allButtons[focusedIndex]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        allButtons[focusedIndex]?.classList.remove('focused');
        focusedIndex = (focusedIndex - 1 + allButtons.length) % allButtons.length;
        allButtons[focusedIndex]?.classList.add('focused');
        allButtons[focusedIndex]?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        allButtons[focusedIndex]?.click();
      }
    };

    // Choice mode needs arrow/Enter navigation across the option buttons.
    // Escape-to-close is handled by popup-manager like every other modal; the
    // custom-input field swallows its own Escape (hide-first) via stopPropagation
    // above, so an Escape there never reaches this document-level handler.
    this.handleKeydown = handleChoiceKeydown;
  }

  /**
   * @param {string} text
   * @param {string} variant
   * @param {() => void} onClick
   * @returns {HTMLButtonElement} Created button element
   */
  createButton(text, variant, onClick) {
    const button = document.createElement('button');
    button.className = `modal-button ${variant}`;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * @param {any} result - Dialog result to resolve promise with
   */
  close(result) {
    this.classList.remove('show');
    if (this.handleKeydown) {
      document.removeEventListener('keydown', this.handleKeydown);
    }
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }

    if (this.resolvePromise) {
      this.resolvePromise(result);
      this.resolvePromise = null;
    }
  }
}

customElements.define('modal-dialog', ModalDialog);

/**
 * @typedef {object} ConfirmOptions
 * @property {string} [confirmText] - Confirm button text
 * @property {string} [cancelText] - Cancel button text
 * @property {boolean} [danger] - Use danger styling for confirm button
 */

// Global modal helper - attach to window for easy access
// @ts-ignore - Extending window object
window.showModal = async function(/** @type {ModalOptions} */ options) {
  let modal = document.querySelector('modal-dialog');
  if (!modal) {
    modal = document.createElement('modal-dialog');
  }
  // Re-append so the dialog is last in <body>; at equal z-index this puts it
  // above any other modal-level element (e.g. bin-modal) that was opened
  // first and would otherwise stack on top.
  document.body.appendChild(modal);
  // @ts-ignore - modal-dialog element has show method
  return await modal.show(options);
};

// Convenience methods
// @ts-ignore - Extending window object
window.showAlert = async function(/** @type {string} */ message, title = 'Alert') {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'alert'
  });
};

// @ts-ignore - Extending window object
window.showConfirm = async function(/** @type {string} */ message, title = 'Confirm', /** @type {ConfirmOptions} */ options = {}) {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'confirm',
    confirmText: options.confirmText || 'OK',
    cancelText: options.cancelText || 'Cancel',
    danger: options.danger || false
  });
};

// @ts-ignore - Extending window object
window.showPrompt = async function(/** @type {string} */ message, defaultValue = '', title = 'Input') {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'prompt',
    defaultValue
  });
};

/**
 * Show choice modal with large buttons
 * @param {string} message - Question to ask
 * @param {string[]} choices - Array of choice options
 * @param {string} [title] - Modal title
 * @param {boolean} [allowCustom] - Whether to show "Other" option for custom input
 * @returns {Promise<string|null>} Selected choice text, custom input, or null if cancelled
 */
// @ts-ignore - Extending window object
window.showChoice = async function(/** @type {string} */ message, /** @type {string[]} */ choices, title = 'Question', allowCustom = false) {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'choice',
    choices,
    allowCustom
  });
};
