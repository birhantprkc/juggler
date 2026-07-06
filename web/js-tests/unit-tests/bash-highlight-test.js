//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Command-oriented bash highlighting unit tests.
 * @module unit-tests/bash-highlight-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { highlightCode } = await import('../../sdk/lib/syntax-highlight.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {string} command
   * @returns {HTMLElement} A `<code>` element containing the highlighted command.
   */
  const render = (command) => {
    const code = document.createElement('code');
    code.innerHTML = highlightCode(command, 'bash');
    return code;
  };

  run('splits compound commands into coloured sections and operators', () => {
    const el = render('cd foo && make test && make build');
    assert(el.querySelectorAll('.bash-command-segment').length === 3, 'expected three command segments');
    assert(el.querySelectorAll('.bash-command-operator').length === 2, 'expected two operators');
    assert(el.querySelectorAll('.bash-command-head').length === 3, 'expected three command heads');
    assert([...el.querySelectorAll('.bash-command-head')].map(n => n.textContent).join(',') === 'cd,make,make', 'wrong command heads');
    assert(el.textContent === 'cd foo && make test && make build', 'render changed visible text');
  });

  run('renders command head more specifically than its arguments', () => {
    const el = render('git help branch');
    assert(el.querySelector('.bash-command-head')?.textContent === 'git', 'git should be command head');
    assert([...el.querySelectorAll('.bash-command-arg')].map(n => n.textContent).join('') === 'helpbranch', 'args should be highlighted separately');
  });

  run('does not split operators inside quoted strings', () => {
    const el = render('echo "a && b | c" && cat out.txt');
    assert(el.querySelectorAll('.bash-command-segment').length === 2, 'quoted operators should not split segments');
    assert(el.querySelectorAll('.bash-command-operator').length === 1, 'only top-level && should be an operator');
    assert(el.textContent === 'echo "a && b | c" && cat out.txt', 'render changed visible text');
  });

  run('highlights redirection operators and targets', () => {
    const el = render('make test > result.log');
    assert(el.querySelector('.bash-command-redirect-operator')?.textContent === '>', 'redirection operator not marked');
    assert(el.querySelector('.bash-command-redirect-target')?.textContent === 'result.log', 'redirection target not marked');
  });

  run('keeps command substitutions within their containing segment', () => {
    const el = render('echo $(printf "a && b") && wc -l');
    assert(el.querySelectorAll('.bash-command-segment').length === 2, 'substitution operator should stay inside segment');
    assert(el.querySelectorAll('.bash-command-operator').length === 1, 'only outer && should split');
  });

  run('keeps compact file descriptor duplication as command text', () => {
    const el = render('make test 2>&1 | tee build.log');
    assert(el.querySelectorAll('.bash-command-operator').length === 1, 'only the pipe should split the command');
    assert(el.textContent === 'make test 2>&1 | tee build.log', 'render changed visible text');
    assert(el.querySelector('.bash-command-arg')?.textContent === 'test', 'arguments should still be styled normally');
  });

  run('escapes unsafe HTML while highlighting', () => {
    const el = render('echo <script>alert(1)</script>');
    assert(el.querySelector('script') === null, 'unsafe script element was created');
    assert(el.textContent === 'echo <script>alert(1)</script>', 'visible text should preserve escaped shell text');
    assert(el.querySelectorAll('.bash-command-operator').length === 4, 'angle brackets should be shell operators');
  });

  return { passed, failed, errors };
}
