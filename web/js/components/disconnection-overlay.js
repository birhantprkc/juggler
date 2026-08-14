//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Duration to show only the spinner before surfacing the message. Immediately
 * announcing a lost connection is alarming for the brief WS blips that recover
 * on their own.
 * @type {number}
 */
const SPINNER_ONLY_MS = 5000;

/**
 * Wording for the wait, restated as it drags on.
 * @param {number} elapsedMs - How long the overlay has been up.
 * @returns {string} The line to show.
 */
function messageForWait(elapsedMs) {
  if (elapsedMs >= 2 * 60 * 1000) return 'This isn’t going very well.';
  if (elapsedMs >= 30 * 1000) return 'Still trying.';
  return 'Lost the server.';
}

/**
 * DisconnectionOverlay
 *
 * Full-page overlay shown when WebSocket connection is lost. For the first few
 * seconds it shows only the Juggler spinner; after that it reveals a message
 * describing the wait, the retry countdown, and the server URL it is trying to
 * reach. The message restates itself as the wait grows (see
 * {@link messageForWait}) and the countdown ticks on its own line, so neither
 * overwrites the other.
 */
class DisconnectionOverlay {
  constructor() {
    /** @type {HTMLElement|null} @private */
    this._element = null;
    /** @type {HTMLElement|null} @private */
    this._infoElement = null;
    /** @type {HTMLElement|null} @private */
    this._messageElement = null;
    /** @type {HTMLElement|null} @private */
    this._countdownElement = null;
    /** @type {number|null} @private */
    this._countdownInterval = null;
    /** @type {number|null} @private */
    this._revealTimeout = null;
    /** @type {number|null} @private Drives the message through its tiers. */
    this._messageTimer = null;
    /** @type {number} @private When the overlay went up, for wording selection. */
    this._shownAt = 0;
  }

  /**
   * Show the overlay
   */
  show() {
    if (this._element) {
      return; // Already showing
    }

    this._shownAt = Date.now();

    this._element = document.createElement('div');
    this._element.className = 'disconnection-overlay';
    this._element.innerHTML = `
            <div class="disconnection-overlay__content">
                <juggler-spinner style="--size: 3rem"></juggler-spinner>
                <div class="disconnection-overlay__info">
                    <div class="disconnection-overlay__message">${messageForWait(0)}</div>
                    <div class="disconnection-overlay__countdown"></div>
                    <div class="disconnection-overlay__url"></div>
                </div>
            </div>
        `;

    this._infoElement = this._element.querySelector('.disconnection-overlay__info');
    this._messageElement = this._element.querySelector('.disconnection-overlay__message');
    this._countdownElement = this._element.querySelector('.disconnection-overlay__countdown');
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
      if (!this._infoElement) return;
      this._updateMessage();
      this._infoElement.classList.add('disconnection-overlay__info--visible');
      this._messageTimer = window.setInterval(() => this._updateMessage(), 1000);
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
    if (this._messageTimer) {
      clearInterval(this._messageTimer);
      this._messageTimer = null;
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
      this._countdownElement = null;
    }
  }

  /**
   * Write the wording for the current wait into the message line.
   * @private
   */
  _updateMessage() {
    if (!this._messageElement) return;
    this._messageElement.textContent = messageForWait(Date.now() - this._shownAt);
  }

  /**
   * Start a countdown to the next retry, on its own line below the message.
   * @param {number} delayMs - Delay in milliseconds until next retry
   */
  startCountdown(delayMs) {
    // Clear any existing countdown
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
    }

    let secondsRemaining = Math.ceil(delayMs / 1000);

    // Only show a number when there's an actual multi-second wait; anything
    // imminent leaves the line blank rather than flashing "1s".
    const updateCountdown = () => {
      if (this._countdownElement) {
        this._countdownElement.textContent =
          secondsRemaining > 1 ? `Retrying in ${secondsRemaining}s` : '';
      }
    };

    // Show initial countdown
    updateCountdown();

    // Update every second
    this._countdownInterval = window.setInterval(() => {
      secondsRemaining--;
      if (secondsRemaining <= 0) {
        if (this._countdownInterval) {
          clearInterval(this._countdownInterval);
          this._countdownInterval = null;
        }
        if (this._countdownElement) {
          this._countdownElement.textContent = '';
        }
      } else {
        updateCountdown();
      }
    }, 1000);
  }
}

export default DisconnectionOverlay;
