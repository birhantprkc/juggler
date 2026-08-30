//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * computeDiff tests.
 *
 * The diff viewer renders a hunk's lines in array order, so `computeDiff`
 * (web/js/lib/diff-utils.js) owns the order the user reads. The invariant that
 * matters: walking a hunk and keeping everything that is not a '-' must
 * reproduce the new file verbatim from `newStart`, and everything that is not
 * a '+' must reproduce the old file from `oldStart`. Changes closer together
 * than the context width are where that is easiest to get wrong.
 * @module unit-tests/diff-utils-test
 */

import { computeDiff } from '../../js/lib/diff-utils.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** Old side of an edit that inserts five lines at three nearby points. */
const OLD_TEXT = [
  'class PlayableTests(TestCase):',
  '    def test_playable(self):',
  '        playable = Playable.objects.create(',
  '            slug="demo",',
  '            game=self.game,',
  '            template="instead",',
  '        )',
  '',
  '        self.assertEqual(str(playable), "demo")',
  '        self.assertEqual(playable.template, "instead")',
  '        self.assertIsInstance(',
  '            Playable._meta.get_field("template"), models.SlugField',
  '        )',
  '        self.assertEqual(playable.config, {})',
  '        self.assertIsNotNone(playable.created)'
].join('\n');

/** New side: three insertions separated by one and by three context lines. */
const NEW_TEXT = [
  'class PlayableTests(TestCase):',
  '    def test_playable(self):',
  '        playable = Playable.objects.create(',
  '            slug="demo",',
  '            game=self.game,',
  '            template="instead",',
  '            template_version="1",',
  '        )',
  '',
  '        self.assertEqual(str(playable), "demo")',
  '        self.assertEqual(playable.template, "instead")',
  '        self.assertEqual(playable.template_version, "1")',
  '        self.assertIsInstance(',
  '            Playable._meta.get_field("template"), models.SlugField',
  '        )',
  '        self.assertIsInstance(',
  '            Playable._meta.get_field("template_version"), models.SlugField',
  '        )',
  '        self.assertEqual(playable.config, {})',
  '        self.assertIsNotNone(playable.created)'
].join('\n');

/**
 * Numbered lines, so a case can be described by which of them changed.
 * @param {number} count - How many lines to generate.
 * @returns {string[]} Lines 'l1'..'lN'.
 */
function lines(count) {
  return Array.from({ length: count }, (_, k) => `l${k + 1}`);
}

/**
 * Checks the invariants of one diff: each hunk's rows must reproduce both
 * sides contiguously from the hunk's declared start, its counts must match the
 * rows it holds, and line numbers must ascend down the hunk.
 * @param {string} oldText - Old file content.
 * @param {string} newText - New file content.
 * @param {string} why - Case description, used in failure messages.
 * @returns {void}
 */
function checkHunks(oldText, newText, why) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const hunks = computeDiff(oldText, newText, 1);

  for (const hunk of hunks) {
    for (const [side, source, start, count, dropped] of /** @type {Array<[string, string[], number, number, string]>} */ ([
      ['old', oldLines, hunk.oldStart, hunk.oldCount, 'add'],
      ['new', newLines, hunk.newStart, hunk.newCount, 'remove']
    ])) {
      const rows = hunk.lines.filter(l => l.type !== dropped);
      assert(rows.length === count, `${why}: hunk ${side}Count ${count} but ${rows.length} ${side} rows`);
      rows.forEach((line, k) => {
        assert(source[start - 1 + k] === line.content,
          `${why}: ${side} row ${k} of hunk at ${start} is ${JSON.stringify(line.content)}, ` +
          `but ${side} line ${start + k} is ${JSON.stringify(source[start - 1 + k])} — rows are out of order`);
      });
    }

    let lastOld = 0;
    let lastNew = 0;
    for (const line of hunk.lines) {
      if (line.oldLineNum !== null) {
        assert(line.oldLineNum > lastOld, `${why}: old line numbers go backwards at ${JSON.stringify(line.content)}`);
        lastOld = line.oldLineNum;
      }
      if (line.newLineNum !== null) {
        assert(line.newLineNum > lastNew, `${why}: new line numbers go backwards at ${JSON.stringify(line.content)}`);
        lastNew = line.newLineNum;
      }
    }
  }
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} why - Case description.
   * @param {() => void} body - Assertions to run.
   * @returns {void}
   */
  const check = (why, body) => {
    try {
      body();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${why}: ${e?.message ?? e}`);
    }
  };

  // The reported case: an added line one context line after a previous change
  // was rendered ahead of the context that precedes it.
  check('nearby insertions keep file order', () => {
    const hunks = computeDiff(OLD_TEXT, NEW_TEXT, 1);
    assert(hunks.length === 1, `expected one hunk, got ${hunks.length}`);
    const rendered = /** @type {import('../../js/lib/diff-types.js').DiffHunk} */ (hunks[0]).lines
      .map(l => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.content.trim()}`);
    const want = [
      ' slug="demo",',
      ' game=self.game,',
      ' template="instead",',
      '+template_version="1",',
      ' )',
      ' ',
      ' self.assertEqual(str(playable), "demo")',
      ' self.assertEqual(playable.template, "instead")',
      '+self.assertEqual(playable.template_version, "1")',
      ' self.assertIsInstance(',
      ' Playable._meta.get_field("template"), models.SlugField',
      ' )',
      '+self.assertIsInstance(',
      '+Playable._meta.get_field("template_version"), models.SlugField',
      '+)',
      ' self.assertEqual(playable.config, {})',
      ' self.assertIsNotNone(playable.created)'
    ];
    assert(rendered.join('\n') === want.join('\n'), `rows read:\n${rendered.join('\n')}\nwant:\n${want.join('\n')}`);
  });

  const l = lines(20).join('\n');
  /** @type {Array<[string, string, string]>} */
  const cases = [
    ['the reported edit', OLD_TEXT, NEW_TEXT],
    ['changes one line apart', l, [...lines(20).slice(0, 5), 'X', 'l6', 'Y', ...lines(20).slice(6)].join('\n')],
    ['adjacent changes', l, [...lines(20).slice(0, 5), 'X', 'Y', ...lines(20).slice(5)].join('\n')],
    ['changes far apart', l, [...lines(20).slice(0, 3), 'X', ...lines(20).slice(3, 18), 'Y', ...lines(20).slice(18)].join('\n')],
    ['removal beside an addition', l, [...lines(20).slice(0, 5), 'X', ...lines(20).slice(7)].join('\n')],
    ['change at the first line', l, ['X', ...lines(20).slice(1)].join('\n')],
    ['change at the last line', l, [...lines(20).slice(0, 19), 'X'].join('\n')],
    ['insert at the very start', l, ['X', ...lines(20)].join('\n')],
    ['insert at the very end', l, [...lines(20), 'X'].join('\n')],
    ['every other line changed', l, lines(20).map((s, k) => (k % 2 ? 'X' + s : s)).join('\n')],
    ['no changes', l, l],
    ['from empty', '', lines(3).join('\n')],
    ['to empty', lines(3).join('\n'), '']
  ];

  for (const [why, oldText, newText] of cases) {
    check(why, () => checkHunks(oldText, newText, why));
    check(`${why} (reversed)`, () => checkHunks(newText, oldText, `${why} (reversed)`));
  }

  return { passed, failed, errors };
}
