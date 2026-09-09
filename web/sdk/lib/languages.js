//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Language identification: which highlighting grammar a file, a fence info
 * string or a server-supplied language name resolves to.
 *
 * The tables here are the client-side answer to "what is this file". A dropped
 * file never reaches the server, so it arrives with no detected language and the
 * browser must work it out alone; everything holding only a path — the text file
 * viewer, the diff viewer — asks {@link languageForPath}.
 *
 * Pure string lookups: no DOM, no Prism, safe anywhere. Nothing here checks
 * whether a grammar is actually loaded — {@link highlightCode} degrades to
 * escaped text when one is missing, and `unit:language-coverage` fails the suite
 * when a language named here has no grammar in `web/index.html` and
 * `web/js-tests/headless-test.html`.
 *
 * The server has its own copy of this table (`detectLanguage`, in
 * `cmd/juggler/ops/file_ops.go`) because a file read through a tool carries its
 * language with it. `TestDetectLanguageMatchesClient` reads this file and fails
 * when the two disagree, so add an extension to both.
 * @module sdk/lib/languages
 */

/**
 * File extension (lower case, no dot) → language id.
 * @type {Record<string, string>}
 */
export const LANGUAGE_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  hpp: 'cpp', hxx: 'cpp', 'h++': 'cpp', ipp: 'cpp', inl: 'cpp',
  cu: 'cpp', cuh: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass',
  md: 'markdown', sql: 'sql', txt: 'text',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', editorconfig: 'ini',
  properties: 'properties', gradle: 'groovy',
  mk: 'makefile', cmake: 'cmake', dockerfile: 'docker',
  diff: 'diff', patch: 'diff',
};

/**
 * Whole file name (lower case) → language id, for the build files that carry
 * their type in the name rather than an extension.
 * @type {Record<string, string>}
 */
export const LANGUAGE_BY_FILENAME = {
  dockerfile: 'docker', containerfile: 'docker',
  makefile: 'makefile', gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
};

/**
 * Every other name a fence info string or a caller may use, mapped to the id we
 * call that language. Prism knows a good few of these itself (`js`, `yml`,
 * `cs`), but resolving them here rather than leaning on its alias table keeps
 * one answer to "what language is this" — including off the main thread, where
 * Prism is not loaded at all, and for `sh`, which must reach the shell
 * highlighter rather than Prism's bash grammar.
 * @type {Record<string, string>}
 */
const LANGUAGE_ALIASES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  golang: 'go',
  rs: 'rust',
  'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  h: 'c',
  'c#': 'csharp', cs: 'csharp',
  kt: 'kotlin', kts: 'kotlin',
  sh: 'bash', shell: 'bash', zsh: 'bash', ksh: 'bash', fish: 'bash',
  console: 'bash', shellsession: 'bash',
  yml: 'yaml',
  htm: 'html',
  md: 'markdown', mdx: 'markdown',
  gradle: 'groovy',
  cfg: 'ini', conf: 'ini', env: 'ini', dotenv: 'ini',
  make: 'makefile', gnumakefile: 'makefile',
  dockerfile: 'docker', containerfile: 'docker',
  patch: 'diff',
  plaintext: 'text', plain: 'text', txt: 'text',
};

/**
 * Resolve a language name to the id the highlighter looks up.
 * @param {string} id - Language id, fence info string or file-type alias
 * @returns {string} Canonical language id, or 'text' when there is nothing to go on
 */
export function normalizeLanguageId(id) {
  const key = String(id ?? '').trim().toLowerCase();
  if (!key) return 'text';
  return LANGUAGE_ALIASES[key] || key;
}

/**
 * Language id for a file path, from its name alone.
 *
 * A whole-name match wins over an extension: `CMakeLists.txt` is CMake, not the
 * plain text its `.txt` says. A name with no dot in it can only match the name
 * table, so `Makefile` resolves while `README` stays text.
 * @param {string} path - File path, with either separator
 * @returns {string} Language id, or 'text' when the name says nothing
 */
export function languageForPath(path) {
  const name = String(path ?? '').split(/[\\/]/).pop()?.toLowerCase() || '';
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 'text';
  return LANGUAGE_BY_EXT[name.slice(dot + 1)] || 'text';
}
