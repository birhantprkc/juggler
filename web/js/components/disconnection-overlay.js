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
 * How often the wait is advanced.
 * @type {number}
 */
const TICK_MS = 1000;

/**
 * Longest gap between ticks that counts as time spent waiting. The wait is
 * accumulated tick by tick rather than measured against the wall clock because
 * the page can stop running: a suspended laptop drops the link and then freezes
 * for hours, and a hidden tab has its timers throttled to once a minute.
 * Counting that gap put the overlay on its last line the instant the machine
 * woke, before a single retry had been given the chance to fail. A gap longer
 * than this is time the page wasn't running, so it doesn't count.
 * @type {number}
 */
const MAX_TICK_MS = 2000;

/**
 * Wording for the wait, restated as it drags on.
 * @param {number} waitedMs - Time spent waiting for the connection to return.
 * @returns {string} The line to show.
 */
function messageForWait(waitedMs) {
  if (waitedMs >= 2 * 60 * 1000) return 'This isn’t going very well.';
  if (waitedMs >= 30 * 1000) return 'Still trying.';
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
 * overwrites the other. Both the grace period and the wording run off time the
 * page actually spent waiting, not wall-clock elapsed (see {@link MAX_TICK_MS}).
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
    /** @type {number|null} @private Drives the reveal and the message tiers. */
    this._waitTimer = null;
    /** @type {number} @private Time spent waiting while the page was running. */
    this._waitedMs = 0;
    /** @type {number} @private When the wait was last advanced. */
    this._lastTickAt = 0;
  }

  /**
   * Show the overlay
   */
  show() {
    if (this._element) {
      return; // Already showing
    }

    this._waitedMs = 0;
    this._lastTickAt = Date.now();

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

    this._waitTimer = window.setInterval(() => this._tick(), TICK_MS);
  }

  /**
   * Hide the overlay and clear any countdown
   */
  hide() {
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
    if (this._waitTimer) {
      clearInterval(this._waitTimer);
      this._waitTimer = null;
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
   * Advance the wait, then reveal the info block once the spinner-only grace
   * period has passed and keep its wording current.
   * @private
   */
  _tick() {
    const now = Date.now();
    this._waitedMs += Math.min(now - this._lastTickAt, MAX_TICK_MS);
    this._lastTickAt = now;

    // The info block is always laid out (reserving its space so nothing
    // shifts); it's only kept invisible during the grace period.
    if (this._waitedMs < SPINNER_ONLY_MS || !this._infoElement) return;
    if (this._messageElement) {
      this._messageElement.textContent = messageForWait(this._waitedMs);
    }
    this._infoElement.classList.add('disconnection-overlay__info--visible');
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
