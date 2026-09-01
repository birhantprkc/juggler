//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { createElement, extractErrorMessage, injectStylesOnce } from 'juggler/ui';
import { reconcileParts, reconcileRows, setText } from '../lib/reconcile.js';

injectStylesOnce('tasks-pin-styles', `
.tasks-pin {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
}
.tasks-pin__list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.tasks-pin__row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.tasks-pin__open {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.25rem;
  border: none;
  border-radius: var(--radius-md, 0.25rem);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tasks-pin__open:hover {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}
.tasks-pin__open:focus-visible,
.tasks-pin__stop:focus-visible {
  outline: 0.125rem solid var(--accent-blue);
  outline-offset: 0.125rem;
}
.tasks-pin__command {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tasks-pin__label {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tasks-pin__elapsed {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}
.tasks-pin__stop {
  flex-shrink: 0;
  padding: 0.25rem 0.5rem;
  border: 0.0625rem solid var(--border-color);
  border-radius: var(--radius-md, 0.25rem);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.tasks-pin__stop:hover:not(:disabled) {
  border-color: var(--error-color, var(--border-color));
  color: var(--error-color, var(--text-primary));
}
.tasks-pin__stop:disabled {
  cursor: default;
  opacity: 0.5;
}
.tasks-pin__empty,
.tasks-pin__note {
  color: var(--text-tertiary);
}
.tasks-pin__error {
  color: var(--error-color, var(--text-secondary));
  overflow-wrap: anywhere;
}
.tasks-pin__note {
  margin-top: auto;
  font-size: var(--font-size-sm);
}
`);

/** How much of a command line to show before it is cut short. */
const COMMAND_LIMIT = 160;

/**
 * How often the elapsed times are redrawn. The host speaks only when the set of
 * running tasks changes, which for a build that has been going for ten minutes is
 * never — so a clock of the pin's own is what keeps "10m" from being a stopped
 * one. It writes nothing but those words.
 */
const ELAPSED_TICK_MS = 1000;

/**
 * How long a task has been running, in the coarsest unit that still says
 * something. Seconds below a minute, then minutes, then hours: nobody watching a
 * two-hour build needs it to the second.
 * @param {number} startedAt - Unix ms the task started.
 * @param {number} now - Unix ms now.
 * @returns {string} An elapsed time, or '' when the start time is not known yet.
 */
function elapsed(startedAt, now) {
  if (!Number.isFinite(startedAt)) return '';
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One task's row: what it is running, what it was for, how long it has been at
 * it, and the way to stop it.
 *
 * The row is keyed by task id, so the id the Stop button hands back is the same
 * id the row was built for however long it stands. The action to reveal is
 * carried on the row and read at click time, so nothing here can outlive what it
 * points at.
 * @param {import('juggler/pinboard-item-type').PinTask} task - The running task.
 * @param {(itemId: string) => void} reveal - Go to the action that started it.
 * @param {(taskId: string, button: HTMLButtonElement) => void} stop - Stop it.
 * @returns {HTMLElement} The row.
 */
function buildTaskRow(task, reveal, stop) {
  const row = createElement('div', 'tasks-pin__row');
  const taskId = task.taskId;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'tasks-pin__open';
  open.appendChild(createElement('span', 'tasks-pin__command'));
  open.addEventListener('click', () => reveal(row.dataset.itemId || ''));

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'tasks-pin__stop';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => stop(taskId, stopBtn));

  row.append(open, stopBtn);
  return row;
}

/**
 * Write one task's current words into its row.
 * @param {HTMLElement} row - The row for this task.
 * @param {import('juggler/pinboard-item-type').PinTask} task - The running task.
 * @param {number} now - Unix ms, so every row in one render agrees on the time.
 * @returns {void}
 */
function fillTaskRow(row, task, now) {
  const open = /** @type {HTMLElement} */ (row.firstElementChild);
  const stopBtn = /** @type {HTMLElement} */ (row.lastElementChild);
  const name = task.command || task.toolName;

  if (row.dataset.itemId !== task.itemId) row.dataset.itemId = task.itemId;
  // The tick reads the start time from here, so it can redraw an elapsed time
  // without the task list in front of it.
  if (row.dataset.at !== String(task.at)) row.dataset.at = String(task.at);

  const reveals = `Reveal the action that started ${name}`;
  if (open.getAttribute('aria-label') !== reveals) open.setAttribute('aria-label', reveals);
  const stops = `Stop ${name}`;
  if (stopBtn.getAttribute('aria-label') !== stops) stopBtn.setAttribute('aria-label', stops);

  setText(
    /** @type {HTMLElement} */ (open.querySelector('.tasks-pin__command')),
    name.length > COMMAND_LIMIT ? `${name.slice(0, COMMAND_LIMIT)}…` : name
  );

  const elapsedEl = open.querySelector('.tasks-pin__elapsed');
  const label = open.querySelector('.tasks-pin__label');
  if (task.label) {
    // The label sits between the command and the elapsed time, so one arriving
    // after the clock has started goes in front of it.
    if (label) setText(/** @type {HTMLElement} */ (label), task.label);
    else open.insertBefore(createElement('span', 'tasks-pin__label', task.label), elapsedEl);
  } else if (label) {
    label.remove();
  }

  const since = elapsed(task.at, now);
  if (since) {
    if (elapsedEl) setText(/** @type {HTMLElement} */ (elapsedEl), since);
    else open.appendChild(createElement('span', 'tasks-pin__elapsed', since));
  } else if (elapsedEl) {
    elapsedEl.remove();
  }
}

/**
 * TasksPin — the background tasks this conversation has running.
 *
 * A live inventory, and only that. A task appears when it starts and is gone the
 * moment it ends, whether it finished, failed or was stopped — so there is no
 * retention to configure and nothing to clear. Its history is not lost by being
 * absent from here: it is on the tool action that started it, which is where the
 * output, the exit code and the approval already live, and which is exactly where
 * a row goes when clicked.
 *
 * That division is also why the pin shows no output of its own. A running
 * command's output can hold anything the command touched, and the tool action
 * already displays it under rules that already exist; a second copy on a board
 * that may be open in another window would be a new place for it to appear and no
 * new way to read it.
 *
 * It lists tasks, not processes. A shell command that daemonised something, or
 * anything started outside Juggler, is not here and cannot be — nothing ties a
 * process on this machine to a conversation unless Juggler started it as a task.
 * @class
 * @augments PinboardItemType
 */
class TasksPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'tasks',
    name: 'Background tasks',
    version: '1.0.0',
    description: 'Lists the background tasks this conversation is running',
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a conversation whose tasks to list.
   */
  canAdd(active) {
    return active?.conversation ? true : 'No active conversation';
  }

  /**
   * The name, and nothing else. Which conversation these tasks belong to is the
   * board's business rather than this pin's: every pin on a board reads the same
   * conversation, so naming it here would be one tab's answer to a question the
   * whole board shares.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words.
   */
  describe() {
    return { title: this.name };
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'tasks-pin');
    container.replaceChildren(body);

    /** The last stop attempt's complaint, cleared by the next render that succeeds. */
    let stopError = '';

    /**
     * @param {string} taskId - The task to stop.
     * @param {HTMLButtonElement} button - Its Stop control, dimmed while the stop is in flight.
     */
    const stop = (taskId, button) => {
      button.disabled = true;
      Promise.resolve(context.services.tasks.stop(taskId))
        .then(() => {
          stopError = '';
        })
        .catch((err) => {
          stopError = extractErrorMessage(err);
          render();
        });
    };

    /**
     * @param {string} itemId - The action to go to.
     * @returns {void}
     */
    const reveal = (itemId) => context.services.tasks.reveal(itemId);

    /** @type {ReturnType<typeof setInterval>|null} The elapsed-time clock, while anything is running. */
    let ticker = null;

    /**
     * Redraw the elapsed times, and only those. Every other word on a row comes
     * from the task list, which has not been read again.
     * @returns {void}
     */
    const tick = () => {
      const now = Date.now();
      for (const row of Array.from(body.querySelectorAll('.tasks-pin__row'))) {
        const el = row.querySelector('.tasks-pin__elapsed');
        if (!el) continue;
        setText(/** @type {HTMLElement} */ (el), elapsed(Number(/** @type {HTMLElement} */ (row).dataset.at), now));
      }
    };

    /** @returns {void} */
    const stopClock = () => {
      if (ticker === null) return;
      clearInterval(ticker);
      ticker = null;
    };

    /** @returns {void} */
    const startClock = () => {
      if (ticker === null) ticker = setInterval(tick, ELAPSED_TICK_MS);
    };

    const render = () => {
      const tasks = context.services.tasks.list();
      const error = context.services.tasks.error();
      const now = Date.now();

      /** @type {import('../lib/reconcile.js').PartSpec[]} */
      const parts = [];

      if (!tasks || !tasks.length) {
        // A null list is not the same as an empty one, and saying "nothing
        // running" before anything has been asked would be a guess.
        const words = tasks === null ? 'Looking…' : 'Nothing running.';
        parts.push({
          key: 'empty',
          build: () => createElement('div', 'tasks-pin__empty'),
          fill: (el) => setText(el, words),
        });
      } else {
        parts.push({
          key: 'list',
          build: () => createElement('div', 'tasks-pin__list'),
          fill: (el) => reconcileRows(
            el,
            tasks,
            (task) => task.taskId,
            (task) => buildTaskRow(task, reveal, stop),
            (row, task) => fillTaskRow(row, task, now)
          ),
        });
      }

      // Both failures keep the list beside them: a check that failed does not
      // mean the tasks stopped, and a stop that failed does not mean the list is
      // wrong. The underlying text is shown as it came back.
      if (error) {
        parts.push({
          key: 'error',
          build: () => createElement('div', 'tasks-pin__error'),
          fill: (el) => setText(el, `Couldn't check what's running. ${error}`),
        });
      }
      if (stopError) {
        parts.push({
          key: 'stop-error',
          build: () => createElement('div', 'tasks-pin__error'),
          fill: (el) => setText(el, `Couldn't stop it. ${stopError}`),
        });
      }

      // Always present, because it is what the list means rather than a remark
      // about it: the title says these are background tasks, but not whose, and
      // without that "Nothing running" reads as the whole machine.
      parts.push({
        key: 'note',
        build: () => createElement('div', 'tasks-pin__note'),
        fill: (el) => setText(el, 'Only what this conversation started, and only while it runs.'),
      });
      reconcileParts(body, parts);

      // Nothing on screen has an elapsed time to keep, so nothing is counting.
      if (tasks && tasks.length) startClock();
      else stopClock();
    };

    const stopWatching = context.services.tasks.onChange(render);
    render();

    return {
      update: (next) => {
        context = next;
        render();
      },
      teardown: () => {
        stopClock();
        stopWatching();
      },
    };
  }
}

export default TasksPin;
