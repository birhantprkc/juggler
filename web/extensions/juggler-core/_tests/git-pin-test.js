//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests — the board's view of the working tree.
 *
 * Mounted with a hand-built PinContext whose `git` service the test drives, so a
 * case can state a repository state exactly rather than arranging for git to be
 * in it. One case goes through the real service to the real server, which is
 * what proves the two halves agree about the shape they pass.
 * @module _tests/git-pin-test
 */

import GitPin from '../pins/git-pin.js';
import gitStatusCache from '../../../js/services/git-status-cache.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Git pin tests.
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

  const pin = new GitPin();

  /**
   * A repo with everything filled in, so a case overrides only what it is about.
   * @param {Partial<import('juggler/pinboard-item-type').PinGitRepo>} [overrides] - What this case cares about.
   * @returns {any} The repo.
   */
  const repo = (overrides = {}) => ({
    path: '',
    changed: 0,
    staged: 0,
    total: 0,
    branch: 'develop',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
    truncated: false,
    ...overrides,
  });

  /**
   * Mount the pin against a canned status.
   * @param {any} status - What `git.status()` should return.
   * @param {string} [error] - What `git.error()` should return.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(status, error = '') {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {(() => void)[]} */
    const listeners = [];
    let current = status;
    let currentError = error;
    let refreshes = 0;

    const services = {
      files: { onChange: () => () => {} },
      contextItems: { find: () => null, onChange: () => () => {}, reveal: () => {} },
      git: {
        status: () => current,
        error: () => currentError,
        /**
         * @param {() => void} listener - Called when a new status arrives.
         * @returns {() => void} Unsubscribe.
         */
        onChange: (listener) => {
          listeners.push(listener);
          return () => {
            const at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          };
        },
        refresh: async () => { refreshes++; },
      },
    };

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'git', config: {} },
      active: {
        project: { path: '/tmp/proj', displayName: 'proj' },
        conversation: { id: 'c1', title: 'Conv' },
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
      text: () => body.textContent || '',
      watchers: () => listeners.length,
      refreshes: () => refreshes,
      /**
       * @param {any} next - The new status.
       * @param {string} [nextError] - The new error.
       */
      setStatus: (next, nextError = '') => { current = next; currentError = nextError; },
      fireChange: () => { for (const listener of [...listeners]) listener(); },
      teardown: () => {
        controller.teardown?.();
        abort.abort();
        body.remove();
      },
    };
  }

  // --- the manifest and its gates ------------------------------------------

  await test('the git pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'two git pins would show the same tree twice');
  });

  await test('a git pin needs a project, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '' }, conversation: null }));
    assert(reason === 'No project', `expected the reason, got ${JSON.stringify(reason)}`);
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '/p' } })) === true,
      'a project is all it needs — a git pin does not need a conversation');
  });

  await test('describe reads nothing, because layout calls it', () => {
    const described = pin.describe();
    assert(described.title === 'Git', `expected 'Git', got ${described.title}`);
    // The branch would be the obvious badge, and describe gets no services to
    // find it with. Plan and Todo hit the same wall; the body says it instead.
    assert(!described.badge, 'a badge would need the service, which describe is not given');
  });

  await test('the git working tree is a pinnable source, and nothing else is', () => {
    assert(GitPin.canPinSource(/** @type {any} */ ({ kind: 'git' })) === true, 'git should be pinnable');
    assert(GitPin.canPinSource(/** @type {any} */ ({ kind: 'file', path: '/p/a.js' })) === false,
      'a file belongs to the File pin, not this one');
    assert(GitPin.configFromSource(/** @type {any} */ ({ kind: 'git' })) !== null,
      'a git source should produce a config');
    assert(GitPin.configFromSource(/** @type {any} */ ({ kind: 'file' })) === null,
      'a source it rejects should produce no config');
  });

  // --- what it draws --------------------------------------------------------

  await test('nothing read yet is not no repository', () => {
    const m = mount(null);
    assert(m.text().trim() === 'Checking…', `expected 'Checking…', got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a project without git says so plainly', () => {
    const m = mount({ root: '/tmp/proj', repos: [] });
    assert(m.text().trim() === 'No git repository.', `got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a clean tree shows its branch and nothing else', () => {
    const m = mount({ root: '/tmp/proj', repos: [repo({ branch: 'main' })] });
    const text = m.text();
    assert(text.includes('main'), `branch missing:\n${text}`);
    assert(text.includes('Nothing changed.'), `expected the clean state:\n${text}`);
    assert(!m.body.querySelector('.git-pin__file'), 'a clean tree has no file rows');
    m.teardown();
  });

  await test('the changed files are listed with their status codes', () => {
    const m = mount({
      root: '/tmp/proj',
      repos: [repo({
        changed: 1,
        staged: 1,
        total: 2,
        files: [
          { path: 'web/js/app.js', index: 'M', worktree: '.' },
          { path: 'notes.md', index: '.', worktree: '?' },
        ],
      })],
    });
    const rows = m.body.querySelectorAll('.git-pin__file');
    assert(rows.length === 2, `expected 2 file rows, got ${rows.length}:\n${m.body.innerHTML}`);
    const text = m.text();
    assert(text.includes('web/js/app.js') && text.includes('notes.md'), `paths missing:\n${text}`);
    assert(text.includes('1 changed, 1 staged'), `counts missing:\n${text}`);
    m.teardown();
  });

  await test('a status code says in words what its letters mean', () => {
    const m = mount({
      root: '/tmp/proj',
      repos: [repo({ changed: 1, total: 1, files: [{ path: 'a.js', index: '.', worktree: '?' }] })],
    });
    const code = m.body.querySelector('.git-pin__code');
    assert(code?.title === 'Untracked', `expected the letters explained, got ${JSON.stringify(code?.title)}`);
    m.teardown();
  });

  await test('a branch ahead of its upstream says how far', () => {
    const m = mount({
      root: '/tmp/proj',
      repos: [repo({ upstream: 'origin/develop', ahead: 2, behind: 1 })],
    });
    const text = m.text();
    assert(text.includes('2 ahead'), `ahead missing:\n${text}`);
    assert(text.includes('1 behind'), `behind missing:\n${text}`);
    m.teardown();
  });

  await test('a branch level with its upstream says so, and one without says nothing', () => {
    const level = mount({ root: '/tmp/proj', repos: [repo({ upstream: 'origin/main' })] });
    assert(level.text().includes('Up to date'), `expected 'Up to date':\n${level.text()}`);
    level.teardown();

    const untracked = mount({ root: '/tmp/proj', repos: [repo({ upstream: '' })] });
    // A branch with no upstream is not up to date with anything, and it is not
    // behind either — claiming a relationship it has not got would be a lie.
    assert(!untracked.text().includes('Up to date'),
      `a branch with no upstream is not up to date:\n${untracked.text()}`);
    assert(!untracked.text().includes('behind'), `nothing to be behind:\n${untracked.text()}`);
    untracked.teardown();
  });

  await test('a detached head is a state, not a branch name', () => {
    const m = mount({ root: '/tmp/proj', repos: [repo({ branch: '', detached: true })] });
    assert(m.text().includes('Detached head'), `expected the state:\n${m.text()}`);
    m.teardown();
  });

  await test('a truncated list counts what it left out', () => {
    const m = mount({
      root: '/tmp/proj',
      repos: [repo({
        changed: 431,
        total: 431,
        truncated: true,
        files: [{ path: 'a.js', index: '.', worktree: 'M' }],
      })],
    });
    assert(m.text().includes('First 1 of 431 files.'), `expected the real total:\n${m.text()}`);
    m.teardown();
  });

  // --- several repositories -------------------------------------------------

  await test('a lone repo at the project root goes unlabelled', () => {
    const m = mount({ root: '/tmp/proj', repos: [repo({ path: '', changed: 1, total: 1 })] });
    assert(!m.body.querySelector('.git-pin__name'),
      `one repo at the root needs no label:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('nested repos each get their own block and their own name', () => {
    const m = mount({
      root: '/tmp/proj',
      repos: [
        repo({ path: '', branch: 'main', changed: 1, total: 1 }),
        repo({ path: 'juggler', branch: 'develop', changed: 2, total: 2 }),
      ],
    });
    const blocks = m.body.querySelectorAll('.git-pin__repo');
    assert(blocks.length === 2, `expected a block each, got ${blocks.length}`);
    const names = [...m.body.querySelectorAll('.git-pin__name')].map((/** @type {any} */ n) => n.textContent);
    // The root repo is named for the project folder; a bare "." would be cryptic.
    assert(names.includes('proj') && names.includes('juggler'),
      `expected both repos named, got ${JSON.stringify(names)}`);
    const text = m.text();
    assert(text.includes('main') && text.includes('develop'),
      `each repo keeps its own branch:\n${text}`);
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('a new status redraws the pin', () => {
    const m = mount({ root: '/tmp/proj', repos: [repo({ branch: 'main' })] });
    assert(m.text().includes('Nothing changed.'), `expected the clean state first:\n${m.text()}`);

    m.setStatus({
      root: '/tmp/proj',
      repos: [repo({ branch: 'main', changed: 1, total: 1, files: [{ path: 'new.js', index: '.', worktree: 'M' }] })],
    });
    m.fireChange();
    assert(m.text().includes('new.js'), `expected the new file after a change:\n${m.text()}`);
    m.teardown();
  });

  await test('the pin asks for a status when it mounts', () => {
    const m = mount(null);
    assert(m.refreshes() === 1, `expected one refresh on mount, got ${m.refreshes()}`);
    m.teardown();
  });

  await test('Refresh is the only action, and it asks again', async () => {
    const m = mount({ root: '/tmp/proj', repos: [repo()] });
    const actions = m.controller.getActions();
    assert(actions.length === 1, `expected one action, got ${actions.map((/** @type {any} */ a) => a.id).join(', ')}`);
    assert(actions[0].id === 'refresh' && actions[0].primary === true,
      'Refresh is the whole point of a pin over a poll, so it is the primary action');
    assert(actions[0].icon === 'refresh',
      'and it is the same glyph a refresh wears everywhere else');
    const before = m.refreshes();
    await actions[0].run();
    assert(m.refreshes() === before + 1, 'Refresh should ask the service again');
    m.teardown();
  });

  await test('a new active context redraws in place rather than remounting', () => {
    const m = mount({ root: '/tmp/proj', repos: [repo({ branch: 'main' })] });
    m.setStatus({ root: '/tmp/proj', repos: [repo({ branch: 'release' })] });
    m.controller.update({
      pin: { id: 'pin_test', type: 'git', config: {} },
      active: { project: { path: '/tmp/proj', displayName: 'proj' }, conversation: null, thread: null },
      services: m.services,
      signal: new AbortController().signal,
      updateConfig: async () => {},
    });
    assert(m.text().includes('release'),
      `update should re-read through the context it was handed:\n${m.text()}`);
    assert(m.watchers() === 1, `update must not stack a second watcher, got ${m.watchers()}`);
    m.teardown();
  });

  await test('teardown stops watching', () => {
    const m = mount({ root: '/tmp/proj', repos: [repo()] });
    assert(m.watchers() === 1, `expected one watcher while mounted, got ${m.watchers()}`);
    m.controller.teardown();
    assert(m.watchers() === 0, `expected no watcher after teardown, got ${m.watchers()}`);
    m.teardown();
  });

  // --- failures -------------------------------------------------------------

  await test("a failure before any status keeps the error text", () => {
    const m = mount(null, 'git: command not found');
    const text = m.text();
    assert(text.includes("Couldn't read git status."), `expected the plain-English lead:\n${text}`);
    assert(text.includes('git: command not found'),
      `the underlying error must survive, not be replaced:\n${text}`);
    m.teardown();
  });

  await test('a failed refresh keeps the last good status on screen', () => {
    const m = mount({
      root: '/tmp/proj',
      repos: [repo({ changed: 1, total: 1, files: [{ path: 'a.js', index: '.', worktree: 'M' }] })],
    }, 'network error');
    const text = m.text();
    assert(text.includes('a.js'), `blanking the panel loses more than staleness costs:\n${text}`);
    assert(text.includes("Couldn't refresh.") && text.includes('network error'),
      `and it says why it is stale, with the error intact:\n${text}`);
    m.teardown();
  });

  // --- against the real service ---------------------------------------------

  await test('the real service hands the pin the shape it expects', async () => {
    await gitStatusCache.refresh();
    const status = gitStatusCache.get();
    assert(status !== null, 'the server should answer a git status request');
    assert(typeof status.root === 'string' && Array.isArray(status.repos),
      `expected {root, repos}, got ${JSON.stringify(status)}`);
    for (const found of status.repos) {
      assert(typeof found.path === 'string', `repo.path missing: ${JSON.stringify(found)}`);
      assert(typeof found.changed === 'number' && typeof found.staged === 'number',
        `counts missing: ${JSON.stringify(found)}`);
      assert(typeof found.total === 'number', `total missing: ${JSON.stringify(found)}`);
      assert(typeof found.branch === 'string', `branch missing: ${JSON.stringify(found)}`);
      assert(Array.isArray(found.files), `files missing: ${JSON.stringify(found)}`);
      assert(typeof found.truncated === 'boolean', `truncated missing: ${JSON.stringify(found)}`);
    }
  });

  return { passed, failed, errors };
}
