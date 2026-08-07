//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { formatRelativeDateTime, formatBytes } from '../utils/format.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { showAlert, showConfirm } from './modal-dialog.js';
import JugglerElement from './juggler-element.js';
import { UNTITLED_BASE } from '../model/conversation-naming.js';

/**
 * @typedef {object} BinnedConvRow
 * @property {string} id - Conversation ID (conv_*)
 * @property {string} name - Human-readable name from the folder
 * @property {string} lastModifiedAt - ISO 8601 of the conversation's last edit
 */

/**
 * BinModal — popup listing binned conversations with Restore / Delete
 * actions plus an "Empty Bin" header button. Opened from the "Bin" button at
 * the bottom of the conversation bar. The bin is a permanent holding area:
 * items stay until the user restores them or empties the bin (nothing
 * auto-expires). Re-fetches the list every time it's opened; refreshes after
 * each user action so restore/delete results are immediately visible.
 */
class BinModal extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
  }

  /**
   * Open the modal for the given session.
   * @param {import('../model/session.js').default} session
   */
  async open(session) {
    this._session = session;
    this.render();
    this.classList.add('is-open');
    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this.close());
    }
    await this._refreshList();
  }

  close() {
    this.classList.remove('is-open');
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
  }

  render() {
    this.innerHTML = `
      <modal-backdrop class="modal-backdrop-el bin-backdrop"></modal-backdrop>
      <modal-panel class="modal-container bin-panel">
        <header class="modal-header">
          <h2 class="modal-title">Bin</h2>
          <div class="bin-header-actions">
            <button class="bin-empty-now" type="button" disabled>Empty Bin</button>
            <button class="bin-close" aria-label="Close" title="Close">×</button>
          </div>
        </header>
        <div class="modal-body bin-body">
          <div class="bin-empty hidden">The bin is empty.</div>
          <ul class="bin-list" role="list"></ul>
        </div>
      </modal-panel>
    `;
    const backdrop = this.querySelector('.bin-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.close());
    }
    const closeBtn = this.querySelector('.bin-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    const emptyBtn = this.querySelector('.bin-empty-now');
    if (emptyBtn) {
      emptyBtn.addEventListener('click', () => this._onEmptyBin());
    }
  }

  /**
   * Re-fetch the binned list and re-render rows.
   * @private
   */
  async _refreshList() {
    if (!this._session) return;
    const list = /** @type {HTMLUListElement|null} */ (this.querySelector('.bin-list'));
    const empty = /** @type {HTMLElement|null} */ (this.querySelector('.bin-empty'));
    const emptyBtn = /** @type {HTMLButtonElement|null} */ (this.querySelector('.bin-empty-now'));
    if (!list || !empty) return;

    /** @type {BinnedConvRow[]} */
    let binned = [];
    try {
      binned = await this._session.listBinnedConversations();
    } catch (e) {
      console.error('[BinModal] Failed to load binned list:', e);
      empty.classList.remove('hidden');
      empty.textContent = 'Failed to load the bin.';
      list.innerHTML = '';
      if (emptyBtn) {
        emptyBtn.disabled = true;
        emptyBtn.textContent = 'Empty Bin';
      }
      return;
    }

    list.innerHTML = '';
    if (emptyBtn) {
      emptyBtn.disabled = binned.length === 0;
      // listBinnedConversations refreshed session.binSizeBytes above; fold the
      // approximate folder size into the button so "Empty Bin (50 MB)" tells
      // the user how much they're about to reclaim.
      const sizeBytes = this._session.binSizeBytes || 0;
      emptyBtn.textContent = binned.length > 0 && sizeBytes > 0
        ? `Empty Bin (${formatBytes(sizeBytes)})`
        : 'Empty Bin';
    }
    if (binned.length === 0) {
      empty.classList.remove('hidden');
      empty.textContent = 'The bin is empty.';
      return;
    }
    empty.classList.add('hidden');

    for (const row of binned) {
      const li = document.createElement('li');
      li.className = 'bin-row';
      li.dataset.conversationId = row.id;
      const { short: dateShort, full: dateFull } = formatRelativeDateTime(row.lastModifiedAt);
      li.innerHTML = `
        <div class="bin-row-info">
          <span class="bin-row-name"></span>
          <span class="bin-row-date"></span>
        </div>
        <div class="bin-row-actions">
          <button class="bin-action bin-restore" type="button">Restore</button>
          <button class="bin-action bin-delete" type="button">Delete</button>
        </div>
      `;
      const nameEl = li.querySelector('.bin-row-name');
      const dateEl = /** @type {HTMLElement|null} */ (li.querySelector('.bin-row-date'));
      if (nameEl) nameEl.textContent = row.name || UNTITLED_BASE;
      if (dateEl) {
        dateEl.textContent = dateShort;
        dateEl.title = dateFull;
      }
      const restoreBtn = /** @type {HTMLButtonElement} */ (li.querySelector('.bin-restore'));
      const deleteBtn = /** @type {HTMLButtonElement} */ (li.querySelector('.bin-delete'));
      restoreBtn.addEventListener('click', () => this._onRestore(row));
      deleteBtn.addEventListener('click', () => this._onDelete(row));
      list.appendChild(li);
    }
  }

  /**
   * @param {BinnedConvRow} row
   * @private
   */
  async _onRestore(row) {
    if (!this._session) return;
    try {
      await this._session.restoreConversation(row.id);
    } catch (e) {
      console.error('[BinModal] restore failed:', e);
      await showAlert(
        `Failed to restore: ${/** @type {any} */ (e)?.message || e}`,
        'Restore failed'
      );
    }
    await this._refreshList();
  }

  /**
   * @param {BinnedConvRow} row
   * @private
   */
  async _onDelete(row) {
    if (!this._session) return;
    const confirmed = await showConfirm(
      `Permanently delete "${row.name || UNTITLED_BASE}"?\n\nThis cannot be undone.`,
      'Delete Conversation',
      { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return;
    try {
      await this._session.deleteBinnedConversation(row.id);
    } catch (e) {
      console.error('[BinModal] delete failed:', e);
      await showAlert(
        `Failed to delete: ${/** @type {any} */ (e)?.message || e}`,
        'Delete failed'
      );
    }
    await this._refreshList();
  }

  /**
   * Empty the entire bin after a single confirmation.
   * @private
   */
  async _onEmptyBin() {
    if (!this._session) return;
    const confirmed = await showConfirm(
      'Permanently delete every conversation in the bin?\n\nThis cannot be undone.',
      'Empty Bin',
      { confirmText: 'Empty Bin', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return;

    // Optimistically show the emptied state right away. The server now returns
    // as soon as it has moved the bin aside (the actual OS-trash runs in the
    // background), so the request resolves quickly and the user never stares at
    // an untouched list. _refreshList below reconciles with the real state —
    // restoring the list if the request failed.
    const emptyBtn = /** @type {HTMLButtonElement|null} */ (this.querySelector('.bin-empty-now'));
    const list = /** @type {HTMLUListElement|null} */ (this.querySelector('.bin-list'));
    const empty = /** @type {HTMLElement|null} */ (this.querySelector('.bin-empty'));
    if (emptyBtn) {
      emptyBtn.disabled = true;
      emptyBtn.textContent = 'Emptying…';
    }
    if (list) list.innerHTML = '';
    if (empty) {
      empty.classList.remove('hidden');
      empty.textContent = 'The bin is empty.';
    }

    try {
      await this._session.emptyBin();
    } catch (e) {
      console.error('[BinModal] empty bin failed:', e);
      await showAlert(
        `Failed to empty the bin: ${/** @type {any} */ (e)?.message || e}`,
        'Empty Bin failed'
      );
    }
    await this._refreshList();
  }
}

customElements.define('bin-modal', BinModal);

export default BinModal;
