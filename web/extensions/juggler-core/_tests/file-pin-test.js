//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * File pin tests — the pinboard's live view of a path.
 *
 * Against the REAL backend filesystem: the pin's whole claim is that it shows
 * what is on disk now, and a faked read layer would assert nothing about that.
 * Files are written under the shared fixture with a `_filepin_` prefix, since
 * sibling pool lanes share one directory and unit suites get no fixture reset.
 *
 * The pin is mounted with a hand-built PinContext rather than through the board,
 * so a test can hold the file-change service and fire it. The host's half of that
 * service — the websocket subscription and the project-relative-to-absolute
 * resolution — is asserted in `unit:pinboard-shell`, against the host that owns
 * it. Which viewer claims a `.png` or a `.pdf` belongs to `unit:file-view`; what
 * is asserted here is that the pin hands the file to that machinery at all rather
 * than rendering bytes itself.
 * @module _tests/file-pin-test
 */

import FilePin from '../pins/file-pin.js';
import { writeFileOp } from '../../../js/services/ops-api.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import { addFilePath } from 'juggler/ui';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A mounted pin, with the levers a test needs: the body it filled, the
 * file-change listener it registered, and its controller.
 * @typedef {object} MountedPin
 * @property {HTMLElement} body - The container the pin filled.
 * @property {import('juggler/pinboard-item-type').PinController} controller - What mount returned.
 * @property {(changes: {path: string, event: string}[]) => void} fireChange - Deliver a file change.
 * @property {() => number} watchers - How many file-change listeners are live.
 * @property {() => void} teardown - Tear the pin down and abort its signal.
 */

/**
 * Run File pin tests.
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

  const pin = new FilePin();
  const base = `${ctx.fixtureDir}/_filepin`;

  /**
   * Write a file under the fixture and hand back its absolute path.
   * @param {string} name - File name, unique to its test.
   * @param {string} content - What to put in it.
   * @returns {Promise<string>} The absolute path.
   */
  async function writeFixture(name, content) {
    const path = `${base}_${name}`;
    await writeFileOp({ path, content });
    return path;
  }

  /**
   * Mount the pin against a config, with a file-change service the test drives.
   * @param {Record<string, any>} config - The pin's config.
   * @param {{conversationId?: string}} [options] - Active-context details.
   * @returns {MountedPin} The mounted pin and its levers.
   */
  function mount(config, options = {}) {
    const body = document.createElement('div');
    body.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:300px';
    document.body.appendChild(body);

    const abort = new AbortController();
    /** @type {((changes: any[]) => void)[]} */
    const listeners = [];

    const controller = /** @type {any} */ (pin.mount(body, {
      pin: { id: 'pin_test', type: 'file', config },
      active: {
        project: { path: ctx.fixtureDir, displayName: 'fixture' },
        conversation: options.conversationId ? { id: options.conversationId, title: '' } : null,
        thread: null,
      },
      services: {
        files: {
          onChange: (listener) => {
            listeners.push(listener);
            return () => {
              const at = listeners.indexOf(listener);
              if (at >= 0) listeners.splice(at, 1);
            };
          },
        },
      },
      signal: abort.signal,
      updateConfig: async () => {},
    }));

    return {
      body,
      controller,
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
   * Wait for the pin's body to say something. The read is a real round-trip, so
   * there is nothing to await on directly.
   *
   * Losing the loading placeholder is not enough to wait for: `<file-view>`
   * paints its own content a frame or more later, so between the two the body
   * has neither the placeholder nor any text. Every case here expects content,
   * so wait for content — on a loaded pool that gap is wide enough to read.
   * @param {HTMLElement} body - The pin's body.
   * @param {number} [timeout] - How long to give it.
   * @returns {Promise<string>} The body's text.
   */
  async function settled(body, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = body.textContent || '';
      if (!body.querySelector('.file-content-loading') && text.trim()) return text;
      await new Promise((r) => { setTimeout(r, 20); });
    }
    throw new Error(`pin never finished loading (showed "${body.textContent}")`);
  }

  // ========================================================================
  // Config: normalization, dedupe, and what may become a pin
  // ========================================================================

  await test('a path is collapsed to one spelling', () => {
    assert(pin.normalizeConfig({ path: '/a//b/./c.txt' })?.path === '/a/b/c.txt',
      'repeated separators and `.` segments are collapsed');
    assert(pin.normalizeConfig({ path: '/a/b/../c.txt' })?.path === '/a/c.txt',
      '`..` is resolved against the segment before it');
    assert(pin.normalizeConfig({ path: '  /a/b.txt  ' })?.path === '/a/b.txt',
      'surrounding whitespace is not part of a path');
    assert(pin.normalizeConfig({ path: '/../etc' })?.path === '/etc',
      '`..` cannot walk above an absolute root');
  });

  await test('a trailing separator is what makes a pin a directory', () => {
    const dir = pin.normalizeConfig({ path: '/a/b/' });
    assert(dir?.path === '/a/b' && dir?.isDirectory === true,
      `a trailing slash means directory and is not kept in the path, got ${JSON.stringify(dir)}`);
    const file = pin.normalizeConfig({ path: '/a/b' });
    assert(file?.path === '/a/b' && file?.isDirectory === undefined,
      `without one it is a file and says nothing about directories, got ${JSON.stringify(file)}`);
  });

  await test('a config with no path is refused rather than pinned empty', () => {
    assert(pin.normalizeConfig({ path: '' }) === null, 'an empty path is not a pin');
    assert(pin.normalizeConfig({ path: '   ' }) === null, 'nor is whitespace');
    assert(pin.normalizeConfig({}) === null, 'nor is a config with no path at all');
    assert(pin.normalizeConfig({ path: 42 }) === null, 'nor is something that is not a string');
  });

  await test('two spellings of one file are one pin', () => {
    const a = /** @type {any} */ (pin.normalizeConfig({ path: '/a/b/../b/c.txt' }));
    const b = /** @type {any} */ (pin.normalizeConfig({ path: '/a//b/c.txt' }));
    assert(pin.isSameConfig(a, b), 'normalization is what makes the dedupe work');
    assert(!pin.isSameConfig(a, { path: '/a/b/d.txt' }), 'different files stay different pins');
  });

  await test('a live file is pinnable and a snapshot is not', () => {
    assert(FilePin.canPinSource({ kind: 'file', path: '/a/b.txt', presentation: 'live' }),
      'the live file a properties panel offers is exactly what this pin is for');
    assert(FilePin.canPinSource({ kind: 'file', path: '/a/b.txt' }),
      'a source that says nothing about presentation gets the live pin');
    assert(!FilePin.canPinSource({ kind: 'file', path: '/a/b.txt', presentation: 'snapshot' }),
      'a snapshot is a different promise, and taking it quietly would be worse than declining');
    assert(!FilePin.canPinSource({ kind: 'context-item', path: '/a/b.txt' }),
      'and this pin knows nothing about other kinds of source');
    assert(!FilePin.canPinSource({ kind: 'file', path: '  ' }), 'an empty path is not a source');
  });

  await test('a source becomes a config through the same normalization', () => {
    const config = FilePin.configFromSource({ kind: 'file', path: '/a//b/../b/c.txt', presentation: 'live' });
    assert(config?.path === '/a/b/c.txt',
      `pinning from a panel and from the picker must agree, got ${JSON.stringify(config)}`);
  });

  await test('describe reads the config and never the disk', () => {
    const described = pin.describe({ path: '/a/b/main.go' }, /** @type {any} */ ({}));
    assert(described.title === 'main.go', `the tab says the file, got "${described.title}"`);
    assert((described.subtitle || '').endsWith('/a/b/main.go'),
      `and the path underneath it, got "${described.subtitle}"`);
    assert(pin.describe({ path: '/a/b' , isDirectory: true }, /** @type {any} */ ({})).title === 'b/',
      'a directory says so in its title');
  });

  await test('a pin needs a project to resolve against', () => {
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '/x' } })) === true, 'with a project, addable');
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '' } })) === 'No project',
      'without one, the picker says why rather than hiding the entry');
  });

  // ========================================================================
  // Rendering a real file
  // ========================================================================

  await test('a pinned file shows what is on disk, through the file viewer', async () => {
    const path = await writeFixture('plain.txt', 'alpha\nbeta\ngamma\n');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      assert(!!mounted.body.querySelector('file-view'),
        'the pin hands the file to the viewer machinery rather than rendering bytes itself');
      assert((mounted.body.textContent || '').includes('beta'),
        `and what it renders is the file, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a pinned directory lists what is in it', async () => {
    await writeFixture('dir/inside.txt', 'here');
    const mounted = mount({ path: `${base}_dir`, isDirectory: true });
    try {
      const text = await settled(mounted.body);
      assert(text.includes('inside.txt'), `a directory pin lists its entries, got "${text}"`);
      assert(!mounted.body.querySelector('file-view'),
        'a listing is not a file, so no viewer is asked to show one');
    } finally {
      mounted.teardown();
    }
  });

  await test('a big file is previewed, not poured out', async () => {
    const lines = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n');
    const path = await writeFixture('big.txt', lines);
    const mounted = mount({ path });
    try {
      const text = await settled(mounted.body);
      assert(text.includes('line 1'), 'the preview starts at the beginning');
      assert(!text.includes('line 900'), 'and stops well before the end of a 900-line file');
      const note = mounted.body.querySelector('.file-pin__note');
      assert(!!note && /^First \d+ lines of 900\.$/.test(note.textContent || ''),
        `the pin says how much it is showing, got "${note?.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a path with nothing at it says so, and says which path', async () => {
    const missing = `${base}_never_written.txt`;
    const mounted = mount({ path: missing });
    try {
      const text = await settled(mounted.body);
      assert(text.includes('File not found'), `expected the missing state, got "${text}"`);
      assert(text.includes(missing), 'and the path it could not find, so the user can see the typo');
    } finally {
      mounted.teardown();
    }
  });

  await test('a file deleted or renamed under a pin turns into the missing state', async () => {
    const path = await writeFixture('doomed.txt', 'here for now');
    const mounted = mount({ path });
    try {
      assert((await settled(mounted.body)).includes('here for now'), 'it starts by showing the file');

      // Deleting through the test route is what a rename looks like from the
      // pin's side: the path it holds stops resolving.
      const url = `/api/test/delete-file?dir=${encodeURIComponent(ctx.fixtureDir)}`
        + `&path=${encodeURIComponent('_filepin_doomed.txt')}`;
      const response = await fetch(url, { method: 'POST' });
      assert(response.ok, 'the fixture file must actually be removed for this to prove anything');

      mounted.fireChange([{ path, event: 'remove' }]);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(mounted.body.textContent || '').includes('File not found')) {
        await new Promise((r) => { setTimeout(r, 20); });
      }
      assert((mounted.body.textContent || '').includes('File not found'),
        `a pin on a file that has gone says so, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // Staying current
  // ========================================================================

  await test('a change to the pinned file re-reads it', async () => {
    const path = await writeFixture('watched.txt', 'before');
    const mounted = mount({ path });
    try {
      assert((await settled(mounted.body)).includes('before'), 'it starts with what was there');
      await writeFileOp({ path, content: 'after' });
      mounted.fireChange([{ path, event: 'write' }]);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(mounted.body.textContent || '').includes('after')) {
        await new Promise((r) => { setTimeout(r, 20); });
      }
      assert((mounted.body.textContent || '').includes('after'),
        `the pin follows the file, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a change to some other file is ignored', async () => {
    const path = await writeFixture('quiet.txt', 'undisturbed');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      await writeFileOp({ path, content: 'changed behind its back' });
      mounted.fireChange([{ path: `${base}_somebody_else.txt`, event: 'write' }]);
      await new Promise((r) => { setTimeout(r, 400); });
      assert((mounted.body.textContent || '').includes('undisturbed'),
        'a pin that re-read on every file change would be a poll with extra steps');
    } finally {
      mounted.teardown();
    }
  });

  await test('a directory pin follows the files inside it', async () => {
    const mounted = mount({ path: `${base}_dir`, isDirectory: true });
    try {
      const before = await settled(mounted.body);
      assert(!before.includes('appeared.txt'), 'the new file is not there to begin with');

      // A file inside the directory is the directory changing.
      await writeFileOp({ path: `${base}_dir/appeared.txt`, content: 'new' });
      mounted.fireChange([{ path: `${base}_dir/appeared.txt`, event: 'create' }]);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(mounted.body.textContent || '').includes('appeared.txt')) {
        await new Promise((r) => { setTimeout(r, 20); });
      }
      assert((mounted.body.textContent || '').includes('appeared.txt'),
        `a directory pin re-lists when something inside it changes, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('Refresh re-reads a change the watcher never mentioned', async () => {
    const path = await writeFixture('unwatched.txt', 'first');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      await writeFileOp({ path, content: 'second' });
      const refresh = mounted.controller.getActions?.().find((a) => a.id === 'refresh');
      assert(!!refresh, 'the pin offers Refresh, because the watcher cannot see everything');
      await refresh?.run();
      assert((mounted.body.textContent || '').includes('second'),
        `Refresh must actually re-read, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('tearing a pin down stops it listening', async () => {
    const path = await writeFixture('tidy.txt', 'x');
    const mounted = mount({ path });
    await settled(mounted.body);
    assert(mounted.watchers() === 1, 'a mounted pin is watching its file');
    mounted.teardown();
    assert(mounted.watchers() === 0, 'and a torn-down one is not');
  });

  await test('the toolbar offers Open first and the rest behind it', async () => {
    const path = await writeFixture('actions.txt', 'x');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      const actions = mounted.controller.getActions?.() || [];
      assert(actions.filter((a) => a.primary).map((a) => a.id).join(',') === 'open',
        `Open is the one action worth a button, got ${JSON.stringify(actions.map((a) => a.id))}`);
      assert(actions.map((a) => a.id).join(',') === 'open,refresh,copy-path,reveal',
        'the rest wait in the overflow, in a fixed order');
      assert(actions.every((a) => typeof a.run === 'function' && a.label),
        'every action has words and something to do');
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // What a pin is, and is not
  // ========================================================================

  await test('a pin holds a path and never the file', async () => {
    const secret = 'nothing-in-board-state-should-say-this';
    const path = await writeFixture('bytes.txt', secret);
    const config = /** @type {any} */ (pin.normalizeConfig({ path }));
    const mounted = mount(config);
    try {
      assert((await settled(mounted.body)).includes(secret), 'the pin can see the file');
      assert(Object.keys(config).sort().join(',') === 'path',
        `and its config is the path alone, got ${JSON.stringify(config)}`);
      assert(!JSON.stringify(config).includes(secret),
        'board state is shared and long-lived; file bytes have no business in it');
    } finally {
      mounted.teardown();
    }
  });

  await test('a pin reads outside the project, because the pin is the grant', async () => {
    // The board is scoped to the project session, and a pin is something the
    // user named on purpose — the same footing as an `@`-mention, which reads
    // outside the root for as long as it exists. So a pin keeps reading until it
    // is removed, and removing it is how you stop. A pin above the project root
    // is the cheapest honest proof: it needs no grant and there is none.
    const outside = ctx.fixtureDir.replace(/\/[^/]+$/, '');
    assert(outside && outside !== ctx.fixtureDir, 'the fixture must have a parent to point at');
    const mounted = mount({ path: outside, isDirectory: true });
    try {
      const text = await settled(mounted.body);
      assert(!text.includes('File not found'),
        `a pin outside the project root still reads, got "${text}"`);
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // The affordance that creates one
  // ========================================================================

  await test('the Pin to Pinboard button appears only when something can pin', () => {
    const wrapper = document.createElement('div');
    /**
     * @param {HTMLElement} el - The rendered row.
     * @returns {Element|null} The pin button, if the row offered one.
     */
    const pinButton = (el) => el.querySelector('[aria-label="Pin to Pinboard"]');

    const registered = pinboardItemRegistry.getType('file');
    if (registered) pinboardItemRegistry.reset();
    addFilePath(wrapper, '/a/b.txt', undefined, { pin: '/a/b.txt' });
    assert(!pinButton(wrapper),
      'with nothing enabled to take the file, the button is absent rather than inert');

    pinboardItemRegistry.registerClass(FilePin, { extensionId: 'test' });
    const withProvider = document.createElement('div');
    addFilePath(withProvider, '/a/b.txt', undefined, { pin: '/a/b.txt' });
    const button = pinButton(withProvider);
    assert(!!button, 'with the File pin enabled, the row offers to pin the file');
    assert(button?.getAttribute('title') === 'Pin to Pinboard',
      'and says what it does without being clicked');

    const noPin = document.createElement('div');
    addFilePath(noPin, '/a/b.txt');
    assert(!pinButton(noPin),
      'a path row that was not given a path to pin offers nothing — a relative path is not an identity');
  });

  return { passed, failed, errors };
}
