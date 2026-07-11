//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * User-command factory tests.
 *
 * `user-command-factory.js` turns a declarative command definition (parsed from
 * a `.juggler/commands/*.md` file) into a runnable CommandType subclass. This
 * covers the two pure pieces — placeholder expansion and MANIFEST synthesis —
 * plus the per-run-mode behaviour of `execute()` against a minimal fake thread.
 * @module unit-tests/user-command-factory-test
 */

import { expandTemplate, makeUserCommandClass } from '../../js/plugins/user-command-factory.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run user-command factory tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
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

  // ---- expandTemplate ----

  await test('positional $1..$9 expand from args', () => {
    assert(expandTemplate('Deploy $1 to $2', ['app', 'prod']) === 'Deploy app to prod', 'positional');
  });

  await test('$ARGUMENTS joins every arg with a space', () => {
    assert(expandTemplate('Note: $ARGUMENTS', ['a', 'b', 'c']) === 'Note: a b c', 'arguments join');
  });

  await test('unfilled placeholders expand to empty string', () => {
    assert(expandTemplate('x=$1 y=$2', ['only']) === 'x=only y=', 'missing arg empty');
    assert(expandTemplate('$ARGUMENTS', []) === '', 'empty arguments');
  });

  await test('$$ is a literal dollar (escape)', () => {
    assert(expandTemplate('cost is $$5', []) === 'cost is $5', 'escaped dollar');
    assert(expandTemplate('$$1', ['x']) === '$1', '$$1 is literal $1, not the first arg');
  });

  await test('$10 is $1 followed by a literal 0 (single-digit placeholders)', () => {
    assert(expandTemplate('$10', ['A']) === 'A0', '$10 => arg1 + "0"');
  });

  await test('$0 is left literal (only $1..$9 are placeholders)', () => {
    assert(expandTemplate('$0', ['A']) === '$0', '$0 untouched');
  });

  await test('expandTemplate tolerates non-array args', () => {
    assert(expandTemplate('$1', /** @type {any} */ (null)) === '', 'null args => empty');
  });

  // ---- MANIFEST synthesis ----

  await test('makeUserCommandClass synthesises a valid MANIFEST', () => {
    const Cls = makeUserCommandClass({
      name: 'review-pr',
      scope: 'project',
      path: '/x/.juggler/commands/review-pr.md',
      frontmatter: { description: 'Review a PR', argsHint: '<n>', run: 'subthread', icon: 'icon-eye' },
      body: 'Review $1',
    });
    const m = /** @type {any} */ (Cls).MANIFEST;
    assert(m.id === 'review-pr', `id=${m.id}`);
    assert(m.name === 'Review Pr', `name=${m.name}`);
    assert(m.description === 'Review a PR', `description=${m.description}`);
    assert(m.icon === 'icon-eye', `icon=${m.icon}`);
    assert(m.userDefined === true, 'userDefined flag');
    assert(m.scope === 'project', `scope=${m.scope}`);
    assert(m.argsHint === '<n>', `argsHint=${m.argsHint}`);
    assert(m.runMode === 'subthread', `runMode=${m.runMode}`);
    assert(m.mutatesConversation === false, 'not mutatesConversation');
  });

  await test('MANIFEST defaults: send mode + fallback icon', () => {
    const Cls = makeUserCommandClass({
      name: 'standup', scope: 'user', path: '/x', frontmatter: { description: 'd' }, body: 'b',
    });
    const m = /** @type {any} */ (Cls).MANIFEST;
    assert(m.runMode === 'send', `runMode=${m.runMode}`);
    assert(m.icon === 'icon-slash', `icon=${m.icon}`);
  });

  // ---- execute() per run mode ----

  await test('draft mode returns a setDraft side effect with the expanded text', async () => {
    const Cls = makeUserCommandClass({
      name: 'draft-it', scope: 'user', path: '/x',
      frontmatter: { description: 'd', run: 'draft' }, body: 'Hello $1',
    });
    const cmd = new Cls({ messageThread: { conversation: {}, threadItemId: null } });
    const res = await cmd.execute(['world']);
    assert(res.handled === true, 'handled');
    assert(Array.isArray(res.sideEffects) && res.sideEffects.length === 1, 'one side effect');
    assert(res.sideEffects[0].type === 'setDraft', `type=${res.sideEffects[0].type}`);
    assert(res.sideEffects[0].data.text === 'Hello world', `text=${res.sideEffects[0].data.text}`);
  });

  await test('send mode dispatches the expanded prompt via sendMessage', async () => {
    /** @type {any} */
    let sent = null;
    const fakeThread = {
      threadItemId: 'thr-1',
      conversation: { sendMessage: (/** @type {any} */ text, /** @type {any} */ tid, /** @type {any} */ mt) => { sent = { text, tid, mt }; return Promise.resolve(null); } },
    };
    const Cls = makeUserCommandClass({
      name: 'send-it', scope: 'user', path: '/x',
      frontmatter: { description: 'd', run: 'send' }, body: 'Do $1 now',
    });
    const cmd = new Cls({ messageThread: fakeThread });
    const res = await cmd.execute(['it']);
    assert(res.handled === true, 'handled');
    assert(sent && sent.text === 'Do it now', `sent text=${sent && sent.text}`);
    assert(sent.tid === 'thr-1', `threadItemId forwarded=${sent && sent.tid}`);
  });

  await test('subthread mode calls runInThread with goal, prompt, and strategy override', async () => {
    /** @type {any} */
    let call = null;
    const fakeThread = {
      runInThread: (/** @type {any} */ opts) => { call = opts; return Promise.resolve({ threadItemId: 't', result: 'r' }); },
    };
    const Cls = makeUserCommandClass({
      name: 'review', scope: 'project', path: '/x',
      frontmatter: { description: 'd', run: 'subthread', strategy: 'read-only', goal: 'PR review' },
      body: 'Review $1',
    });
    const cmd = new Cls({ messageThread: fakeThread });
    const res = await cmd.execute(['42']);
    assert(res.handled === true, 'handled');
    assert(call && call.goal === 'PR review', `goal=${call && call.goal}`);
    assert(call.prompt === 'Review 42', `prompt=${call.prompt}`);
    assert(call.strategyId === 'read-only', `strategyId=${call.strategyId}`);
  });

  await test('execute with no thread is a graceful error, not a throw', async () => {
    const Cls = makeUserCommandClass({
      name: 'x', scope: 'user', path: '/x', frontmatter: { description: 'd' }, body: 'b',
    });
    const cmd = new Cls({ messageThread: undefined });
    const res = await cmd.execute([]);
    assert(res.handled === true && res.error === true, 'handled error result');
  });

  return { passed, failed, errors };
}
