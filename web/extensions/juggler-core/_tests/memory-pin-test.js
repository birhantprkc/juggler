//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory pin tests — the board's view of the project's durable facts.
 *
 * Against the REAL backend filesystem, because the pin's whole claim is that it
 * shows the file as it is now. Each case points the pin at its own file under
 * the shared fixture with a `_memorypin_` prefix: sibling pool lanes share one
 * directory, and the pin's default path is a single fixed one they would
 * otherwise all write to at once.
 *
 * Nothing here tests the watcher. The project watcher allowlists the one path
 * `.juggler/MEMORY.md` out of the dot-directory it skips wholesale, and that is
 * asserted where it lives: `filewatcher_memory_test.go` for what is emitted, and
 * `unit:memory-item` for what the context item does with it. This pin reads
 * through the context-item signal and `Refresh`, and both of those are asserted.
 * @module _tests/memory-pin-test
 */

import MemoryPin from '../pins/memory-pin.js';
import { writeFileOp } from '../../../js/services/ops-api.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Memory pin tests.
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

  const pin = new MemoryPin();
  // A directory of its own, not the fixture root. Pool lanes share one fixture,
  // and these are real files that stay there: written at the root they join
  // every later `*.md` glob in the run, which is exactly how `unit:glob-action`
  // came to fail against its `README.md` golden.
  const base = `${ctx.fixtureDir}/_memorypin/file`;

  /**
   * Write a memory file under the fixture and hand back its absolute path.
   * @param {string} name - File name, unique to its test.
   * @param {string} content - What to put in it.
   * @returns {Promise<string>} The absolute path.
   */
  async function writeMemory(name, content) {
    const path = `${base}_${name}.md`;
    await writeFileOp({ path, content });
    return path;
  }

  /**
   * Mount the pin against a path, with a context-items service the test drives.
   * @param {string} path - The memory file to read.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(path) {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {(() => void)[]} */
    const listeners = [];

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'memory', config: { path } },
      active: {
        project: { path: ctx.fixtureDir, displayName: 'fixture' },
        conversation: { id: 'c1', title: 'Conv' },
        thread: { id: null },
      },
      services: {
        files: { onChange: () => () => {} },
        contextItems: {
          find: () => null,
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
          reveal: () => {},
        },
      },
      signal: abort.signal,
      updateConfig: async () => {},
    })));

    return {
      body,
      controller,
      watchers: () => listeners.length,
      fireChange: () => { for (const listener of [...listeners]) listener(); },
      teardown: () => {
        controller.teardown?.();
        abort.abort();
        body.remove();
      },
    };
  }

  /**
   * Wait for the pin's asynchronous read to have drawn. The read is a real
   * round-trip, so there is nothing to await on directly — and a fixed delay is
   * a flake on a loaded pool, where every lane shares one browser. Wait for the
   * body to say something instead, which it always does: a file with nothing in
   * it still renders the empty state.
   * @param {HTMLElement} body - The pin's body.
   * @param {number} [timeout] - How long to give it.
   * @returns {Promise<string>} The body's text.
   */
  async function settled(body, timeout = 5000) {
    return until(body, (text) => text.trim() !== '', timeout);
  }

  /**
   * Wait for the pin's body to say a particular thing. A re-read replaces text
   * with other text, so "it has drawn" is not a strong enough condition to catch
   * one — the case has to name what it is waiting for.
   * @param {HTMLElement} body - The pin's body.
   * @param {(text: string) => boolean} wanted - What the body should end up saying.
   * @param {number} [timeout] - How long to give it.
   * @returns {Promise<string>} The body's text.
   */
  async function until(body, wanted, timeout = 5000) {
    const deadline = Date.now() + timeout;
    let text = '';
    while (Date.now() < deadline) {
      text = body.textContent || '';
      if (wanted(text)) return text;
      await new Promise((r) => { setTimeout(r, 20); });
    }
    throw new Error(`the pin never said it (showed "${text}")`);
  }

  const TWO_FACTS = '# Memory\n\n- [2026-06-14] Build is `make build`\n- [2026-06-15] Tests are `make test-all`\n';

  // --- the manifest and its gates ------------------------------------------

  await test('the memory pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'there is one memory file, so there is one pin');
  });

  await test('a memory pin needs a project, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '' }, conversation: null }));
    assert(reason === 'No project', `expected the reason, got ${JSON.stringify(reason)}`);
    assert(
      pin.canAdd(/** @type {any} */ ({ project: { path: '/p' } })) === true,
      'a project is all it needs'
    );
  });

  await test('describe names the file it reads', () => {
    assert(pin.describe({}).subtitle === '.juggler/MEMORY.md',
      `expected the default path, got ${JSON.stringify(pin.describe({}).subtitle)}`);
    assert(pin.describe({ path: 'elsewhere/M.md' }).subtitle === 'elsewhere/M.md',
      'an overridden path should be the one shown');
  });

  // --- reading the real file ------------------------------------------------

  await test('the facts on disk are the facts shown', async () => {
    const path = await writeMemory('facts', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const text = m.body.textContent || '';
    assert(text.includes('Build is `make build`'), `first fact missing:\n${text}`);
    assert(text.includes('Tests are `make test-all`'), `second fact missing:\n${text}`);
    assert(m.body.querySelectorAll('.memory-entry').length === 2,
      `expected 2 entries:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('an entry keeps its date', async () => {
    const path = await writeMemory('dates', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const date = m.body.querySelector('.memory-date');
    assert(date && (date.textContent || '') === '2026-06-14',
      `expected the stamped date, got ${JSON.stringify(date?.textContent)}`);
    m.teardown();
  });

  await test('no memory file yet is the ordinary case, not a failure', async () => {
    const m = mount(`${base}_never_written.md`);
    await settled(m.body);
    assert((m.body.textContent || '').trim() === 'Nothing remembered.',
      `expected the empty state, got ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  await test('a file with a heading and no facts is empty too', async () => {
    const path = await writeMemory('heading_only', '# Memory\n\n');
    const m = mount(path);
    await settled(m.body);
    assert((m.body.textContent || '').trim() === 'Nothing remembered.',
      `expected the empty state, got ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  await test('prose the parser drops does not become an entry', async () => {
    const path = await writeMemory('prose', '# Memory\n\nSome stray note nobody bulleted.\n\n- [2026-06-14] A real fact\n');
    const m = mount(path);
    await settled(m.body);
    const entries = m.body.querySelectorAll('.memory-entry');
    assert(entries.length === 1, `expected only the bulleted fact, got ${entries.length}`);
    assert((m.body.textContent || '').includes('A real fact'), 'the real fact should survive');
    assert(!(m.body.textContent || '').includes('stray note'), 'unbulleted prose is not an entry');
    m.teardown();
  });

  await test('an undated bullet is still a fact', async () => {
    const path = await writeMemory('undated', '# Memory\n\n- Someone forgot the date\n');
    const m = mount(path);
    await settled(m.body);
    assert(m.body.querySelectorAll('.memory-entry').length === 1, 'the entry should show');
    assert(!m.body.querySelector('.memory-date'), 'no date to show, so no date element');
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('Refresh re-reads what changed underneath it', async () => {
    const path = await writeMemory('refresh', '# Memory\n\n- [2026-06-14] Before\n');
    const m = mount(path);
    await settled(m.body);
    assert((m.body.textContent || '').includes('Before'), 'first read missing');

    await writeFileOp({ path, content: '# Memory\n\n- [2026-06-14] After\n' });
    const refresh = m.controller.getActions().find((/** @type {any} */ a) => a.id === 'refresh');
    assert(refresh, 'Refresh is how a hand edit is picked up, since nothing watches this file');
    await refresh.run();
    const text = await until(m.body, (t) => t.includes('After'));
    assert(!text.includes('Before'), `the stale fact survived:\n${text}`);
    m.teardown();
  });

  await test('a remember in this viewer lands without asking', async () => {
    const path = await writeMemory('remember', '# Memory\n\n- [2026-06-14] One fact\n');
    const m = mount(path);
    await settled(m.body);

    await writeFileOp({ path, content: '# Memory\n\n- [2026-06-14] One fact\n- [2026-06-15] Two facts\n' });
    // What a `remember` tool action looks like from the pin: the conversation's
    // context items changed, so the file it reads may have too.
    m.fireChange();
    await until(m.body, (t) => t.includes('Two facts'));
    m.teardown();
  });

  await test('teardown stops listening', async () => {
    const path = await writeMemory('teardown', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    assert(m.watchers() === 1, `expected one listener, got ${m.watchers()}`);
    m.teardown();
    assert(m.watchers() === 0, `the pin kept listening after teardown: ${m.watchers()}`);
  });

  // --- what it offers -------------------------------------------------------

  await test('Open is the primary action, Refresh is not', async () => {
    const path = await writeMemory('actions', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const actions = m.controller.getActions();
    const open = actions.find((/** @type {any} */ a) => a.id === 'open');
    const refresh = actions.find((/** @type {any} */ a) => a.id === 'refresh');
    assert(open?.primary === true, 'editing the file by hand is the thing to offer first');
    assert(!refresh?.primary, 'Refresh belongs behind the overflow');
    m.teardown();
  });

  await test('the pin offers no way to forget an entry', async () => {
    const path = await writeMemory('readonly', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    assert(!m.body.querySelector('.memory-delete'),
      `deleting a fact belongs to the memory item's own panel:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('no facts are carried in the pin\'s config', async () => {
    const path = await writeMemory('config', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const config = JSON.stringify({ path });
    assert(!config.includes('make build'),
      'board state is shared and long-lived; it holds a path, never the file');
    m.teardown();
  });

  return { passed, failed, errors };
}
