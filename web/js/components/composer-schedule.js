//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-schedule — the composer's scheduled send ("send later"), for
 * composer.js.
 *
 * Clicking the clock button arms a send for later. Two waits are offered:
 *   • delay    — a chosen wall-clock time. The intended use is firing a queued
 *                command the instant the next LLM-provider time slice opens, so
 *                precision is coarse (5-minute granularity).
 *   • turn-end — as soon as the conversation has no turn in flight. Distinct
 *                from just pressing Send mid-turn: that queues the message and
 *                the worker promotes it at the next turn boundary, steering the
 *                run in progress. This one keeps out of the running turn
 *                entirely and opens a fresh one once it has finished.
 * Both are persisted on the thread's draft (an epoch-ms instant plus the mode),
 * so a reload or a conversation switch finds them again.
 *
 * The composer only arms, cancels, and DISPLAYS the schedule; the firing itself
 * is owned by scheduledSendService, which sweeps every thread on an interval so
 * a send goes out even while a different thread or tab is on screen. When the
 * due thread IS on screen the service calls the composer's `_fireScheduledSend`,
 * so the send carries the live textarea's exact contents.
 *
 * Each function takes the Composer element as its first argument and reads or
 * writes its state through it, mirroring conversation-area-rendering.js.
 * @module components/composer-schedule
 */

import scheduledSendService from '../services/scheduled-send-service.js';
import { presentPopup } from '../utils/popup-surface.js';

/**
 * The preset delay chips offered in the scheduled-send picker, tuned to the
 * primary use case: firing a command when the next LLM-provider time slice
 * opens. Minutes only — the picker's steppers cover everything in between.
 * @type {Array<{label: string, minutes: number}>}
 */
const SCHEDULE_PRESETS = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '3h', minutes: 180 },
  { label: '4h', minutes: 240 },
  { label: '5h', minutes: 300 },
];

/** Granularity (minutes) of the scheduled-send picker — no finer than this. */
const SCHEDULE_MINUTE_STEP = 5;

/** Upper bound (hours) on the scheduled-send picker's hours stepper. */
const SCHEDULE_MAX_HOURS = 12;

/**
 * Format a millisecond duration as a compact countdown for the armed clock
 * button: "2h", "1h5m", "45m", or "<1m" once under a minute.
 * @param {number} ms
 * @returns {string} The compact countdown string.
 */
function formatDelayShort(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/**
 * Format an epoch-ms instant as a 24-hour wall-clock "HH:MM" — the absolute
 * time the user is actually aligning to ("sends at 14:35").
 * @param {number} epochMs
 * @returns {string} The 24-hour "HH:MM" wall-clock time.
 */
function formatClockTime(epochMs) {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Stop the countdown-refresh interval WITHOUT touching `_scheduledSendAt` or
 * the persisted draft — the target survives so a later rebind restores it.
 * @param {any} composer - Composer instance
 */
export function stopScheduledCountdown(composer) {
  if (composer._scheduledCountdownId !== null) {
    clearInterval(composer._scheduledCountdownId);
    composer._scheduledCountdownId = null;
  }
}

/**
 * Start (or restart) the coarse interval that refreshes the countdown label.
 * Display only — it never fires the send. The label is recomputed from the
 * absolute target each tick, so a throttled background timer can't make the
 * displayed countdown drift.
 * @param {any} composer - Composer instance
 */
function startScheduledCountdown(composer) {
  stopScheduledCountdown(composer);
  composer._scheduledCountdownId = setInterval(() => updateScheduleButton(composer), 30000);
}

/**
 * Arm a send: record the instant and what it is waiting for, persist both onto
 * the thread's draft, and reflect them on the clock button. A `delay` also
 * starts the countdown label; a `turn-end` wait has nothing to count down, so
 * its instant is only the arming time. scheduledSendService picks the schedule
 * up from the draft.
 * @param {any} composer - Composer instance
 * @param {number} targetAt
 * @param {import('../utils/attachments.js').ScheduledSendMode} mode
 */
function armScheduledSend(composer, targetAt, mode) {
  composer._scheduledSendAt = targetAt;
  composer._scheduledSendMode = mode;
  composer._persistDraft();
  if (mode === 'delay') startScheduledCountdown(composer);
  updateScheduleButton(composer);
  scheduledSendService.refreshArmedState();
}

/**
 * Drop the armed schedule: stop the countdown, forget the target and its mode,
 * repaint the clock button, and have scheduledSendService re-read which
 * conversations still carry a timer (what paints the tab clock).
 *
 * `persist` writes the cleared schedule back to the draft. The box-clearing
 * path leaves it false: the whole draft has just been deleted there, so this is
 * an in-memory reset only — without it the button would stay visually armed and
 * the next keystroke's draft save would re-attach the stale target to a fresh,
 * unrelated draft.
 * @param {any} composer - Composer instance
 * @param {{persist?: boolean}} [options]
 */
export function clearScheduledSendState(composer, { persist = false } = {}) {
  stopScheduledCountdown(composer);
  composer._scheduledSendAt = null;
  composer._scheduledSendMode = 'delay';
  if (persist) composer._persistDraft();
  updateScheduleButton(composer);
  scheduledSendService.refreshArmedState();
}

/**
 * Cancel the pending send and remove it from the persisted draft.
 * @param {any} composer - Composer instance
 */
function cancelScheduledSend(composer) {
  clearScheduledSendState(composer, { persist: true });
}

/**
 * Fire the pending send. Reached from the composer's `_fireScheduledSend`,
 * which scheduledSendService calls when this box is bound to the due thread. Clears the schedule FIRST (and persists that,
 * so an empty box — where sendMessage() no-ops without clearing the draft —
 * doesn't leave the target behind to re-fire on the next sweep), then presses
 * Send on whatever is currently in the box.
 * @param {any} composer - Composer instance
 */
export function fireScheduledSend(composer) {
  clearScheduledSendState(composer, { persist: true });
  composer.sendMessage();
}

/**
 * Re-derive the displayed scheduled-send state from the bound thread's
 * persisted draft. Stops any countdown left over from a previously-bound
 * thread, then restores the target, its mode and (for a delay) its countdown
 * for the newly-bound thread. Firing — including for an already-passed target,
 * or a turn-end wait whose turn has already finished — is left to
 * scheduledSendService. Called after the controls render and on every genuine
 * thread switch.
 * @param {any} composer - Composer instance
 */
export function syncScheduledSendFromDraft(composer) {
  stopScheduledCountdown(composer);
  const draft = composer._messageThread ? composer._messageThread.draft : null;
  const when = draft ? draft.scheduledSendAt : null;
  composer._scheduledSendAt = (typeof when === 'number' && Number.isFinite(when)) ? when : null;
  composer._scheduledSendMode = (composer._scheduledSendAt !== null && draft) ? draft.scheduledSendMode : 'delay';
  if (composer._scheduledSendAt !== null && composer._scheduledSendMode === 'delay') {
    startScheduledCountdown(composer);
  }
  updateScheduleButton(composer);
}

/**
 * Reflect the current scheduled-send state on the clock button: an `armed`
 * class, a live countdown badge, and a tooltip naming the target time.
 *
 * An empty box overrides all of that: arming (or leaving armed) a delayed
 * send with nothing to send would silently fire nothing, so an empty box
 * disables the button and renders it un-armed — WITHOUT clearing
 * `_scheduledSendAt` or the persisted draft. A timer the user already set is
 * only hidden; the moment they type again this runs again and renders it
 * armed with its countdown intact.
 * @param {any} composer - Composer instance
 */
export function updateScheduleButton(composer) {
  const btn = composer.querySelector('.schedule-send-btn');
  if (!btn) return;
  const label = btn.querySelector('.schedule-send-countdown');
  const empty = composer.isEmpty();
  /** @type {HTMLButtonElement} */ (btn).disabled = empty;
  if (composer._scheduledSendAt === null || empty) {
    btn.classList.remove('armed');
    // When a timer is armed but hidden by an empty box, point the user at how
    // to bring it back rather than implying nothing is set.
    btn.setAttribute('title', (empty && composer._scheduledSendAt !== null)
      ? 'Type a message to resume the timer'
      : 'Send later');
    if (label) {
      /** @type {HTMLElement} */ (label).hidden = true;
      label.textContent = '';
    }
    return;
  }
  btn.classList.add('armed');
  const turnEnd = composer._scheduledSendMode === 'turn-end';
  btn.setAttribute('title', turnEnd
    ? 'Sending when this turn ends — click to cancel'
    : `Sending at ${formatClockTime(composer._scheduledSendAt)} — click to change or cancel`);
  if (label) {
    /** @type {HTMLElement} */ (label).hidden = false;
    // A turn-end wait has no countdown — it ends when the turn does — so the
    // badge names the wait instead.
    label.textContent = turnEnd
      ? 'turn'
      : formatDelayShort(Math.max(0, composer._scheduledSendAt - Date.now()));
  }
}

/**
 * Toggle the delay picker: close it if open, otherwise open it.
 * @param {any} composer - Composer instance
 */
export function toggleSchedulePicker(composer) {
  if (composer._schedulePickerCleanup) {
    closeSchedulePicker(composer);
  } else {
    openSchedulePicker(composer);
  }
}

/**
 * Close the delay picker (tears down its popup surface).
 * @param {any} composer - Composer instance
 */
function closeSchedulePicker(composer) {
  if (composer._schedulePickerCleanup) {
    const release = composer._schedulePickerCleanup;
    composer._schedulePickerCleanup = null;
    release();
  }
}

/**
 * Build and present the delay picker, anchored to the clock button (or a
 * bottom sheet on a phone). Two shapes:
 *   • Armed — a single "Cancel timer" button (nothing else to decide).
 *   • Idle — full-width preset chips (15m…5h), hours + 5-minute steppers, one
 *     full-width "Schedule to send at HH:MM" button that both previews the
 *     target time and confirms it, and below them the other wait: "Run at end
 *     of turn", disabled unless a turn is actually running.
 * The picker never edits the textarea.
 * @param {any} composer - Composer instance
 */
function openSchedulePicker(composer) {
  let anchor = /** @type {HTMLElement|null} */ (composer.querySelector('.schedule-send-btn'));
  // On touch the inline clock button is hidden unless a send is armed (it lives
  // in the "⋮" actions sheet), so anchor to the still-visible overflow button
  // when it is not laid out. On a phone the picker is a bottom sheet, where the
  // anchor is moot anyway.
  if (!anchor || anchor.offsetParent === null) {
    anchor = /** @type {HTMLElement|null} */ (composer.querySelector('#more-actions-button')) || anchor;
  }
  if (!anchor) return;

  const menu = document.createElement('div');
  menu.className = 'dropdown-menu schedule-send-menu show';
  menu.id = 'schedule-send-menu';

  const present = () => {
    composer._schedulePickerCleanup = presentPopup({
      surface: menu,
      anchor,
      id: 'schedule-send',
      onClose: () => closeSchedulePicker(composer),
      align: 'right',
      insideSelectors: ['.schedule-send-btn', '.schedule-send-menu'],
    });
  };

  // --- Armed: show what it is waiting for, offer to cancel ----------------
  if (composer._scheduledSendAt) {
    const targetLine = document.createElement('div');
    targetLine.className = 'schedule-armed-target';
    targetLine.textContent = composer._scheduledSendMode === 'turn-end'
      ? 'Sending when this turn ends'
      : `Sending at ${formatClockTime(composer._scheduledSendAt)}`;
    menu.appendChild(targetLine);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'schedule-cancel-btn schedule-cancel-only';
    cancelBtn.textContent = 'Cancel timer';
    cancelBtn.addEventListener('click', () => {
      cancelScheduledSend(composer);
      closeSchedulePicker(composer);
    });
    menu.appendChild(cancelBtn);
    present();
    return;
  }

  // --- Idle: pick a delay -------------------------------------------------
  let hours = 1;
  let minutes = 0;

  const heading = document.createElement('div');
  heading.className = 'schedule-send-heading';
  heading.textContent = 'Send after a delay';
  menu.appendChild(heading);

  // Preset chips — stretch to fill the row.
  const presetRow = document.createElement('div');
  presetRow.className = 'schedule-preset-row';
  menu.appendChild(presetRow);

  // Steppers.
  const steppers = document.createElement('div');
  steppers.className = 'schedule-steppers';
  menu.appendChild(steppers);

  /**
   * @param {string} unitLabel
   * @param {() => number} get
   * @param {(v: number) => void} set
   * @param {number} min
   * @param {number} max
   * @param {number} step
   * @returns {HTMLElement} the value element (for later text updates)
   */
  const buildStepper = (unitLabel, get, set, min, max, step) => {
    const wrap = document.createElement('div');
    wrap.className = 'schedule-stepper';
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'schedule-stepper-btn';
    dec.textContent = '\u2212'; // minus
    dec.setAttribute('aria-label', `Fewer ${unitLabel}`);
    const val = document.createElement('span');
    val.className = 'schedule-stepper-value';
    const unit = document.createElement('span');
    unit.className = 'schedule-stepper-unit';
    unit.textContent = unitLabel;
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'schedule-stepper-btn';
    inc.textContent = '+';
    inc.setAttribute('aria-label', `More ${unitLabel}`);
    dec.addEventListener('click', () => { set(Math.max(min, get() - step)); refresh(); });
    inc.addEventListener('click', () => { set(Math.min(max, get() + step)); refresh(); });
    wrap.append(dec, val, unit, inc);
    steppers.appendChild(wrap);
    return val;
  };

  const hoursValueEl = buildStepper('hr',
    () => hours, (v) => { hours = v; }, 0, SCHEDULE_MAX_HOURS, 1);
  const minutesValueEl = buildStepper('min',
    () => minutes, (v) => { minutes = v; }, 0, 60 - SCHEDULE_MINUTE_STEP, SCHEDULE_MINUTE_STEP);

  // One full-width button that both previews and confirms the target time.
  const actions = document.createElement('div');
  actions.className = 'schedule-actions';
  const scheduleBtn = document.createElement('button');
  scheduleBtn.type = 'button';
  scheduleBtn.className = 'schedule-confirm-btn';
  actions.appendChild(scheduleBtn);
  menu.appendChild(actions);

  const refresh = () => {
    hoursValueEl.textContent = String(hours);
    minutesValueEl.textContent = String(minutes).padStart(2, '0');
    const totalMin = hours * 60 + minutes;
    if (totalMin <= 0) {
      scheduleBtn.textContent = 'Pick a delay above';
      scheduleBtn.disabled = true;
    } else {
      scheduleBtn.disabled = false;
      scheduleBtn.textContent = `Schedule to send at ${formatClockTime(Date.now() + totalMin * 60000)}`;
    }
  };

  for (const preset of SCHEDULE_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'schedule-preset';
    chip.textContent = preset.label;
    chip.addEventListener('click', () => {
      hours = Math.min(SCHEDULE_MAX_HOURS, Math.floor(preset.minutes / 60));
      minutes = preset.minutes % 60;
      refresh();
    });
    presetRow.appendChild(chip);
  }

  scheduleBtn.addEventListener('click', () => {
    const totalMin = hours * 60 + minutes;
    if (totalMin <= 0) return;
    armScheduledSend(composer, Date.now() + totalMin * 60000, 'delay');
    closeSchedulePicker(composer);
  });

  // The other wait: hold the message back until the running turn is done. Live
  // only while a turn IS running — with nothing in flight the wait is already
  // over, so arming it would just be a roundabout Send.
  const conversation = composer._messageThread ? composer._messageThread.conversation : null;
  const turnRunning = !!conversation && conversation.isTurnActive();
  const turnEndBtn = document.createElement('button');
  turnEndBtn.type = 'button';
  turnEndBtn.className = 'schedule-turn-end-btn';
  turnEndBtn.textContent = 'Run at end of turn';
  turnEndBtn.disabled = !turnRunning;
  turnEndBtn.title = turnRunning
    ? 'Wait for the current turn to finish, then send — the running turn is left alone'
    : 'Nothing is running';
  turnEndBtn.addEventListener('click', () => {
    armScheduledSend(composer, Date.now(), 'turn-end');
    closeSchedulePicker(composer);
  });
  menu.appendChild(turnEndBtn);

  refresh();
  present();
}
