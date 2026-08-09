//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for `<file-view>`, the host element every file viewer renders into.
 *
 * The load-bearing assertion is header ownership. The element renders the path
 * itself, but several hosts must render their own (a live pin shows the path
 * before its fetch resolves, and carries the unpin affordance) — so a host that
 * does opts out. Get that wrong and the properties panel shows the file's name
 * twice, which is exactly what it did before `showPath` existed.
 * @module unit-tests/file-view-test
 */

import '../../js/components/file-view.js';
import { fileSourceFromText } from '../../sdk/file-source.js';

/**
 * @param {boolean} cond - Assertion condition
 * @param {string} msg - Failure message
 * @param {string[]} errors - Collected failures
 * @returns {number} 1 when the assertion passed, 0 when it failed
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Mount a `<file-view>` on a text source and wait for its async render (viewer
 * resolution imports the registry) to settle.
 * @param {boolean} showPath - Whether the view should render its own path header
 * @returns {Promise<HTMLElement>} The mounted, rendered element
 */
async function mountView(showPath) {
  const view = /** @type {any} */ (document.createElement('file-view'));
  view.showPath = showPath;
  view.setSource(fileSourceFromText({ path: 'src/notes.txt', text: 'hello\nworld\n' }));
  document.body.appendChild(view);
  for (let i = 0; i < 100; i++) {
    if (view.querySelector('.file-view-content, .file-content-warning, .file-content-not-found')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return view;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} n - 1 when passed */
  const tally = (n) => { if (n) passed++; else failed++; };

  const withPath = await mountView(true);
  try {
    const rows = withPath.querySelectorAll('.properties-panel-filepath');
    tally(check(rows.length === 1,
      `a view that owns its header should render exactly one path row, got ${rows.length}`, errors));
    tally(check(rows[0]?.textContent === 'src/notes.txt',
      `the path row should name the file, got ${JSON.stringify(rows[0]?.textContent)}`, errors));
    tally(check(!!withPath.querySelector('.file-view-content'),
      'a text source should resolve a viewer and mount its content', errors));
  } finally {
    withPath.remove();
  }

  const withoutPath = await mountView(false);
  try {
    tally(check(withoutPath.querySelectorAll('.properties-panel-filepath').length === 0,
      'showPath=false must suppress the header so a host that renders its own does not double it', errors));
    tally(check(!!withoutPath.querySelector('.file-view-content'),
      'suppressing the header must not affect the viewer content', errors));
  } finally {
    withoutPath.remove();
  }

  return { passed, failed, errors };
}
