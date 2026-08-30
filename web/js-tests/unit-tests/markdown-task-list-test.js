//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Markdown task-list test.
 *
 * GFM spells two task states; the renderer draws five. `[ ]` and `[x]` reach
 * the decorator as the `<input>` marked built for them, while `[/]`, `[!]` and
 * `[-]` reach it as the literal text marked declined to claim — two entirely
 * different shapes that must come out identical. These cases pin that, the
 * states themselves, and the two places the markers are written.
 * @module unit-tests/markdown-task-list-test
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

  const { renderMarkdown } = await import('../../sdk/lib/markdown.js');
  const { renderPlanMarkdown, renderTodoMarkdown } = await import(
    '../../extensions/juggler-core/lib/task-lists.js'
  );

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
   * Render markdown and hand back a real element to query.
   * @param {string} md - Markdown source
   * @returns {HTMLElement} Container holding the rendered output
   */
  const render = (md) => {
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown(md);
    return div;
  };

  // --- the five states ------------------------------------------------------

  /** @type {Array<[string, string]>} Marker → expected state class */
  const states = [
    [' ', 'pending'],
    ['/', 'in-progress'],
    ['x', 'completed'],
    ['!', 'failed'],
    ['-', 'skipped'],
  ];

  for (const [marker, state] of states) {
    run(`[${marker}] renders a ${state} box`, () => {
      const el = render(`- [${marker}] step text`);
      const box = el.querySelector('.task-box');
      assert(box, `no .task-box for [${marker}]: ${el.innerHTML}`);
      assert(
        box.classList.contains(`task-box--${state}`),
        `[${marker}] should be ${state}, got "${box.className}"`
      );
      assert(
        box.querySelector('.task-box-mark'),
        `[${marker}] box has no mark element: ${el.innerHTML}`
      );
      // The marker itself must be consumed, not left sitting in the text.
      assert(
        !(el.textContent || '').includes(`[${marker}]`),
        `[${marker}] marker leaked into the text: ${el.textContent}`
      );
      assert(
        (el.textContent || '').includes('step text'),
        `[${marker}] lost its text: ${el.textContent}`
      );
    });
  }

  run('[X] is accepted as completed', () => {
    const box = render('- [X] done').querySelector('.task-box');
    assert(box, 'no box for [X]');
    assert(
      box.classList.contains('task-box--completed'),
      `[X] should be completed, got "${box.className}"`
    );
  });

  run('an unrecognised marker stays literal text', () => {
    const el = render('- [?] not a state');
    assert(!el.querySelector('.task-box'), `[?] should not make a box: ${el.innerHTML}`);
    assert(
      (el.textContent || '').includes('[?]'),
      `[?] should survive as text: ${el.textContent}`
    );
  });

  run('a plain list item is left alone', () => {
    const el = render('- ordinary item');
    assert(!el.querySelector('.task-box'), `plain item gained a box: ${el.innerHTML}`);
    assert(
      !el.querySelector('.task-list-item'),
      `plain item gained a task class: ${el.innerHTML}`
    );
  });

  // --- list shapes ----------------------------------------------------------

  run('ordered lists carry boxes too', () => {
    const el = render('1. [/] first\n2. [x] second');
    const boxes = el.querySelectorAll('.task-box');
    assert(boxes.length === 2, `expected 2 boxes in an ordered list, got ${boxes.length}`);
    assert(el.querySelector('ol'), `expected an <ol>: ${el.innerHTML}`);
    assert(
      boxes[0].classList.contains('task-box--in-progress'),
      `first should be in-progress, got "${boxes[0].className}"`
    );
    assert(
      boxes[1].classList.contains('task-box--completed'),
      `second should be completed, got "${boxes[1].className}"`
    );
  });

  run('a loose list puts the box inside the item paragraph', () => {
    // A blank line between items makes marked wrap each item's content in <p>.
    const el = render('- [!] first\n\n- [ ] second');
    const items = el.querySelectorAll('li.task-list-item');
    assert(items.length === 2, `expected 2 task items, got ${items.length}: ${el.innerHTML}`);
    for (const li of items) {
      const box = li.querySelector('.task-box');
      assert(box, `loose item has no box: ${li.innerHTML}`);
      // Wherever it lives, it must be the first thing in the item.
      assert(
        box.parentElement?.firstElementChild === box,
        `box is not first in its block: ${li.innerHTML}`
      );
    }
  });

  run('the item and its list are classed for styling', () => {
    const el = render('- [-] skipped step');
    const li = el.querySelector('li');
    assert(li?.classList.contains('task-list-item'), `li missing task-list-item: ${el.innerHTML}`);
    assert(
      li?.classList.contains('task-list-item--skipped'),
      `li missing state class: ${li?.className}`
    );
    assert(
      el.querySelector('ul')?.classList.contains('contains-task-list'),
      `list missing contains-task-list: ${el.innerHTML}`
    );
  });

  run('a mixed list keeps each item on its own state', () => {
    const el = render('- [x] a\n- [/] b\n- [!] c\n- [-] d\n- [ ] e');
    const got = Array.from(el.querySelectorAll('.task-box')).map((b) =>
      (b.className.match(/task-box--(\S+)/) || [])[1]
    );
    const want = ['completed', 'in-progress', 'failed', 'skipped', 'pending'];
    assert(
      got.join(',') === want.join(','),
      `states out of order: got ${got.join(',')} want ${want.join(',')}`
    );
  });

  // --- the box itself -------------------------------------------------------

  run('the box carries an accessible name', () => {
    const box = render('- [/] step').querySelector('.task-box');
    assert(box?.getAttribute('role') === 'img', `expected role=img, got "${box?.getAttribute('role')}"`);
    assert(
      box?.getAttribute('aria-label') === 'In progress',
      `expected aria-label "In progress", got "${box?.getAttribute('aria-label')}"`
    );
  });

  run('no bare checkbox input survives', () => {
    const el = render('- [ ] a\n- [x] b');
    assert(
      !el.querySelector('input'),
      `marked's <input> should have been replaced: ${el.innerHTML}`
    );
  });

  run('the decorator does not reopen the sanitiser', () => {
    // Runs after sanitizeRenderedHtml, so it must not resurrect anything.
    const el = render('- [/] <img src=x onerror=alert(1)> step');
    assert(!el.querySelector('img'), `raw <img> survived: ${el.innerHTML}`);
    assert(el.querySelector('.task-box'), `box missing: ${el.innerHTML}`);
  });

  // --- layout ---------------------------------------------------------------

  /**
   * Lay a task list out for real, at a width narrow enough to force wrapping,
   * and compare where the first line's text starts against where the wrapped
   * lines start.
   *
   * The first line's text begins at the box's right edge plus its gap — reading
   * it off the box rather than off a text node keeps the measurement honest for
   * content whose first line is split by inline markup such as `code`.
   * @param {string} md - Markdown source
   * @returns {{first: number, wrapped: number, lines: number, cleanup: () => void}} Offsets in px
   */
  const measureItem = (md) => {
    const host = document.createElement('div');
    host.className = 'markdown ci-text-block';
    host.style.cssText = 'position:absolute;left:0;top:0;width:15rem;';
    host.innerHTML = renderMarkdown(md);
    document.body.appendChild(host);

    const li = /** @type {HTMLElement} */ (host.querySelector('li.task-list-item'));
    // A nested list's own items are indented on purpose; measuring them would
    // read that deliberate indent as drift. Drop them and keep the item's text.
    li.querySelectorAll('ul, ol').forEach((n) => n.remove());
    const box = /** @type {HTMLElement} */ (li.querySelector('.task-box'));
    const gap = parseFloat(getComputedStyle(box).marginRight) || 0;

    const range = document.createRange();
    range.selectNodeContents(li);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5);

    const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;
    return {
      first: round(box.getBoundingClientRect().right + gap),
      wrapped: round(rects[rects.length - 1].left),
      lines: rects.length,
      cleanup: () => host.remove(),
    };
  };

  /**
   * @param {string} label - Case name
   * @param {string} md - Markdown whose first item must wrap
   */
  const expectAligned = (label, md) => {
    run(label, () => {
      const { first, wrapped, lines, cleanup } = measureItem(md);
      cleanup();
      assert(lines >= 2, `content did not wrap (${lines} line), cannot compare`);
      assert(
        Math.abs(first - wrapped) < 0.5,
        `first line's text starts at ${first}px, wrapped lines at ${wrapped}px `
          + `— drift ${round2(first - wrapped)}px`
      );
    });
  };

  /**
   * @param {number} n - Value to round
   * @returns {number} The value to two decimal places
   */
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  expectAligned('wrapped lines align (bullet list)', `- [x] ${'word '.repeat(40)}`);
  expectAligned('wrapped lines align (ordered list)', `1. [/] ${'word '.repeat(40)}`);
  expectAligned(
    'wrapped lines align when the first line contains inline code',
    `1. [x] Add a \`sortBy\` field to the conversation store and persist it `
      + `(write the load/save path) — verified by the existing settings round-trip test.`
  );
  expectAligned(
    'wrapped lines align in a loose list (box inside a paragraph)',
    `- [!] ${'word '.repeat(40)}\n\n- [ ] second item`
  );
  expectAligned(
    'wrapped lines align when the item carries a nested list',
    `- [/] ${'word '.repeat(40)}\n    - nested child`
  );
  expectAligned(
    'wrapped lines align in a real rendered plan',
    renderPlanMarkdown({
      title: 'Sort conversations',
      steps: [
        {
          content: 'Add a `sortBy` field to the conversation store and persist it '
            + '(write the load/save path) — verified by the existing settings round-trip test.',
          status: 'completed',
          result: 'Demo only — nothing actually changed; store step marked done.',
        },
      ],
    })
  );

  // --- plan and todo write the markers --------------------------------------

  run('plan renders a marker for every status', () => {
    const md = renderPlanMarkdown({
      title: 'T',
      steps: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'failed' },
        { content: 'd', status: 'skipped' },
        { content: 'e', status: 'pending' },
      ],
    });
    for (const marker of ['[x] a', '[/] b', '[!] c', '[-] d', '[ ] e']) {
      assert(md.includes(marker), `plan markdown missing "${marker}":\n${md}`);
    }
  });

  run('plan says the status in words only for the model', () => {
    /** @type {{steps: Array<{content: string, status: string}>}} */
    const data = { steps: [{ content: 'a', status: 'in_progress' }] };
    const forPanel = renderPlanMarkdown(data);
    const forModel = renderPlanMarkdown(data, { statusWords: true });
    assert(!forPanel.includes('in progress'), `panel copy should have no words:\n${forPanel}`);
    assert(forPanel.includes('[/]'), `panel copy should still mark the state:\n${forPanel}`);
    assert(forModel.includes('_(in progress)_'), `model copy needs the words:\n${forModel}`);
  });

  run('todo renders a marker for every status', () => {
    const md = renderTodoMarkdown([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
    for (const marker of ['[x] a', '[/] b', '[ ] c']) {
      assert(md.includes(marker), `todo markdown missing "${marker}":\n${md}`);
    }
    assert(!md.includes('in progress'), `panel copy should have no words:\n${md}`);
  });

  run('todo says the status in words only for the model', () => {
    const todos = [{ content: 'a', status: 'in_progress' }];
    const forModel = renderTodoMarkdown(todos, { statusWords: true });
    assert(forModel.includes('_(in progress)_'), `model copy needs the words:\n${forModel}`);
  });

  run('a plan step survives the round trip through the renderer', () => {
    const md = renderPlanMarkdown({
      steps: [
        { content: 'Add a `sortBy` field to the store', status: 'in_progress', result: null },
        { content: 'Wire the menu', status: 'completed', result: 'Landed in sidebar.js' },
      ],
    });
    const el = render(md);
    const items = el.querySelectorAll('li.task-list-item');
    assert(items.length === 2, `expected 2 rendered steps, got ${items.length}:\n${el.innerHTML}`);
    assert(
      items[0].querySelector('.task-box--in-progress'),
      `first step lost its state: ${items[0].innerHTML}`
    );
    // The result line is a continuation of its own step, not a list item of its own.
    assert(
      (items[1].textContent || '').includes('Landed in sidebar.js'),
      `result line escaped its step: ${el.innerHTML}`
    );
  });

  return { passed, failed, errors };
}
