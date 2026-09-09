//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Per-line highlighting.
 *
 * A construct spanning several lines — a block comment, a template literal —
 * must keep its tokens on every line it covers, and splitting one block of
 * markup into per-line strings must leave each line balanced on its own and the
 * visible text untouched. The line-numbered grid is the surface that consumes
 * this, so it is checked here too.
 * @module unit-tests/highlight-lines-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { highlightCodeLines } = await import('../../sdk/lib/syntax-highlight.js');
  const { createCodeBlock } = await import('../../sdk/lib/context-item-utils.js');

  /**
   * @param {string} label - Case name
   * @param {() => void} fn - Case body
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * @param {string} html - One line of highlighted markup
   * @returns {HTMLElement} A `<code>` holding that line
   */
  const asElement = (html) => {
    const code = document.createElement('code');
    code.innerHTML = html;
    return code;
  };

  /**
   * @param {string[]} lines - Highlighted lines
   * @returns {string} The visible text of all of them, newline-joined
   */
  const textOf = (lines) => lines.map((line) => asElement(line).textContent).join('\n');

  const BLOCK_COMMENT = 'const a = 1;\n/* one\n   two\n   three */\nconst b = 2;';

  run('a block comment keeps its token on every line it covers', () => {
    const lines = highlightCodeLines(BLOCK_COMMENT, 'javascript');
    assert(lines.length === 5, `expected 5 lines, got ${lines.length}`);
    for (const i of [1, 2, 3]) {
      assert(asElement(lines[i] || '').querySelector('.token.comment') !== null,
        `line ${i} lost its comment token`);
    }
    assert(textOf(lines) === BLOCK_COMMENT, 'splitting changed the visible text');
  });

  run('a multi-line template literal keeps its token on every line', () => {
    const src = 'const t = `first\nsecond\nthird`;';
    const lines = highlightCodeLines(src, 'javascript');
    assert(lines.length === 3, `expected 3 lines, got ${lines.length}`);
    for (const i of [0, 1, 2]) {
      assert(asElement(lines[i] || '').querySelector('.token.template-string, .token.string') !== null,
        `line ${i} lost its string token`);
    }
    assert(textOf(lines) === src, 'splitting changed the visible text');
  });

  run('every line is balanced markup on its own', () => {
    for (const line of highlightCodeLines('/* a\nb */', 'javascript')) {
      const holder = document.createElement('code');
      holder.innerHTML = line;
      // An unbalanced line would be repaired by the parser, so serialising it
      // back would not give the string we put in.
      assert(holder.innerHTML === line, `the browser repaired the markup: ${holder.innerHTML}`);
    }
  });

  run('a c++ block comment survives the split', () => {
    const src = 'int a = 1;\n/* one\n   two */\nint b = 2;';
    const lines = highlightCodeLines(src, 'cpp');
    assert(asElement(lines[2] || '').querySelector('.token.comment') !== null,
      'the second comment line lost its token');
    assert(textOf(lines) === src, 'splitting changed the visible text');
  });

  run('an unbundled language returns escaped lines', () => {
    const lines = highlightCodeLines('<b>a</b>\n<i>b</i>', 'nosuchlang');
    assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
    assert(lines[0] === '&lt;b&gt;a&lt;/b&gt;', `unescaped first line: ${lines[0]}`);
    assert(asElement(lines[0] || '').querySelector('b') === null, 'markup in the source became live');
  });

  run('bash lines keep the command-oriented highlighting', () => {
    const src = 'cd foo && make test\necho done';
    const lines = highlightCodeLines(src, 'bash');
    assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
    assert(asElement(lines[0] || '').querySelector('.bash-command-head') !== null,
      'the command word should still be marked');
    assert(textOf(lines) === src, 'splitting changed the visible text');
  });

  run('empty and single-line input behave', () => {
    assert(highlightCodeLines('', 'javascript').length === 1, 'empty input should be one line');
    assert(highlightCodeLines('', 'javascript')[0] === '', 'that line should be empty');
    assert(highlightCodeLines('const a = 1;', 'javascript').length === 1, 'one line in, one line out');
    assert(highlightCodeLines('a\n', 'javascript').length === 2, 'a trailing newline yields a last empty line');
  });

  run('a line-numbered grid tokenises against the whole block', () => {
    const block = createCodeBlock({ content: BLOCK_COMMENT, language: 'javascript', lineNumberStart: 1 });
    const lines = block.querySelectorAll('.ci-line');
    assert(lines.length === 5, `expected 5 grid lines, got ${lines.length}`);
    assert([...lines].map((line) => line.getAttribute('data-line')).join(',') === '1,2,3,4,5',
      'the gutter numbering changed');
    for (const i of [1, 2, 3]) {
      assert(lines[i]?.querySelector('.token.comment') !== null, `grid line ${i} lost its comment token`);
    }
    assert([...lines].map((line) => line.textContent).join('\n') === BLOCK_COMMENT,
      'the grid changed the visible text');
  });

  return { passed, failed, errors };
}
