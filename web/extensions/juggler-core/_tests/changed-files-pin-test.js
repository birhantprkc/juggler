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
 * What is checked here is the grouping, the diff a row opens onto, and — more
 * importantly than either — the claim: this pin is one wrong word away from
 * telling the user it lists everything that changed, which it cannot know. The
 * note that says otherwise is asserted like a feature, because it is one.
 *
 * The diff cases carry the same burden in a smaller place. A row is only there
 * because something changed, so the two states where the pin cannot draw what
 * that was must say which — an empty diff reads as "nothing happened", and on
 * this row that is the one thing known to be false.
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
    /** @type {string[]} */
    const asked = [];
    /** @type {Map<string, any>} */
    const snapshots = new Map();
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
         * @param {string} itemId - The action whose two files are wanted.
         * @returns {any} The snapshot this case gave that action, or null.
         */
        snapshot: (itemId) => {
          asked.push(itemId);
          return snapshots.get(itemId) || null;
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
      panels: () => [...body.querySelectorAll('.changed-files-pin__diff')],
      asked,
      watchers: () => listeners.length,
      /**
       * What an edit did, for the cases that expand a row.
       * @param {string} itemId - The action.
       * @param {string} oldContent - The file before it.
       * @param {string} newContent - The file after it.
       */
      setSnapshot: (itemId, oldContent, newContent) => {
        snapshots.set(itemId, { oldContent, newContent });
      },
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
    assert(m.text().includes('Files changed in this conversation appear here.'),
      `got ${JSON.stringify(m.text())}`);
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

  // --- what changed ---------------------------------------------------------

  await test('a row is a real control, and says what opening it will do', () => {
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_target' })]);
    const row = m.rows()[0];
    assert(row.tagName === 'BUTTON', `expected a real button, got ${row.tagName}`);
    assert(row.getAttribute('aria-label') === 'Show what changed in /tmp/proj/a.js',
      `expected a literal label, got ${JSON.stringify(row.getAttribute('aria-label'))}`);
    assert(row.getAttribute('aria-expanded') === 'false',
      `a closed row must say it is closed, got ${JSON.stringify(row.getAttribute('aria-expanded'))}`);
    m.teardown();
  });

  await test('nothing is read until a row is opened', () => {
    // A snapshot is the file twice over. Fetching one per row to draw a list
    // would cost the size of everything the conversation ever wrote.
    const m = mount([edit('/tmp/proj/a.js'), edit('/tmp/proj/b.js')]);
    assert(m.asked.length === 0, `expected no snapshot reads, got ${JSON.stringify(m.asked)}`);
    assert(m.panels().length === 0, 'and no diff drawn');
    m.teardown();
  });

  await test('clicking a row shows the diff beneath it', () => {
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_only' })]);
    m.setSnapshot('item_only', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    const row = m.rows()[0];
    /** @type {any} */ (row).click();

    const panel = m.panels()[0];
    assert(!!panel, `expected a diff panel under the row:\n${m.text()}`);
    assert(row.getAttribute('aria-expanded') === 'true', 'an open row must say it is open');
    assert(!!panel.querySelector('diff-viewer'), 'the diff is drawn by the diff viewer');
    const shown = panel.textContent || '';
    assert(shown.includes('TWO') && shown.includes('two'),
      `expected both sides of the change:\n${shown}`);
    // The other rows stay put: the list is what makes this pin worth reading, and
    // a diff that replaced it would cost the comparison it was opened for.
    assert(m.rows().length === 1, 'the list is still a list');
    m.teardown();
  });

  await test("the diff spans the file's first edit and its last, not just the last", () => {
    // Cumulative is the question the pin's title asks: what did this conversation
    // do to this file. Diffing only the newest edit would answer a different one.
    const m = mount([
      edit('/tmp/proj/a.js', { itemId: 'item_third' }),
      edit('/tmp/proj/a.js', { itemId: 'item_second' }),
      edit('/tmp/proj/a.js', { itemId: 'item_first' }),
    ]);
    m.setSnapshot('item_first', 'original\n', 'once\n');
    m.setSnapshot('item_third', 'twice\n', 'final\n');
    /** @type {any} */ (m.rows()[0]).click();

    assert(m.asked.includes('item_first') && m.asked.includes('item_third'),
      `expected both ends read; got ${JSON.stringify(m.asked)}`);
    const shown = m.panels()[0]?.textContent || '';
    assert(shown.includes('original') && shown.includes('final'),
      `expected the file as it started and as it ended:\n${shown}`);
    assert(!shown.includes('once') && !shown.includes('twice'),
      `the states it passed through are not the change it came to:\n${shown}`);
    m.teardown();
  });

  await test('clicking an open row closes it again', () => {
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_only' })]);
    m.setSnapshot('item_only', 'alpha\n', 'omega\n');
    const row = m.rows()[0];
    /** @type {any} */ (row).click();
    assert(m.panels().length === 1, 'opened');
    assert(m.text().includes('alpha'), 'and showing the file');
    /** @type {any} */ (row).click();
    assert(m.panels().length === 0, 'closing must take the panel away');
    assert(row.getAttribute('aria-expanded') === 'false', 'and say so');
    // Closing is also how the file text is let go: it was held only by the panel.
    assert(!m.text().includes('alpha'), 'a closed row holds no file content');
    m.teardown();
  });

  await test('an open diff survives the conversation moving under it', () => {
    // A turn under way fires a change several times a second. A panel that closed
    // on each one could not be read at all.
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_only' })]);
    m.setSnapshot('item_only', 'a\n', 'b\n');
    /** @type {any} */ (m.rows()[0]).click();
    m.fireChange();
    assert(m.panels().length === 1, `an open diff must stay open across a re-render:\n${m.text()}`);
    m.teardown();
  });

  await test('a file edited again while open shows the new state', () => {
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_first' })]);
    m.setSnapshot('item_first', 'start\n', 'middle\n');
    /** @type {any} */ (m.rows()[0]).click();
    assert((m.panels()[0]?.textContent || '').includes('middle'), 'the first state is shown');

    m.setEdits([
      edit('/tmp/proj/a.js', { itemId: 'item_second' }),
      edit('/tmp/proj/a.js', { itemId: 'item_first' }),
    ]);
    m.setSnapshot('item_second', 'middle\n', 'end\n');
    m.fireChange();

    const shown = m.panels()[0]?.textContent || '';
    assert(shown.includes('end') && shown.includes('start'),
      `an open diff must follow the file it is showing:\n${shown}`);
    m.teardown();
  });

  await test('opening several files squashes none of them', () => {
    // The list is a flex column in a bounded body, so a card is a flex item and
    // will give up its own height to make room for its siblings unless told not
    // to. The card clips what it cannot fit, so the failure is silent: every
    // diff but the last loses its bottom, and the list never scrolls.
    const m = mount([
      edit('/tmp/proj/a.js', { itemId: 'item_a' }),
      edit('/tmp/proj/b.js', { itemId: 'item_b' }),
      edit('/tmp/proj/c.js', { itemId: 'item_c' }),
    ]);
    m.body.style.height = '18rem';
    /**
     * @param {string} mark - What to make the lines say.
     * @returns {string} A file long enough to need the room.
     */
    const long = (mark) => Array.from({ length: 40 }, (_, i) => `${mark} line ${i}`).join('\n');
    for (const id of ['item_a', 'item_b', 'item_c']) m.setSnapshot(id, long('old'), long(id));
    for (const row of m.rows()) /** @type {any} */ (row).click();

    const cards = [...m.body.querySelectorAll('.changed-files-pin__file')];
    assert(cards.length === 3, `expected three cards, got ${cards.length}`);
    // A page that never laid out would pass every height check below by having
    // no heights at all, so the measurement is checked before it is trusted.
    assert(cards[0].clientHeight > 0, 'the page must have laid out for this to mean anything');
    for (const card of cards) {
      assert(card.scrollHeight <= card.clientHeight + 1,
        `a card was cut short: ${card.scrollHeight}px of content in ${card.clientHeight}px`);
    }
    m.teardown();
  });

  await test('two files can be open at once', () => {
    const m = mount([
      edit('/tmp/proj/a.js', { itemId: 'item_a' }),
      edit('/tmp/proj/b.js', { itemId: 'item_b' }),
    ]);
    m.setSnapshot('item_a', 'a\n', 'A\n');
    m.setSnapshot('item_b', 'b\n', 'B\n');
    /** @type {any} */ (m.rows()[0]).click();
    /** @type {any} */ (m.rows()[1]).click();
    assert(m.panels().length === 2,
      `comparing two files is the reason the list stayed; got ${m.panels().length} open`);
    m.teardown();
  });

  // --- when there is no diff to draw ----------------------------------------

  await test('an edit that recorded nothing says so, rather than "No changes"', () => {
    // The viewer draws two empty strings as a file that changed in no way, which
    // of a row that is only there because it changed is exactly backwards.
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_bare' })]);
    /** @type {any} */ (m.rows()[0]).click();
    const shown = m.panels()[0]?.textContent || '';
    assert(!m.panels()[0]?.querySelector('diff-viewer'),
      `an unrecorded change must not be drawn as a diff:\n${shown}`);
    assert(shown.includes("weren't recorded"), `expected the reason, got:\n${shown}`);
    m.teardown();
  });

  await test('a file too large to diff says so instead of hanging the board', () => {
    // The diff builds an (old+1)×(new+1) table, so a big file both sides is tens
    // of millions of cells — computed on the click, in the only thread there is.
    const huge = `${'line\n'.repeat(3000)}`;
    const m = mount([edit('/tmp/proj/huge.js', { itemId: 'item_huge' })]);
    m.setSnapshot('item_huge', huge, `${huge}tail\n`);
    /** @type {any} */ (m.rows()[0]).click();
    const shown = m.panels()[0]?.textContent || '';
    assert(!m.panels()[0]?.querySelector('diff-viewer'),
      `a file this size must not reach the diff:\n${shown.slice(0, 200)}`);
    assert(shown.includes('too large'), `expected the reason, got:\n${shown.slice(0, 200)}`);
    m.teardown();
  });

  // --- doing something with the file ----------------------------------------

  await test('an open file offers the standard file controls', () => {
    // Open, copy the path, reveal it where it lives: the same group, in the same
    // order, as every other surface that shows a path. A pin inventing its own
    // would be three more buttons to learn and a fourth behaviour for "reveal".
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_only' })]);
    m.setSnapshot('item_only', 'a\n', 'b\n');
    /** @type {any} */ (m.rows()[0]).click();

    const actions = m.panels()[0]?.querySelector('.properties-panel-filepath-actions');
    assert(!!actions, `expected the shared file actions in the open panel:\n${m.text()}`);
    assert(!!actions.querySelector('[aria-label="Open file"]'), 'expected Open');
    assert(!!actions.querySelector('[aria-label="Copy path to clipboard"]'), 'expected Copy path');
    assert(!!actions.querySelector('reveal-button'), 'expected Reveal');
    m.teardown();
  });

  await test('the controls act on the file the row is for', () => {
    const m = mount([edit('/tmp/proj/deep/thing.js', { itemId: 'item_only' })]);
    m.setSnapshot('item_only', 'a\n', 'b\n');
    /** @type {any} */ (m.rows()[0]).click();
    const reveal = m.panels()[0]?.querySelector('reveal-button');
    assert(reveal?.getAttribute('path') === '/tmp/proj/deep/thing.js',
      `the whole path, not the name on the row; got ${JSON.stringify(reveal?.getAttribute('path'))}`);
    m.teardown();
  });

  await test('a row carries its path for the right-click menu', () => {
    // Every element naming a file gets Open / Reveal / Copy path from the app's
    // own menu on one dataset attribute, so a closed row is not a dead end.
    const m = mount([edit('/tmp/proj/a.js')]);
    assert(m.rows()[0].dataset.filePath === '/tmp/proj/a.js',
      `expected the path on the row; got ${JSON.stringify(m.rows()[0].dataset.filePath)}`);
    m.teardown();
  });

  // --- pointing back --------------------------------------------------------

  await test('an open row offers the change in the conversation', () => {
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_target' })]);
    m.setSnapshot('item_target', 'a\n', 'b\n');
    /** @type {any} */ (m.rows()[0]).click();
    assert(JSON.stringify(m.revealed) === JSON.stringify([]),
      `opening a diff is not a reveal; got ${JSON.stringify(m.revealed)}`);

    const reveal = m.panels()[0]?.querySelector('.changed-files-pin__reveal');
    assert(!!reveal, `expected a reveal control in the open panel:\n${m.text()}`);
    /** @type {any} */ (reveal).click();
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
    const reveal = m.panels()[0]?.querySelector('.changed-files-pin__reveal');
    assert(!!reveal, `expected a reveal control:\n${m.text()}`);
    /** @type {any} */ (reveal).click();
    assert(JSON.stringify(m.revealed) === JSON.stringify(['item_latest']),
      `the newest edit is the one worth going to; got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('a change that could not be drawn still points at the conversation', () => {
    // Where the pin cannot show what happened, the transcript still can.
    const m = mount([edit('/tmp/proj/a.js', { itemId: 'item_bare' })]);
    /** @type {any} */ (m.rows()[0]).click();
    assert(!!m.panels()[0]?.querySelector('.changed-files-pin__reveal'),
      `the way out must survive the case that needs it most:\n${m.text()}`);
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
    assert(m.text().includes('Files changed in this conversation appear here.'),
      'expected the empty state first');
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
