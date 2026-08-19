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
 * for hours. Counting that gap would put the overlay on its last line the
 * instant the machine woke, before a single retry had been given the chance to
 * fail. A gap longer than this is time the page wasn't running, so it doesn't
 * count.
 * @type {number}
 */
const MAX_TICK_MS = 2000;

/**
 * The line the overlay opens on, before any tier is reached. Deliberately the
 * plainest thing that is true: most drops are a blip that recovers on its own,
 * and the wording for a wait that has gone wrong is worth having only when the
 * wait actually has.
 * @type {string}
 */
const OPENING_LINE = 'Reconnecting.';

/**
 * Wording for the wait as it drags on, mild to resigned, ordered longest wait
 * first. Each threshold is time the previous line spent in view (see
 * {@link DisconnectionOverlay._tick}), so every rung is one somebody has read
 * before the next one replaces it.
 * @type {ReadonlyArray<{afterMs: number, line: string}>}
 */
const MESSAGE_TIERS = Object.freeze([
  { afterMs: 8 * 60 * 1000, line: 'This isn’t going very well.' },
  { afterMs: 3 * 60 * 1000, line: 'Still trying.' },
  { afterMs: 60 * 1000, line: 'Lost the server.' },
  { afterMs: 20 * 1000, line: 'Still reconnecting.' },
]);

/**
 * Wording for the wait, restated as it drags on.
 * @param {number} waitedMs - Time spent waiting for the connection to return.
 * @returns {string} The line to show.
 */
function messageForWait(waitedMs) {
  const tier = MESSAGE_TIERS.find((candidate) => waitedMs >= candidate.afterMs);
  return tier ? tier.line : OPENING_LINE;
}

/**
 * Whether the page is hidden, and so painting nothing anyone can read: a
 * background tab, a minimised or fully occluded window, a locked phone.
 *
 * `data-doc-hidden` is the app's own signal (see App._initDocumentVisibilityPause),
 * and it is the one to trust on macOS, where a Cmd-Tab back to the window fires
 * window `focus` but NOT `visibilitychange` — the app clears the attribute on
 * `focus` for exactly that reason. `document.hidden` is consulted too so this
 * still works in a page where nothing maintains the attribute. Being wrong in
 * the hidden direction only makes the wording escalate slower, which is the
 * side to be wrong on.
 * @returns {boolean} True when nothing on this page is being read.
 */
function pageHidden() {
  return document.documentElement.hasAttribute('data-doc-hidden') || document.hidden;
}

/**
 * DisconnectionOverlay
 *
 * Full-page overlay shown when WebSocket connection is lost. For the first few
 * seconds it shows only the Juggler spinner; after that it reveals a message
 * describing the wait, the retry countdown, and the server URL it is trying to
 * reach. The message restates itself as the wait grows (see
 * {@link MESSAGE_TIERS}) and the countdown ticks on its own line, so neither
 * overwrites the other.
 *
 * Both the grace period and the wording run off time this page spent waiting
 * IN VIEW — not wall-clock elapsed, and not time it spent hidden. Time the page
 * wasn't running at all is excluded by {@link MAX_TICK_MS}; time it was running
 * but hidden is excluded by {@link pageHidden}. Hidden pages matter as much as
 * suspended ones here: a browser clamps a background tab's timers to about once
 * a second, which is the tick period, so an unwatched tab accrues the wait at
 * very nearly full speed. Left to count, a two-minute tab switch meant the
 * overlay revealed itself on its last line, having silently burned through the
 * lines that lead up to it. Nothing escalates until the line before it has been
 * on screen, in front of someone, for its full turn.
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
    /** @type {number} @private Time spent waiting while the page was in view. */
    this._waitedMs = 0;
    /** @type {number} @private When the wait was last advanced. */
    this._lastTickAt = 0;
    /** @type {boolean} @private Whether the page went hidden since the last tick. */
    this._hiddenSinceTick = false;
    /** @type {(() => void)|null} @private Watches for the page going hidden. */
    this._visibilityListener = null;
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
    this._hiddenSinceTick = false;

    // A tick only counts if the page was in view for the WHOLE interval, so a
    // page that hid and came back between two ticks must be caught as it goes.
    // This reads `document.hidden` rather than pageHidden(): the app toggles
    // `data-doc-hidden` from this same event, and listener order between the
    // two is not ours to assume.
    this._visibilityListener = () => {
      if (document.hidden) this._hiddenSinceTick = true;
    };
    document.addEventListener('visibilitychange', this._visibilityListener);

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
    if (this._visibilityListener) {
      document.removeEventListener('visibilitychange', this._visibilityListener);
      this._visibilityListener = null;
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
   * Advance the wait by the part of this interval someone could actually have
   * been reading the overlay, then reveal the info block once the spinner-only
   * grace period has passed and keep its wording current.
   * @private
   */
  _tick() {
    const now = Date.now();
    const sinceLastTick = Math.min(now - this._lastTickAt, MAX_TICK_MS);
    this._lastTickAt = now;

    // Unseen time isn't waiting: it buys no escalation, and there is nothing to
    // restate on a page nobody is looking at. Anything after this line only
    // happens on a page in view.
    const wasHidden = this._hiddenSinceTick || pageHidden();
    this._hiddenSinceTick = false;
    if (wasHidden) return;

    this._waitedMs += sinceLastTick;

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
