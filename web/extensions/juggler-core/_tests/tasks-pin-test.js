//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tasks pin tests — what the board says this conversation is running.
 *
 * Mounted with a hand-built PinContext whose `tasks` service the test drives, so
 * a case states what is running rather than arranging for it; the host half —
 * which tool actions are tasks, and joining them to what is actually alive — is
 * asserted against real models in `unit:pinboard-tasks`.
 *
 * Two things here are asserted as the features they are rather than as details.
 * The first is that "still looking" and "nothing running" are different states:
 * collapsing them would make the pin claim, every time it mounts, that nothing is
 * running. The second is that no case anywhere in this file can find a task's
 * output in the body, because the pin deliberately has none.
 * @module _tests/tasks-pin-test
 */

import TasksPin from '../pins/tasks-pin.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Tasks pin tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  /**
   * Wait for a condition rather than for a duration: the pin re-renders off a
   * promise, and a fixed delay is either a flake or a waste.
   * @param {() => boolean} condition - What must become true.
   * @param {string} what - Named in the failure, so a timeout says what never happened.
   * @returns {Promise<void>} Resolves once it holds.
   */
  async function waitFor(condition, what) {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const pin = new TasksPin();

  let nextId = 0;

  /**
   * One running task, as the host's tasks service reports one.
   * @param {string} command - What it is running.
   * @param {object} [overrides] - What this case cares about.
   * @returns {any} The task.
   */
  const task = (command, overrides = {}) => ({
    taskId: `bg-${++nextId}`,
    itemId: `item_${nextId}`,
    threadId: null,
    toolName: 'bash',
    command,
    label: '',
    at: Date.now() - 5000,
    ...overrides,
  });

  /**
   * Mount the pin against a canned task list.
   * @param {any[]|null} list - What `tasks.list` should return, or null for "not asked yet".
   * @param {object} [options] - Failure levers.
   * @param {string} [options.error] - What `tasks.error` should report.
   * @param {Error} [options.stopFails] - Make `tasks.stop` reject with this.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(list, options = {}) {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {(() => void)[]} */
    const listeners = [];
    /** @type {string[]} */
    const revealed = [];
    /** @type {string[]} */
    const stopped = [];
    let current = list;
    let error = options.error || '';

    const services = {
      files: { onChange: () => () => {} },
      contextItems: { find: () => null, onChange: () => () => {}, reveal: () => {} },
      git: { status: () => null, error: () => '', onChange: () => () => {}, refresh: async () => {} },
      fileEdits: { list: () => [], onChange: () => () => {}, reveal: () => {} },
      tasks: {
        /** @returns {any[]|null} The running tasks. */
        list: () => current,
        /** @returns {string} The last check's failure. */
        error: () => error,
        /**
         * @param {() => void} listener - Called on a change.
         * @returns {() => void} Unsubscribe.
         */
        onChange: (listener) => {
          listeners.push(listener);
          return () => {
            const at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          };
        },
        /**
         * @param {string} itemId - The action to reveal.
         * @returns {number} Ignored; push's return value.
         */
        reveal: (itemId) => revealed.push(itemId),
        /**
         * @param {string} taskId - The task to stop.
         * @returns {Promise<void>} Resolves, or rejects when the case says so.
         */
        stop: async (taskId) => {
          stopped.push(taskId);
          if (options.stopFails) throw options.stopFails;
        },
      },
    };

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'tasks', config: {} },
      active: {
        project: { path: '/tmp/proj', displayName: 'proj' },
        conversation: { id: 'c1', title: 'Fix the parser' },
        thread: { id: null },
      },
      services,
      signal: abort.signal,
      updateConfig: async () => {},
    })));

    return {
      body,
      controller,
      services,
      revealed,
      stopped,
      text: () => body.textContent || '',
      rows: () => [...body.querySelectorAll('.tasks-pin__row')],
      stopButtons: () => /** @type {HTMLButtonElement[]} */ ([...body.querySelectorAll('.tasks-pin__stop')]),
      openButtons: () => /** @type {HTMLButtonElement[]} */ ([...body.querySelectorAll('.tasks-pin__open')]),
      watchers: () => listeners.length,
      /** @param {any[]|null} next - The new task list. */
      setTasks: (next) => { current = next; },
      /** @param {string} next - The new check failure. */
      setError: (next) => { error = next; },
      fireChange: () => { for (const listener of [...listeners]) listener(); },
      teardown: () => {
        try {
          controller.teardown?.();
        } finally {
          abort.abort();
          body.remove();
        }
      },
    };
  }

  // --- the manifest and its gates ------------------------------------------

  await test('the tasks pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'a second copy would list the same conversation twice');
  });

  await test('it needs a conversation, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '/p' }, conversation: null }));
    assert(reason === 'No active conversation', `expected the reason, got ${JSON.stringify(reason)}`);
  });

  await test('with a conversation it is addable', () => {
    const allowed = pin.canAdd(/** @type {any} */ ({ conversation: { id: 'c1', title: 'x' } }));
    assert(allowed === true, `expected true, got ${JSON.stringify(allowed)}`);
  });

  await test('the tab says what the pin is, and leaves the conversation to the board', () => {
    const described = pin.describe({}, /** @type {any} */ ({ conversation: { id: 'c1', title: 'Fix the parser' } }));
    assert(described.title === 'Background tasks',
      `expected 'Background tasks', got ${described.title}`);
    // Every pin on a board reads the same conversation, so naming it on this tab
    // would be one tab answering for all of them — and the badge is sized for a
    // tally, so a name in it crowds out the label that says which tab this is.
    assert(!described.badge && !described.subtitle,
      `the conversation belongs to the board, not the tab, got ${JSON.stringify(described)}`);
  });

  // --- the three states -----------------------------------------------------

  await test('before an answer it says it is looking, not that nothing is running', () => {
    const m = mount(null);
    const text = m.text();
    assert(text.includes('Looking'), `expected the looking state:\n${text}`);
    assert(!text.includes('Nothing running'),
      `it has not asked yet, so it cannot say nothing is running:\n${text}`);
    m.teardown();
  });

  await test('an empty answer says nothing is running', () => {
    const m = mount([]);
    const text = m.text();
    assert(text.includes('Commands left running in the background appear here.'),
      `expected the empty state:\n${text}`);
    assert(!text.includes('Looking'), `it has its answer now:\n${text}`);
    m.teardown();
  });

  await test('a running task gets a row showing its command', () => {
    const m = mount([task('npm run build')]);
    assert(m.rows().length === 1, `expected one row, got ${m.rows().length}`);
    assert(m.text().includes('npm run build'), `expected the command:\n${m.text()}`);
    m.teardown();
  });

  await test('every task gets its own row', () => {
    const m = mount([task('npm run build'), task('tail -f log'), task('sleep 60')]);
    assert(m.rows().length === 3, `expected three rows, got ${m.rows().length}`);
    m.teardown();
  });

  // --- what a row says ------------------------------------------------------

  await test("a monitor's label is shown beside its command", () => {
    const m = mount([task('tail -f build.log', { toolName: 'Monitor', label: 'Watching the build' })]);
    assert(m.text().includes('Watching the build'), `expected the label:\n${m.text()}`);
    m.teardown();
  });

  await test('a task with no label shows nothing in its place', () => {
    const m = mount([task('sleep 60')]);
    assert(m.body.querySelector('.tasks-pin__label') === null,
      'an absent label must not leave an empty element behind');
    m.teardown();
  });

  await test('the tool a command came from is named beside it', () => {
    const m = mount([task('npm run build', { toolName: 'bash' })]);
    const shown = m.body.querySelector('.tasks-pin__tool')?.textContent || '';
    assert(shown === 'bash', `expected the tool named, got ${JSON.stringify(shown)}`);
    m.teardown();
  });

  await test('a task with no command of its own is not made to say its tool twice', () => {
    const m = mount([task('', { toolName: 'Monitor' })]);
    const command = m.body.querySelector('.tasks-pin__command')?.textContent || '';
    assert(command === 'Monitor', `the tool stands in for the missing command, got ${JSON.stringify(command)}`);
    assert(m.body.querySelector('.tasks-pin__tool') === null,
      'and is not then repeated underneath itself');
    m.teardown();
  });

  await test('a long command is cut short rather than filling the board', () => {
    const long = `echo ${'x'.repeat(400)}`;
    const m = mount([task(long)]);
    const shown = m.body.querySelector('.tasks-pin__command')?.textContent || '';
    assert(shown.length < long.length, `expected it shortened, got ${shown.length} of ${long.length}`);
    assert(shown.endsWith('…'), `expected an ellipsis, got ${JSON.stringify(shown.slice(-8))}`);
    m.teardown();
  });

  await test('how long it has been running is shown', () => {
    const m = mount([task('sleep 60', { at: Date.now() - 90000 })]);
    const shown = m.body.querySelector('.tasks-pin__elapsed')?.textContent || '';
    assert(shown === '1m', `expected '1m' for 90 seconds, got ${JSON.stringify(shown)}`);
    m.teardown();
  });

  await test('a task too new to have a timestamp shows no elapsed time rather than nonsense', () => {
    const m = mount([task('sleep 60', { at: Infinity })]);
    assert(m.body.querySelector('.tasks-pin__elapsed') === null,
      'an unknown start time must not render as an elapsed time');
    m.teardown();
  });

  // --- reveal ---------------------------------------------------------------

  await test('a row is a real button that reveals the action that started the task', () => {
    const m = mount([task('npm run build', { itemId: 'item_start' })]);
    const [open] = m.openButtons();
    assert(open instanceof HTMLElement && open.tagName === 'BUTTON',
      'the row must be a button, not a clickable div');
    open.click();
    assert(m.revealed.length === 1 && m.revealed[0] === 'item_start',
      `expected the spawning action revealed, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('each row reveals its own task', () => {
    const m = mount([
      task('first', { itemId: 'item_first' }),
      task('second', { itemId: 'item_second' }),
    ]);
    m.openButtons()[1].click();
    assert(m.revealed[0] === 'item_second', `expected the second, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  // --- stop -----------------------------------------------------------------

  await test('Stop asks the host to stop that task', async () => {
    const m = mount([task('sleep 60', { taskId: 'bg-target' }), task('sleep 90')]);
    m.stopButtons()[0].click();
    await waitFor(() => m.stopped.length > 0, 'the stop to be requested');
    assert(m.stopped[0] === 'bg-target', `expected the clicked task, got ${JSON.stringify(m.stopped)}`);
    m.teardown();
  });

  await test('a Stop in flight dims rather than inviting a second click', () => {
    const m = mount([task('sleep 60')]);
    const [button] = m.stopButtons();
    button.click();
    assert(button.disabled, 'the control must be disabled while the stop is outstanding');
    m.teardown();
  });

  await test("a Stop that fails says so and keeps the error's own words", async () => {
    const m = mount([task('sleep 60')], { stopFails: new Error('shell registry unreachable') });
    m.stopButtons()[0].click();
    await waitFor(() => m.text().includes('shell registry unreachable'), 'the failure to be reported');
    const text = m.text();
    assert(text.includes("Couldn't stop it"), `expected a plain-English lead:\n${text}`);
    // The list is still there: a stop that failed does not mean the task went.
    assert(m.rows().length === 1, 'a failed stop must not empty the list');
    m.teardown();
  });

  // --- the check failing ----------------------------------------------------

  await test('a failed check is reported with its error text, beside the last list', () => {
    const m = mount([task('npm run build')], { error: 'connection refused' });
    const text = m.text();
    assert(text.includes("Couldn't check what's running"), `expected a plain-English lead:\n${text}`);
    assert(text.includes('connection refused'), `expected the underlying error kept:\n${text}`);
    // A check that failed is not evidence the tasks stopped.
    assert(m.rows().length === 1, 'the last known list must survive a failed check');
    m.teardown();
  });

  // --- what it claims -------------------------------------------------------

  await test('it says what the list covers, even when it has something to show', () => {
    const m = mount([task('npm run build')]);
    const text = m.text();
    assert(text.includes('this conversation started'),
      `the pin must say whose tasks these are:\n${text}`);
    assert(text.includes('while it runs'),
      `and that a finished task is not here:\n${text}`);
    m.teardown();
  });

  await test('it says so with an empty list too, which is where the claim matters most', () => {
    const m = mount([]);
    const text = m.text();
    assert(text.includes('this conversation started'),
      `an empty card is the reading most likely to be over-generalised:\n${text}`);
    // A board is furnished with this tab before anything has ever run, so the
    // empty card is the one most users meet first: it has to say what it is for.
    assert(text.includes('appear here'),
      `and it must say what will appear in it:\n${text}`);
    m.teardown();
  });

  await test('no task output reaches the pin', () => {
    // The pin shows no output at all — that is the whole reason it reveals the
    // tool action instead. A row carrying output would be a new place for a
    // secret to appear, on a surface that may be open in another window.
    const m = mount([task('printenv', { output: 'AWS_SECRET_ACCESS_KEY=hunter2' })]);
    assert(!m.text().includes('hunter2'),
      `output must never reach the board:\n${m.text()}`);
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('it redraws when the host says the list changed', () => {
    const m = mount([task('npm run build')]);
    assert(m.rows().length === 1, 'expected the first list');
    m.setTasks([]);
    m.fireChange();
    assert(m.text().includes('Commands left running in the background appear here.'),
      `expected the empty state after the task ended:\n${m.text()}`);
    m.teardown();
  });

  await test('a task appearing shows up without a remount', () => {
    const m = mount([]);
    m.setTasks([task('npm run build')]);
    m.fireChange();
    assert(m.rows().length === 1, `expected the new task, got ${m.rows().length} rows`);
    m.teardown();
  });

  await test('update() redraws against the new context', () => {
    const m = mount([task('npm run build')]);
    m.setTasks([task('npm test'), task('npm run watch')]);
    m.controller.update({
      pin: { id: 'pin_test', type: 'tasks', config: {} },
      active: {
        project: { path: '/tmp/proj', displayName: 'proj' },
        conversation: { id: 'c2', title: 'Another' },
        thread: { id: null },
      },
      services: m.services,
      signal: new AbortController().signal,
      updateConfig: async () => {},
    });
    assert(m.rows().length === 2, `expected the new list, got ${m.rows().length} rows`);
    m.teardown();
  });

  await test('teardown stops watching', () => {
    const m = mount([task('npm run build')]);
    assert(m.watchers() === 1, `expected one watcher, got ${m.watchers()}`);
    m.teardown();
    assert(m.watchers() === 0, `expected none after teardown, got ${m.watchers()}`);
  });

  return { passed, failed, errors };
}
