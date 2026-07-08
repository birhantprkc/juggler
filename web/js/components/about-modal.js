//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { markPopupOpen } from '../utils/popup-manager.js';
import { wireExternalLinks } from '../utils/external-links.js';

/**
 * AboutModal - Shows information about the application
 *
 * Opens when clicking the logo in the header. Displays app name, version,
 * and a brief description with a link to the website.
 */
class AboutModal extends HTMLElement {
  constructor() {
    super();
    /** @type {boolean} @private */
    this._isOpen = false;
    /** @type {string} @private */
    this._version = '';
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {(() => void)|null} @private */
    this._logoClickHandler = null;
  }

  connectedCallback() {
    this.render();
    this._setupLogoClick();
  }

  disconnectedCallback() {
    if (this._logoClickHandler) {
      this._logoClickHandler();
      this._logoClickHandler = null;
    }
  }

  /**
   * Set up click handler on the logo
   * @private
   */
  _setupLogoClick() {
    const logo = /** @type {HTMLElement|null} */ (document.querySelector('.logo'));
    if (logo) {
      let dragged = false;
      const onPointerDown = (/** @type {Event} */ e) => {
        dragged = false;
        const startX = /** @type {PointerEvent} */ (e).screenX;
        const startY = /** @type {PointerEvent} */ (e).screenY;
        const onMove = (/** @type {Event} */ m) => {
          const mm = /** @type {PointerEvent} */ (m);
          if (Math.abs(mm.screenX - startX) > 4 || Math.abs(mm.screenY - startY) > 4) dragged = true;
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', () => document.removeEventListener('pointermove', onMove), { once: true });
      };
      const onClick = () => { if (!dragged) this.open(); };
      logo.addEventListener('pointerdown', onPointerDown);
      logo.addEventListener('click', onClick);
      this._logoClickHandler = () => {
        logo.removeEventListener('pointerdown', onPointerDown);
        logo.removeEventListener('click', onClick);
      };
    }
  }

  /**
   * Fetch version from the API
   * @private
   * @returns {Promise<string>} The version string or 'Unknown' on error
   */
  async _fetchVersion() {
    try {
      const response = await fetch('/api/version');
      if (!response.ok) return 'Unknown';
      const data = await response.json();
      return data.version || 'Unknown';
    } catch (error) {
      console.warn('[AboutModal] Failed to fetch version:', error);
      return 'Unknown';
    }
  }

  /**
   * Open the about modal
   */
  async open() {
    // Fetch version if not already loaded
    if (!this._version) {
      this._version = await this._fetchVersion();
    }

    this._isOpen = true;
    this.render();

    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this._close());
    }
  }

  /**
   * Close the about modal
   * @private
   */
  _close() {
    this._isOpen = false;
    this.render();

    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
  }

  /** @private */
  render() {
    if (!this._isOpen) {
      this.innerHTML = '';
      return;
    }

    this.innerHTML = `
            <modal-backdrop class="about-backdrop"></modal-backdrop>
            <modal-panel class="about-container">
                <header class="about-header">
                    <div class="about-logo"></div>
                    <span class="about-version">${this._version}</span>
                </header>

                <main class="about-content">
                    <p class="about-description">
                        A plugin-powered visual AI coding agent.
                    </p>
                    <p class="about-description">
                        Created in a moment of madness by <a href="https://github.com/julianstorer" target="_blank" rel="noopener noreferrer" style="white-space: nowrap">Julian Storer</a>
                    </p>
                    <p class="about-description">
                      Juggler is still in beta, and I'd love to hear people's opinions about it -
                      please visit the discord group to chat or hear more about the roadmap!
                    </p>
                    <p class="about-link">
                        <a href="https://juggler.studio" target="_blank" rel="noopener noreferrer">https://juggler.studio</a>
                    </p>
                    <p class="about-link">
                        <a href="https://discord.gg/HyqZwKvSMd" target="_blank" rel="noopener noreferrer">Click here to join the discord server</a>
                    </p>
                </main>

                <footer class="about-footer">
                    <button class="about-button primary" id="about-close">
                        Close
                    </button>
                </footer>
            </modal-panel>
        `;

    // Attach event listeners
    const backdrop = this.querySelector('.about-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this._close());
    }

    const closeButton = this.querySelector('#about-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => this._close());
      // Focus the close button
      setTimeout(() => /** @type {HTMLElement} */ (closeButton).focus(), 100);
    }

    // External links route via the loopback opener (see wireExternalLinks).
    wireExternalLinks(this);
  }
}

customElements.define('about-modal', AboutModal);
