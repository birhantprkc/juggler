//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * decodeHtmlEntities tests.
 *
 * Model-authored strings that are displayed as text (a conversation name, a
 * thread goal) sometimes arrive HTML-escaped. `decodeHtmlEntities`
 * (web/sdk/lib/html.js) undoes exactly the entity set `escapeHtml` produces,
 * in one pass so an escaped entity survives as an entity.
 * @module unit-tests/decode-html-entities-test
 */

import { decodeHtmlEntities, escapeHtml } from '../../sdk/lib/html.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** @type {Array<{in: any, want: string, why: string}>} */
const CASES = [
  { in: 'Modal a11y: migrate to &lt;dialog&gt;', want: 'Modal a11y: migrate to <dialog>', why: 'angle brackets' },
  { in: '&quot;quoted&quot; &amp; &#39;apostrophe&#39;', want: '"quoted" & \'apostrophe\'', why: 'quotes and ampersand' },
  { in: '&#x27;hex apostrophe&#x27;', want: "'hex apostrophe'", why: 'hex numeric form' },
  { in: '&LT;shouty&GT;', want: '<shouty>', why: 'entity names are case-insensitive' },
  { in: '&amp;lt;', want: '&lt;', why: 'one pass — an escaped entity stays an entity' },
  { in: 'Fix &nbsp; and &copy;', want: 'Fix &nbsp; and &copy;', why: 'entities escapeHtml never emits are left alone' },
  { in: 'A & B < C', want: 'A & B < C', why: 'bare text is unchanged' },
  { in: '', want: '', why: 'empty string' },
  { in: null, want: '', why: 'null' },
  { in: undefined, want: '', why: 'undefined' }
];

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  for (const c of CASES) {
    const got = decodeHtmlEntities(c.in);
    if (got === c.want) {
      passed++;
    } else {
      failed++;
      errors.push(`decodeHtmlEntities(${JSON.stringify(c.in)}) = ${JSON.stringify(got)}, want ${JSON.stringify(c.want)} (${c.why})`);
    }
  }

  // Round trip: whatever escapeHtml produces, decodeHtmlEntities must undo.
  try {
    for (const raw of ['<dialog> & "showModal()"', "it's <b>bold</b>", 'plain', '&lt;already escaped&gt;']) {
      const round = decodeHtmlEntities(escapeHtml(raw));
      assert(round === raw, `round trip of ${JSON.stringify(raw)} gave ${JSON.stringify(round)}`);
      passed++;
    }
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`decode-html-entities: ${e?.message ?? e}`);
  }

  return { passed, failed, errors };
}
