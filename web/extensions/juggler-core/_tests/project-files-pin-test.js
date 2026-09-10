//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Project files pin tests — the pinboard's tree of what is on disk.
 *
 * Against the REAL backend filesystem, for the same reason the File pin's tests
 * are: the pin's whole claim is that it shows the project as it is now, and a
 * faked read layer would assert that it shows whatever the fake said.
 *
 * Each test builds its own directory under the shared fixture and points the pin
 * at it as the project root, so the rows are exactly the ones the test made and
 * an assertion can name all of them. Sibling pool lanes share one fixture
 * directory and unit suites get no reset, hence the random base.
 *
 * The pin is mounted with a hand-built PinContext rather than through the board,
 * so a test can hold the file-change service and decide what the pin is told —
 * which is the only way to prove it re-reads one directory and not another.
 * @module _tests/project-files-pin-test
 */

import ProjectFilesPin from '../pins/project-files-pin.js';
import { writeFileOp, mkdirOp } from '../../../js/services/ops-api.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A mounted pin, with the levers a test needs.
 * @typedef {object} MountedPin
 * @property {HTMLElement} body - The container the pin filled.
 * @property {HTMLElement|null} list - The tree itself.
 * @property {any} controller - What mount returned.
 * @property {Record<string, any>[]} writes - Every config the pin persisted, in order.
 * @property {() => Record<string, any>|null} saved - The most recent one.
 * @property {(changes: {path: string, event: string}[]) => void} fireChange - Deliver a file change.
 * @property {() => number} watchers - How many file-change listeners are live.
 * @property {() => void} teardown - Tear the pin down and abort its signal.
 */

/**
 * Run Project files pin tests.
 * @param {{fixtureDir: string}} ctx - Test context with fixtureDir.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(ctx) {
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

  const pin = new ProjectFilesPin();
  const base = `${ctx.fixtureDir}/_projfiles_${Math.random().toString(36).slice(2, 10)}`;
  // `mkdir` makes one directory, not a path, so the base has to exist before
  // anything is created under it.
  await mkdirOp({ path: base });

  /**
   * Build a directory tree under this suite's base and hand back its root, ready
   * to be handed to a pin as the project.
   * @param {string} name - A name unique to the test asking.
   * @param {string[]} dirs - Directories to create, relative to the root.
   * @param {string[]} files - Files to create, relative to the root.
   * @returns {Promise<string>} The absolute root.
   */
  async function makeTree(name, dirs, files) {
    const root = `${base}/${name}`;
    await mkdirOp({ path: root });
    for (const dir of dirs) await mkdirOp({ path: `${root}/${dir}` });
    for (const file of files) await writeFileOp({ path: `${root}/${file}`, content: `${file}\n` });
    return root;
  }

  /**
   * Mount the pin on a root, with a file-change service the test drives.
   * @param {string} root - The project root to show.
   * @param {Record<string, any>} [config] - The stored config to mount against.
   * @returns {MountedPin} The mounted pin and its levers.
   */
  function mount(root, config = {}) {
    const body = document.createElement('div');
    body.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:300px';
    document.body.appendChild(body);

    const abort = new AbortController();
    /** @type {((changes: any[]) => void)[]} */
    const listeners = [];
    /** @type {Record<string, any>[]} */
    const writes = [];

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'project-files', config: pin.normalizeConfig(config) },
      active: {
        project: { path: root, displayName: 'fixture' },
        conversation: null,
        thread: null,
      },
      services: {
        files: {
          onChange: (/** @type {any} */ listener) => {
            listeners.push(listener);
            return () => {
              const at = listeners.indexOf(listener);
              if (at >= 0) listeners.splice(at, 1);
            };
          },
        },
      },
      signal: abort.signal,
      updateConfig: async (/** @type {Record<string, any>} */ next) => { writes.push(next); },
    })));

    return {
      body,
      list: body.querySelector('.project-files-pin__list'),
      controller,
      writes,
      saved: () => writes[writes.length - 1] || null,
      fireChange: (changes) => { for (const listener of [...listeners]) listener(changes); },
      watchers: () => listeners.length,
      teardown: () => {
        try {
          controller?.teardown?.();
        } finally {
          abort.abort();
          body.remove();
        }
      },
    };
  }

  /**
   * The item rows on screen, in order, as the things a test asserts about.
   * @param {HTMLElement} body - The pin's body.
   * @returns {{name: string, path: string, level: string, isDir: boolean, expanded: string|null}[]} The rows.
   */
  function rowsOf(body) {
    return [...body.querySelectorAll('.project-files-pin__row')].map((el) => {
      const row = /** @type {HTMLElement} */ (el);
      return {
        name: row.querySelector('.project-files-pin__name')?.textContent || '',
        path: row.dataset.filePath || '',
        level: row.getAttribute('aria-level') || '',
        isDir: row.dataset.dir === '1',
        expanded: row.getAttribute('aria-expanded'),
      };
    });
  }

  /**
   * @param {HTMLElement} body - The pin's body.
   * @returns {string[]} Just the names, for the common assertion.
   */
  const namesOf = (body) => rowsOf(body).map((row) => row.name);

  /**
   * Wait for the pin to reach a state. Every read is a real round-trip and the
   * watcher path is debounced, so there is nothing to await on directly.
   * @param {() => boolean} check - What the test is waiting for.
   * @param {string} what - What to say when it never happened.
   * @param {HTMLElement} body - The pin's body, for the failure message.
   * @param {number} [timeout] - How long to give it.
   * @returns {Promise<void>} When it happened.
   */
  async function waitFor(check, what, body, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => { setTimeout(r, 20); });
    }
    throw new Error(`timed out waiting for ${what} — showed [${namesOf(body).join(', ')}]`);
  }

  /**
   * Wait for nothing to be reading.
   * @param {HTMLElement} body - The pin's body.
   * @returns {Promise<void>} When every read in flight has landed.
   */
  const settled = (body) => waitFor(
    // Waiting for the absence of "Reading…" is not enough on its own: a read
    // that beats the grace period never says it is reading, so an empty body
    // and a finished one would look the same.
    () => (body.textContent || '').trim() !== '' && !(body.textContent || '').includes('Reading…'),
    'the tree to finish reading',
    body
  );

  /**
   * @param {HTMLElement} list - The tree.
   * @param {string} key - The key to press.
   * @returns {void}
   */
  const press = (list, key) => {
    list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  // ========================================================================
  // What it draws, without touching the disk
  // ========================================================================

  await test('the tab is named for the pin and the toolbar for the root', () => {
    const described = pin.describe({}, /** @type {any} */ ({ project: { path: '/proj' } }));
    assert(described.title === 'Project files', `the tab says the pin, got "${described.title}"`);
    // Handing the host the path is what buys the open/copy/reveal controls on
    // the root folder, so this is the whole reason the pin offers none itself.
    assert(described.path === '/proj', `the toolbar is handed the root, got "${described.path}"`);
  });

  await test('a tree needs a project to be a tree of', () => {
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '/proj' } })) === true,
      'an open project is all it asks for');
    assert(typeof pin.canAdd(/** @type {any} */ ({ project: { path: '' } })) === 'string',
      'without one the add picker must say why rather than offer a dead row');
  });

  await test('no project is a sentence, not a blank card', () => {
    const mounted = mount('');
    try {
      assert(!!mounted.body.querySelector('.pin-empty'),
        'a card that renders nothing is indistinguishable from one that is broken');
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // Reading the tree
  // ========================================================================

  await test('the root is read on mount, folders first', async () => {
    const root = await makeTree('top', ['zed'], ['apple.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      const rows = rowsOf(mounted.body);
      // 'zed' sorts after 'apple.txt' by name, so this ordering can only come
      // from folders being put first rather than from the op's own order.
      assert(rows.map((r) => r.name).join(',') === 'zed,apple.txt',
        `expected the folder first, got [${rows.map((r) => r.name).join(', ')}]`);
      assert(rows[0].isDir && !rows[1].isDir, 'the folder knows it is one and the file knows it is not');
      assert(rows[0].expanded === 'false', 'a folder starts closed');
      assert(rows[1].expanded === null, 'a file is not a thing that can be expanded');
      assert(rows.every((r) => r.level === '1'), 'everything in the root is at the first level');
      assert(rows[0].path === `${root}/zed`, `rows carry the absolute path, got "${rows[0].path}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a folder is read when it is opened, and not before', async () => {
    const root = await makeTree('lazy', ['zed'], ['apple.txt', 'zed/inner.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      assert(!namesOf(mounted.body).includes('inner.txt'),
        'the whole point of the pin is that it has not read the folder yet');

      const folder = /** @type {HTMLElement} */ (mounted.body.querySelector('.project-files-pin__row'));
      folder.click();
      await waitFor(() => namesOf(mounted.body).includes('inner.txt'),
        'the opened folder to show its contents', mounted.body);

      const rows = rowsOf(mounted.body);
      assert(rows.map((r) => r.name).join(',') === 'zed,inner.txt,apple.txt',
        `children belong under their own folder, got [${rows.map((r) => r.name).join(', ')}]`);
      assert(rows[1].level === '2', `a child is a level down, got "${rows[1].level}"`);
      assert(rows[0].expanded === 'true', 'an open folder says so');

      folder.click();
      assert(!namesOf(mounted.body).includes('inner.txt'), 'closing takes the children away again');
      assert(rowsOf(mounted.body)[0].expanded === 'false', 'and the folder says it is closed');
    } finally {
      mounted.teardown();
    }
  });

  await test('opening a folder does not flash a loading line', async () => {
    const root = await makeTree('noflash', ['zed'], ['zed/inner.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      /** @type {HTMLElement} */ (mounted.body.querySelector('.project-files-pin__row')).click();
      // Checked synchronously, on the click itself: a local directory comes
      // back in about a millisecond, so a row announcing the read appears and
      // vanishes inside one frame — seen as a flicker, and it moves every row
      // beneath it twice on the way.
      assert(!(mounted.body.textContent || '').includes('Reading…'),
        `a folder opening has no children yet, and says nothing, got "${mounted.body.textContent}"`);
      await waitFor(() => namesOf(mounted.body).includes('inner.txt'),
        'the children to arrive anyway', mounted.body);
    } finally {
      mounted.teardown();
    }
  });

  await test('a row does not change height when its controls appear', async () => {
    const root = await makeTree('steady', [], ['only.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      const row = /** @type {HTMLElement} */ (mounted.body.querySelector('.project-files-pin__row'));
      const before = row.offsetHeight;
      assert(before > 0, 'the row has to have been laid out for this to measure anything');

      row.dispatchEvent(new Event('pointerenter'));
      assert(row.offsetHeight === before,
        `the buttons are taller than the text, so the row reserves their height rather than growing into it — was ${before}, became ${row.offsetHeight}`);
    } finally {
      mounted.teardown();
    }
  });

  await test('an empty folder says it is empty rather than looking unread', async () => {
    const root = await makeTree('hollow', ['void'], []);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      /** @type {HTMLElement} */ (mounted.body.querySelector('.project-files-pin__row')).click();
      await waitFor(() => (mounted.body.textContent || '').includes('Empty'),
        'the empty folder to say so', mounted.body);
      assert(rowsOf(mounted.body).length === 1, 'and to add no rows of its own');
    } finally {
      mounted.teardown();
    }
  });

  await test('a folder that cannot be read says why, in the op\'s own words', async () => {
    const mounted = mount(`${base}/never-made`);
    try {
      await waitFor(() => (mounted.body.textContent || '').includes("Couldn't read this folder."),
        'the failure to be reported', mounted.body);
      const said = mounted.body.textContent || '';
      // The lead goes above the error text, never in place of it: which of the
      // many reasons this was is only in what came back.
      assert(said.trim().length > "Couldn't read this folder.".length + 3,
        `the underlying error must survive, got "${said.trim()}"`);
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // Remembering where the reader got to
  // ========================================================================

  await test('a stored config is read as a stranger wrote it', () => {
    const normalized = pin.normalizeConfig({
      expanded: ['src/main', 'src/main', 'a\\b', './x/', '', 42, null, '../escape', '..'],
    });
    assert(JSON.stringify(normalized.expanded) === JSON.stringify(['a/b', 'src/main', 'x']),
      `duplicates, rubbish and paths climbing out of the project are all dropped, got ${JSON.stringify(normalized.expanded)}`);
    assert(JSON.stringify(pin.normalizeConfig({}).expanded) === '[]',
      'a config from before this pin remembered anything is an empty tree, not a broken one');
    assert(JSON.stringify(pin.normalizeConfig(/** @type {any} */ ({ expanded: 'src' })).expanded) === '[]',
      'and neither is something that is not a list');
  });

  await test('opening a folder is written down as it happens', async () => {
    const root = await makeTree('remember', ['zed'], ['zed/inner.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      assert(mounted.saved() === null, 'nothing is written for a tree nobody has touched');

      /** @type {HTMLElement} */ (mounted.body.querySelector('.project-files-pin__row')).click();
      // Written on the click rather than after a pause: switching tabs tears the
      // pin down, so any wait at all is a window where the last thing the reader
      // did is the one thing that does not come back.
      assert(JSON.stringify(mounted.saved()?.expanded) === '["zed"]',
        `the open folder is stored relative to the root, got ${JSON.stringify(mounted.saved())}`);

      /** @type {HTMLElement} */ (mounted.body.querySelector('.project-files-pin__row')).click();
      assert(JSON.stringify(mounted.saved()?.expanded) === '[]',
        `and closing it is written down too, got ${JSON.stringify(mounted.saved())}`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a tree comes back open where it was left', async () => {
    const root = await makeTree('restore', ['zed', 'zed/deep'], ['zed/inner.txt', 'zed/deep/leaf.txt']);

    // Switching to another pinboard card and back tears this pin down and builds
    // it again, which is exactly what these two mounts are. A tree that came
    // back shut would be one the reader has to walk down again every time they
    // glance at another tab.
    const first = mount(root);
    try {
      await settled(first.body);
      /** @type {HTMLElement} */ (first.body.querySelector('.project-files-pin__row')).click();
      await waitFor(() => namesOf(first.body).includes('deep'), 'the folder to open', first.body);
      const deep = [...first.body.querySelectorAll('.project-files-pin__row')]
        .find((row) => /** @type {HTMLElement} */ (row).dataset.filePath === `${root}/zed/deep`);
      /** @type {HTMLElement} */ (deep).click();
      await waitFor(() => namesOf(first.body).includes('leaf.txt'), 'the inner folder to open', first.body);
      assert(JSON.stringify(first.saved()?.expanded) === '["zed","zed/deep"]',
        `both levels are remembered, got ${JSON.stringify(first.saved())}`);
    } finally {
      first.teardown();
    }

    const second = mount(root, /** @type {any} */ ({ expanded: ['zed', 'zed/deep'] }));
    try {
      await waitFor(() => namesOf(second.body).includes('leaf.txt'),
        'the remembered tree to reopen all the way down', second.body);
      const rows = rowsOf(second.body);
      assert(rows.map((r) => r.name).join(',') === 'zed,deep,leaf.txt,inner.txt',
        `the tree returns as it was left, got [${rows.map((r) => r.name).join(', ')}]`);
      assert(rows[0].expanded === 'true' && rows[1].expanded === 'true',
        'and both folders say they are open');
    } finally {
      second.teardown();
    }
  });

  await test('a remembered folder that has gone is not fatal to the rest', async () => {
    const root = await makeTree('stale', ['here'], ['here/one.txt']);
    const mounted = mount(root, /** @type {any} */ ({ expanded: ['here', 'gone/for/good'] }));
    try {
      await waitFor(() => namesOf(mounted.body).includes('one.txt'),
        'the folder that is still there to open', mounted.body);
      assert(namesOf(mounted.body).join(',') === 'here,one.txt',
        `a folder nobody can find contributes no rows, got [${namesOf(mounted.body).join(', ')}]`);
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // Keeping up with the disk
  // ========================================================================

  await test('only the folder that changed is read again', async () => {
    const root = await makeTree('selective', ['a', 'b'], ['a/one.txt', 'b/two.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      for (const row of [...mounted.body.querySelectorAll('.project-files-pin__row')]) {
        /** @type {HTMLElement} */ (row).click();
      }
      await waitFor(() => {
        const names = namesOf(mounted.body);
        return names.includes('one.txt') && names.includes('two.txt');
      }, 'both folders to open', mounted.body);

      // Both folders gain a file on disk, and the pin is told about one of them.
      // A pin that re-read the tree would show both, which is the failure this
      // is here to catch.
      await writeFileOp({ path: `${root}/a/added.txt`, content: 'a\n' });
      await writeFileOp({ path: `${root}/b/added.txt`, content: 'b\n' });
      mounted.fireChange([{ path: `${root}/a/added.txt`, event: 'create' }]);

      await waitFor(() => namesOf(mounted.body).includes('added.txt'),
        'the changed folder to be read again', mounted.body);
      assert(namesOf(mounted.body).filter((n) => n === 'added.txt').length === 1,
        'the folder nobody mentioned must not have been read');
    } finally {
      mounted.teardown();
    }
  });

  await test('Refresh reads everything on screen again', async () => {
    const root = await makeTree('refresh', [], ['first.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      assert(namesOf(mounted.body).join(',') === 'first.txt', 'the tree starts with what was there');

      // No change event: this is exactly the case Refresh exists for, since the
      // watcher is rooted at the project and cannot see everything.
      await writeFileOp({ path: `${root}/second.txt`, content: 'two\n' });
      const actions = mounted.controller.getActions();
      assert(actions.length === 1 && actions[0].id === 'refresh',
        `the toolbar offers exactly Refresh, got ${JSON.stringify(actions.map((/** @type {any} */ a) => a.id))}`);
      actions[0].run();

      await waitFor(() => namesOf(mounted.body).includes('second.txt'),
        'Refresh to pick up the new file', mounted.body);
    } finally {
      mounted.teardown();
    }
  });

  await test('tearing the pin down stops it listening', async () => {
    const root = await makeTree('teardown', [], ['only.txt']);
    const mounted = mount(root);
    await settled(mounted.body);
    assert(mounted.watchers() === 1, 'a mounted pin watches for changes');
    mounted.teardown();
    assert(mounted.watchers() === 0, 'and a torn-down one does not');
  });

  // ========================================================================
  // Acting on a row
  // ========================================================================

  await test('a row\'s controls are built when it is pointed at, and once', async () => {
    const root = await makeTree('actions', [], ['only.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      const row = /** @type {HTMLElement} */ (mounted.body.querySelector('.project-files-pin__row'));
      const slot = /** @type {HTMLElement} */ (row.querySelector('.project-files-pin__actions'));
      assert(slot.childElementCount === 0,
        'a resting tree pays for no controls at all');

      row.dispatchEvent(new Event('pointerenter'));
      assert(slot.childElementCount === 1, 'pointing at a row builds its controls');
      const built = slot.firstElementChild;
      assert(!!built?.querySelector('button'), 'which are the shared file controls, not a local imitation');

      row.dispatchEvent(new Event('pointerenter'));
      row.dispatchEvent(new Event('focusin'));
      assert(slot.childElementCount === 1 && slot.firstElementChild === built,
        'and pointing again reuses them rather than stacking another set');
    } finally {
      mounted.teardown();
    }
  });

  await test('every row is one the right-click menu can act on', async () => {
    const root = await makeTree('menu', ['dir'], ['file.txt']);
    const mounted = mount(root);
    try {
      await settled(mounted.body);
      // The app's shared menu finds a file by `data-file-path`, so a row that
      // has one is actionable however the reader got to it — folders included.
      assert(rowsOf(mounted.body).every((r) => r.path.startsWith(root)),
        'both a folder and a file carry their absolute path');
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // Walking it with the keyboard
  // ========================================================================

  await test('the arrows walk the tree and open what they land on', async () => {
    const root = await makeTree('keys', ['zed'], ['apple.txt', 'zed/inner.txt']);
    const mounted = mount(root);
    const list = /** @type {HTMLElement} */ (mounted.list);
    try {
      await settled(mounted.body);

      /**
       * Which row the arrows are on. Read from the roving tabindex rather than
       * from focus: an extension suite cannot ask for a lane to itself, so an
       * assertion about the focused element is a flake waiting for a busy pool.
       * @returns {string} Its name.
       */
      const active = () => rowsOf(mounted.body).find((r) => {
        const el = [...mounted.body.querySelectorAll('.project-files-pin__row')]
          .find((node) => /** @type {HTMLElement} */ (node).dataset.filePath === r.path);
        return /** @type {HTMLElement} */ (el)?.tabIndex === 0;
      })?.name || '';

      assert(active() === 'zed', `the first row starts active, got "${active()}"`);

      press(list, 'ArrowDown');
      assert(active() === 'apple.txt', `down moves on, got "${active()}"`);
      press(list, 'ArrowDown');
      assert(active() === 'apple.txt', 'and stops at the end rather than wrapping');
      press(list, 'ArrowUp');
      assert(active() === 'zed', `up goes back, got "${active()}"`);

      press(list, 'ArrowRight');
      await waitFor(() => namesOf(mounted.body).includes('inner.txt'),
        'right to open the folder', mounted.body);
      assert(active() === 'zed', 'opening a folder does not leave it');

      press(list, 'ArrowRight');
      assert(active() === 'inner.txt', `right again steps into it, got "${active()}"`);

      press(list, 'ArrowLeft');
      assert(active() === 'zed', `left from a child goes up to what holds it, got "${active()}"`);

      press(list, 'ArrowLeft');
      assert(!namesOf(mounted.body).includes('inner.txt'), 'and left again closes it');

      press(list, 'End');
      assert(active() === 'apple.txt', `End goes to the last row, got "${active()}"`);
      press(list, 'Home');
      assert(active() === 'zed', `Home goes back to the first, got "${active()}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a key the tree uses is taken from the board, and one it does not is left alone', async () => {
    const root = await makeTree('claims', ['zed'], ['apple.txt']);
    const mounted = mount(root);
    const list = /** @type {HTMLElement} */ (mounted.list);
    try {
      await settled(mounted.body);

      const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      list.dispatchEvent(down);
      assert(down.defaultPrevented, 'the board must see that the tree handled it and stand down');

      const typed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      list.dispatchEvent(typed);
      assert(!typed.defaultPrevented, 'a key the tree has no use for is not swallowed');

      // The chord belongs to the board wherever focus is, so a modified arrow
      // must go straight past a tree that otherwise claims arrows.
      const chord = new KeyboardEvent('keydown', {
        key: 'ArrowRight', altKey: true, metaKey: true, bubbles: true, cancelable: true,
      });
      list.dispatchEvent(chord);
      assert(!chord.defaultPrevented, 'the board keeps its own way between tabs');
    } finally {
      mounted.teardown();
    }
  });

  return { passed, failed, errors };
}
