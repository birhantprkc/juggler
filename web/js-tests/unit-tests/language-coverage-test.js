//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Drift guard between the language tables and the vendored Prism grammars.
 *
 * A language the app can resolve but has no grammar for degrades silently to
 * escaped plain text: the code still renders, just uncoloured, so nothing else
 * in the suite would notice — which is how the app came to claim thirteen
 * languages it could not colour. Naming a language in `sdk/lib/languages.js`
 * without vendoring its grammar into BOTH `web/index.html` and
 * `web/js-tests/headless-test.html` fails here.
 * @module unit-tests/language-coverage-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Languages that deliberately have no Prism grammar: `text` is the plain
 * fallback, and `bash` is served by the command-oriented highlighter in
 * syntax-highlight.js rather than by Prism.
 */
const NO_GRAMMAR_NEEDED = new Set(['text', 'bash']);

/**
 * One snippet per language the tables name, short enough to be uncontroversial
 * and real enough that its grammar must produce at least one token.
 * @type {Record<string, string>}
 */
const SAMPLES = {
  javascript: 'const a = 1;',
  typescript: 'let a: number = 1;',
  python: 'def f(): return 1',
  ruby: 'def f; 1; end',
  go: 'func main() {}',
  rust: 'fn main() { let x = 1; }',
  java: 'class A { int x; }',
  c: 'int main(void) { return 0; }',
  cpp: '#include <vector>\nint main() { return 0; }',
  csharp: 'class A { int X; }',
  php: '<?php $x = 1; ?>',
  swift: 'let x = 1',
  kotlin: 'fun main() { val x = 1 }',
  json: '{"a": 1}',
  yaml: 'key: value',
  toml: 'key = "value"',
  xml: '<a href="b">c</a>',
  html: '<b>x</b>',
  css: 'a { color: red; }',
  scss: '$c: red; a { color: $c; }',
  sass: 'a\n  color: red',
  markdown: '# title',
  sql: 'SELECT 1 FROM t;',
  ini: '[section]\nkey = value',
  properties: 'key=value',
  groovy: 'def x = 1',
  makefile: 'all:\n\techo hi',
  cmake: 'add_library(a b.c)',
  docker: 'FROM alpine\nRUN echo hi',
  diff: '+ added',
};

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { LANGUAGE_BY_EXT, LANGUAGE_BY_FILENAME, normalizeLanguageId, languageForPath } =
    await import('../../sdk/lib/languages.js');
  const { highlightCode } = await import('../../sdk/lib/syntax-highlight.js');

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

  /** @type {any} */
  const Prism = (/** @type {any} */ (window)).Prism;

  /** Every language id the tables can produce. */
  const named = [...new Set([...Object.values(LANGUAGE_BY_EXT), ...Object.values(LANGUAGE_BY_FILENAME)])];

  run('Prism is loaded', () => {
    assert(Prism && Prism.languages, 'window.Prism.languages is missing — check the vendor script tags');
  });

  run('every language the tables name has a grammar loaded', () => {
    const missing = named.filter((id) => !NO_GRAMMAR_NEEDED.has(id) && !Prism?.languages?.[id]);
    assert(missing.length === 0, `no grammar loaded for: ${missing.join(', ')}`);
  });

  run('every language the tables name has a sample here', () => {
    const untested = named.filter((id) => !NO_GRAMMAR_NEEDED.has(id) && !(id in SAMPLES));
    assert(untested.length === 0, `add a sample for: ${untested.join(', ')}`);
  });

  run('the languages we advertise actually colour their code', () => {
    /** @type {string[]} */
    const uncoloured = [];
    for (const [language, sample] of Object.entries(SAMPLES)) {
      const holder = document.createElement('code');
      holder.innerHTML = highlightCode(sample, language);
      if (holder.querySelector('.token') === null) uncoloured.push(language);
      assert(holder.textContent === sample, `${language}: highlighting changed the visible text`);
    }
    assert(uncoloured.length === 0, `produced no tokens for: ${uncoloured.join(', ')}`);
  });

  run('a shell script goes through the command-oriented highlighter', () => {
    const holder = document.createElement('code');
    holder.innerHTML = highlightCode('cd foo && make test', 'bash');
    assert(holder.querySelector('.bash-command-head') !== null, 'expected command highlighting');
    assert(holder.textContent === 'cd foo && make test', 'highlighting changed the visible text');
  });

  run('an unknown language degrades to escaped text', () => {
    const holder = document.createElement('code');
    holder.innerHTML = highlightCode('<b>x</b> && y', 'nosuchlang');
    assert(holder.querySelector('b') === null, 'source markup became live');
    assert(holder.textContent === '<b>x</b> && y', 'escaped text should read back unchanged');
  });

  run('language names are normalised', () => {
    assert(normalizeLanguageId('YML') === 'yaml', 'yml should normalise to yaml');
    assert(normalizeLanguageId(' Golang ') === 'go', 'golang should normalise to go');
    assert(normalizeLanguageId('c++') === 'cpp', 'c++ should normalise to cpp');
    assert(normalizeLanguageId('zsh') === 'bash', 'zsh should normalise to bash');
    assert(normalizeLanguageId('sh') === 'bash', 'sh must reach the shell highlighter, not Prism');
    assert(normalizeLanguageId('') === 'text', 'an empty name should fall back to text');
    assert(normalizeLanguageId('javascript') === 'javascript', 'a canonical id should pass through');
  });

  run('paths resolve by name, extension last', () => {
    assert(languageForPath('/a/b/c.ts') === 'typescript', 'ts should resolve to typescript');
    assert(languageForPath('C:\\src\\main.go') === 'go', 'a windows path should resolve');
    assert(languageForPath('/p/Widget.HPP') === 'cpp', 'the extension should be case-insensitive');
    assert(languageForPath('/p/CMakeLists.txt') === 'cmake', 'a name match should beat the extension');
    assert(languageForPath('Makefile') === 'makefile', 'an extensionless build file should resolve');
    assert(languageForPath('/p/.env') === 'ini', 'a dotfile should resolve on what follows the dot');
    assert(languageForPath('/p/README') === 'text', 'an unknown extensionless file should be text');
    assert(languageForPath('') === 'text', 'an empty path should fall back to text');
  });

  return { passed, failed, errors };
}
