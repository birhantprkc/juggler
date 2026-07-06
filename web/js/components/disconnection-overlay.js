//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Duration to show only the spinner before surfacing the
 * "Reconnecting..." message. Immediately announcing a lost connection
 * is alarming for the brief WS blips that recover on their own.
 * @type {number}
 */
const SPINNER_ONLY_MS = 5000;

/**
 * DisconnectionOverlay
 *
 * Full-page overlay shown when WebSocket connection is lost. For the
 * first few seconds it shows only the Juggler spinner; after that it
 * reveals a "Reconnecting..." message with the retry countdown and the
 * server URL it is trying to reach.
 */
class DisconnectionOverlay {
  constructor() {
    /** @type {HTMLElement|null} @private */
    this._element = null;
    /** @type {HTMLElement|null} @private */
    this._infoElement = null;
    /** @type {HTMLElement|null} @private */
    this._messageElement = null;
    /** @type {number|null} @private */
    this._countdownInterval = null;
    /** @type {number|null} @private */
    this._revealTimeout = null;
  }

  /**
   * Show the overlay
   */
  show() {
    if (this._element) {
      return; // Already showing
    }

    this._element = document.createElement('div');
    this._element.className = 'disconnection-overlay';
    this._element.innerHTML = `
            <div class="disconnection-overlay__content">
                <juggler-spinner style="--size: 3rem"></juggler-spinner>
                <div class="disconnection-overlay__info">
                    <div class="disconnection-overlay__message">Reconnecting...</div>
                    <div class="disconnection-overlay__url"></div>
                </div>
            </div>
        `;

    this._infoElement = this._element.querySelector('.disconnection-overlay__info');
    this._messageElement = this._element.querySelector('.disconnection-overlay__message');
    const urlElement = this._element.querySelector('.disconnection-overlay__url');
    if (urlElement) {
      urlElement.textContent = globalThis.location.host;
    }

    // Mount inside <app-container>, NOT <body>. app-container is position:fixed,
    // which forms a stacking context, so anything inside it (the Windows caption
    // min/max/close buttons) can never paint above a sibling of app-container.
    // A body-level overlay therefore covers the only way to close the frameless
    // Windows window. Mounting here puts the overlay in app-container's stacking
    // context, where the caption controls' higher z-index (--z-above-modal vs
    // the overlay's --z-modal) keeps them clickable. Falls back to body if the
    // container isn't present (it always is in the viewer UI that shows this).
    const host = document.querySelector('app-container') || document.body;
    host.appendChild(this._element);

    // The info block is always laid out (reserving its space so nothing
    // shifts); it's only kept invisible during the spinner-only grace
    // period and faded in afterwards.
    this._revealTimeout = window.setTimeout(() => {
      this._revealTimeout = null;
      if (this._infoElement) {
        this._infoElement.classList.add('disconnection-overlay__info--visible');
      }
    }, SPINNER_ONLY_MS);
  }

  /**
   * Hide the overlay and clear any countdown
   */
  hide() {
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
    if (this._revealTimeout) {
      clearTimeout(this._revealTimeout);
      this._revealTimeout = null;
    }
    if (this._element) {
      this._element.remove();
      this._element = null;
      this._infoElement = null;
      this._messageElement = null;
    }
  }

  /**
   * Start a countdown showing "Retrying in X seconds..."
   * @param {number} delayMs - Delay in milliseconds until next retry
   */
  startCountdown(delayMs) {
    // Clear any existing countdown
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
    }

    let secondsRemaining = Math.ceil(delayMs / 1000);

    // Only show a number when there's an actual multi-second wait;
    // anything imminent just reads "Retrying...".
    const updateMessage = () => {
      if (this._messageElement) {
        this._messageElement.textContent =
          secondsRemaining > 1 ? `Reconnecting in ${secondsRemaining} seconds...` : 'Reconnecting...';
      }
    };

    // Show initial countdown
    updateMessage();

    // Update every second
    this._countdownInterval = window.setInterval(() => {
      secondsRemaining--;
      if (secondsRemaining <= 0) {
        if (this._countdownInterval) {
          clearInterval(this._countdownInterval);
          this._countdownInterval = null;
        }
        if (this._messageElement) {
          this._messageElement.textContent = 'Reconnecting...';
        }
      } else {
        updateMessage();
      }
    }, 1000);
  }
}

export default DisconnectionOverlay;
