//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Changed files pin tests — what the board says this conversation changed.
 *
 * Mounted with a hand-built PinContext whose `fileEdits` service the test drives,
 * so a case states a transcript rather than arranging for one; the host half of
 * that service — which tool actions count as edits at all — is asserted against
 * real models in `unit:pinboard-file-edits`.
 *
 * What is checked here is the grouping and, more importantly, the claim: this pin
 * is one wrong word away from telling the user it lists everything that changed,
 * which it cannot know. The note that says otherwise is asserted like a feature,
 * because it is one.
 * @module _tests/changed-files-pin-test
 */

import ChangedFilesPin from '../pins/changed-files-pin.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Changed files pin tests.
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

  const pin = new ChangedFilesPin();

  let nextId = 0;

  /**
   * One edit, as the host's fileEdits service reports one.
   * @param {string} path - The file it changed.
   * @param {object} [overrides] - What this case cares about.
   * @returns {any} The edit.
   */
  const edit = (path, overrides = {}) => ({
    itemId: `item_${++nextId}`,
    threadId: null,
    toolName: 'write',
    path,
    added: 0,
    removed: 0,
    at: nextId,
    ...overrides,
  });

  /**
   * Mount the pin against a canned edit list.
   * @param {any[]} list - What `fileEdits.list` should return, newest first.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(list) {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {(() => void)[]} */
    const listeners = [];
    /** @type {string[]} */
    const revealed = [];
    /** @type {any[]} */
    const queries = [];
    let current = list;

    const services = {
      files: { onChange: () => () => {} },
      contextItems: { find: () => null, onChange: () => () => {}, reveal: () => {} },
      git: { status: () => null, error: () => '', onChange: () => () => {}, refresh: async () => {} },
      fileEdits: {
        /**
         * @param {any} query - What the pin asked for.
         * @returns {any[]} The edits.
         */
        list: (query) => {
          queries.push(query);
          return current.slice(0, query?.limit ?? current.length);
        },
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
      },
    };

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'changed-files', config: {} },
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
      queries,
      text: () => body.textContent || '',
      rows: () => [...body.querySelectorAll('.changed-files-pin__row')],
      watchers: () => listeners.length,
      /** @param {any[]} next - The new edit list. */
      setEdits: (next) => { current = next; },
      fireChange: () => { for (const listener of [...listeners]) listener(); },
      teardown: () => {
        controller.teardown?.();
        abort.abort();
        body.remove();
      },
    };
  }

  // --- the manifest and its gates ------------------------------------------

  await test('the changed-files pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'a second copy would list the same conversation twice');
  });

  await test('it needs a conversation, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '/p' }, conversation: null }));
    assert(reason === 'No active conversation', `expected the reason, got ${JSON.stringify(reason)}`);
  });

  await test('the tab says what the pin is, and leaves the conversation to the board', () => {
    const described = pin.describe({}, /** @type {any} */ ({ conversation: { id: 'c1', title: 'Fix the parser' } }));
    assert(described.title === 'Changed files', `expected 'Changed files', got ${described.title}`);
    // Every pin on a board reads the same conversation, so naming it on this tab
    // would be one tab answering for all of them — and the badge is sized for a
    // tally, so a name in it crowds out the label that says which tab this is.
    assert(!described.badge && !described.subtitle,
      `the conversation belongs to the board, not the tab, got ${JSON.stringify(described)}`);
  });

  // --- what it claims -------------------------------------------------------

  await test('it says which tools it speaks for, even when it has something to show', () => {
    const m = mount([edit('/tmp/proj/a.js')]);
    const text = m.text();
    assert(text.includes('write and edit tools'),
      `the pin must say which tools it is reporting:\n${text}`);
    assert(text.includes('in this conversation'),
      `and that the list is one conversation's:\n${text}`);
    m.teardown();
  });

  await test('it says a shell command cannot be attributed', () => {
    // The one claim this pin must never make by omission. A user reading
    // "Changed files" as "everything that changed" would trust an empty list
    // after a scripted rewrite of half the tree.
    const m = mount([]);
    assert(m.text().includes("shell command's changes can't be attributed"),
      `the limitation belongs in the pin, not in help nobody opens:\n${m.text()}`);
    m.teardown();
  });

  await test('the note is there whether or not anything changed', () => {
    const empty = mount([]);
    const emptyHasNote = empty.text().includes('write and edit tools');
    empty.teardown();
    const full = mount([edit('/tmp/proj/a.js')]);
    const fullHasNote = full.text().includes('write and edit tools');
    full.teardown();
    assert(emptyHasNote && fullHasNote,
      `the empty list is exactly where the claim matters most: empty=${emptyHasNote} full=${fullHasNote}`);
  });

  await test('it asks the host only about the mutation tools', () => {
    const m = mount([]);
    const query = m.queries[0];
    assert(JSON.stringify(query.tools) === JSON.stringify(['write', 'edit']),
      `which tools mutate a file is the extension's knowledge; got ${JSON.stringify(query.tools)}`);
    assert(typeof query.limit === 'number' && query.limit > 0,
      `a transcript walk must be bounded; got ${JSON.stringify(query.limit)}`);
    m.teardown();
  });

  // --- what it draws --------------------------------------------------------

  await test('nothing changed says so', () => {
    const m = mount([]);
    assert(m.text().includes('Nothing changed yet.'), `got ${JSON.stringify(m.text())}`);
    assert(m.rows().length === 0, 'an empty list has no rows');
    m.teardown();
  });

  await test('each file gets one row, named and located', () => {
    const m = mount([edit('/tmp/proj/web/js/app.js'), edit('/tmp/proj/notes.md')]);
    const rows = m.rows();
    assert(rows.length === 2, `expected 2 rows, got ${rows.length}`);
    const text = m.text();
    assert(text.includes('app.js') && text.includes('notes.md'), `names missing:\n${text}`);
    m.teardown();
  });

  await test('a file edited several times is one row that counts them', () => {
    const m = mount([
      edit('/tmp/proj/a.js'),
      edit('/tmp/proj/a.js'),
      edit('/tmp/proj/a.js'),
    ]);
    const rows = m.rows();
    assert(rows.length === 1, `three edits to one file are one changed file, got ${rows.length} rows`);
    assert(m.text().includes('×3'), `but how many times is worth knowing:\n${m.text()}`);
    m.teardown();
  });

  await test('one edit to a file is not counted at it', () => {
    const m = mount([edit('/tmp/proj/a.js')]);
    assert(!m.text().includes('×1'), `"×1" is noise on every row that ever appears:\n${m.text()}`);
    m.teardown();
  });

  await test('the diffstat is summed across a file\'s edits', () => {
    const m = mount([
      edit('/tmp/proj/a.js', { added: 10, removed: 2 }),
      edit('/tmp/proj/a.js', { added: 5, removed: 3 }),
    ]);
    const text = m.text();
    assert(text.includes('+15') && text.includes('-5'), `expected the totals, got:\n${text}`);
    m.teardown();
  });

  await test('a tool that reported no diffstat shows none, rather than zero', () => {
    const m = mount([edit('/tmp/proj/a.js', { added: 0, removed: 0 })]);
    // "+0 -0" reads as "changed nothing", which is the opposite of why the row
    // is there. An unreported diffstat is unreported, not zero.
    assert(!m.text().includes('+0'), `expected no stat at all, got:\n${m.text()}`);
    assert(m.rows().length === 1, 'the file is still listed');
    m.teardown();
  });

  await test('the newest file comes first', () => {
    const m = mount([edit('/tmp/proj/newest.js'), edit('/tmp/proj/older.js')]);
    const rows = m.rows();
    assert((rows[0].textContent || '').includes('newest.js'),
      `the host hands them over newest first and the pin keeps that order:\n${m.text()}`);
    m.teardown();
  });

  // --- pointing back --------------------------------------------------------

  await test('a row is a real control, and clicking it reveals the change', () => {
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_target' })]);
    const row = m.rows()[0];
    assert(row.tagName === 'BUTTON', `expected a real button, got ${row.tagName}`);
    assert(row.getAttribute('aria-label') === 'Reveal the last change to /tmp/proj/a.js',
      `expected a literal label, got ${JSON.stringify(row.getAttribute('aria-label'))}`);
    /** @type {any} */ (row).click();
    assert(JSON.stringify(m.revealed) === JSON.stringify(['item_target']),
      `expected the action revealed, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('a repeatedly edited file reveals its most recent change', () => {
    const m = mount([
      edit('/tmp/proj/a.js', { itemId: 'item_latest' }),
      edit('/tmp/proj/a.js', { itemId: 'item_earlier' }),
    ]);
    /** @type {any} */ (m.rows()[0]).click();
    assert(JSON.stringify(m.revealed) === JSON.stringify(['item_latest']),
      `the newest edit is the one worth going to; got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('it offers no toolbar actions, because the rows are the controls', () => {
    const m = mount([edit('/tmp/proj/a.js')]);
    assert(typeof m.controller.getActions !== 'function',
      'a Reveal button would need a selected row, and the rows reveal themselves');
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('a new edit redraws the list', () => {
    const m = mount([]);
    assert(m.text().includes('Nothing changed yet.'), 'expected the empty state first');
    m.setEdits([edit('/tmp/proj/fresh.js')]);
    m.fireChange();
    assert(m.text().includes('fresh.js'), `expected the new file after a change:\n${m.text()}`);
    m.teardown();
  });

  await test('a new active context redraws in place', () => {
    const m = mount([edit('/tmp/proj/before.js')]);
    m.setEdits([edit('/tmp/proj/after.js')]);
    m.controller.update({
      pin: { id: 'pin_test', type: 'changed-files', config: {} },
      active: {
        project: { path: '/tmp/proj', displayName: 'proj' },
        conversation: { id: 'c2', title: 'Another' },
        thread: { id: null },
      },
      services: m.services,
      signal: new AbortController().signal,
      updateConfig: async () => {},
    });
    assert(m.text().includes('after.js'),
      `switching conversation must re-read through the new context:\n${m.text()}`);
    assert(m.watchers() === 1, `update must not stack a second watcher, got ${m.watchers()}`);
    m.teardown();
  });

  await test('teardown stops watching', () => {
    const m = mount([]);
    assert(m.watchers() === 1, `expected one watcher while mounted, got ${m.watchers()}`);
    m.controller.teardown();
    assert(m.watchers() === 0, `expected no watcher after teardown, got ${m.watchers()}`);
    m.teardown();
  });

  return { passed, failed, errors };
}
