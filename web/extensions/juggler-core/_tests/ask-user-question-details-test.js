//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The AskUserQuestion properties-panel details view must tick EVERY option the
 * user selected. The only persisted record of the answer is the result string
 * ("Header: a, b, c"), so renderToolActionDetails has to reverse that
 * serialization. For a multiSelect question the value is comma-joined; if it is
 * treated as a single label, no option ticks. This anchors that both
 * multi-select (several ticks) and single-select (one tick) reconstruct
 * correctly.
 * @module unit-tests/ask-user-question-details
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import AskUserQuestionContextItem from '../context-items/ask-user-question-context-item.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Count of assertions that passed.
 * @property {number} failed - Count of assertions that failed.
 * @property {string[]} errors - Messages from failed assertions.
 */

/**
 * Render the details view for a question set + result string and return the
 * set of option labels that rendered in the selected (ticked) state.
 * @param {object[]} questions - Question definitions
 * @param {string} resultContent - The persisted result string
 * @returns {Set<string>} Labels rendered as selected
 */
function renderSelectedLabels(questions, resultContent) {
  // renderToolActionDetails reads only from ctx, never from instance state, so
  // the constructor's required context fields can be inert stubs.
  const item = new AskUserQuestionContextItem(/** @type {any} */ ({
    id: 'test', session: {}, conversation: {}, messageThread: {}
  }));
  const wrapper = document.createElement('div');
  /** @type {any} */ (item).renderToolActionDetails(wrapper, {
    toolAction: { get: key => (key === 'result' ? { content: resultContent } : undefined) },
    toolName: 'askuserquestion',
    input: { questions },
    helpers: {},
    conversation: null,
    messageThread: null,
    session: null,
    selectedItemId: 'test'
  });
  const selected = new Set();
  for (const optionItem of wrapper.querySelectorAll('.option-item.selected')) {
    // A selected option must carry a ticked checkbox (not "[x]" text) and the
    // bare option label.
    assert(optionItem.querySelector('.option-tick.checked'),
      'selected option must render a checked tick box');
    const label = optionItem.querySelector('.option-label');
    if (label) selected.add(label.textContent);
  }
  // An unselected option must show an unchecked tick (a tick box, no .checked).
  for (const optionItem of wrapper.querySelectorAll('.option-item:not(.selected)')) {
    const tick = optionItem.querySelector('.option-tick');
    assert(tick && !tick.classList.contains('checked'),
      'unselected option must render an unchecked tick box');
  }
  return selected;
}

/**
 * Render the details view and return the user's typed custom-answer text for a
 * header (the ticked `.custom-answer` row), or null if none rendered.
 * @param {object[]} questions - Question definitions
 * @param {string} resultContent - The persisted result string
 * @param {string} header - The question header whose custom answer to read
 * @returns {string|null} The custom-answer text, or null if none rendered
 */
function renderCustomAnswer(questions, resultContent, header) {
  const item = new AskUserQuestionContextItem(/** @type {any} */ ({
    id: 'test', session: {}, conversation: {}, messageThread: {}
  }));
  const wrapper = document.createElement('div');
  /** @type {any} */ (item).renderToolActionDetails(wrapper, {
    toolAction: { get: key => (key === 'result' ? { content: resultContent } : undefined) },
    toolName: 'askuserquestion',
    input: { questions },
    helpers: {},
    conversation: null,
    messageThread: null,
    session: null,
    selectedItemId: 'test'
  });
  const blocks = wrapper.querySelectorAll('.question-block');
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].header === header) {
      const row = blocks[i]?.querySelector('.option-item.custom-answer');
      if (!row) return null;
      // A custom-answer row must be ticked and carry the typed text.
      assert(row.querySelector('.option-tick.checked'), 'custom answer must render a checked tick');
      return row.querySelector('.option-label')?.textContent ?? null;
    }
  }
  return null;
}

/**
 * A stand-in for MessageThread that just captures the resolveApproval response.
 * The form's in-progress draft lives in the plugin's module-scoped store keyed
 * by toolUseId (not on the thread), so rebuild-survival is exercised purely by
 * rebuilding with the same toolUseId.
 * @returns {{resolveApproval: Function, lastResolve: any}} A thread stub capturing the last resolveApproval response.
 */
function makeThread() {
  const store = { lastResolve: /** @type {any} */ (null) };
  return {
    resolveApproval: (_id, response) => { store.lastResolve = response; },
    get lastResolve() { return store.lastResolve; }
  };
}

/**
 * Build a pending multi-question form for the given questions + toolUseId,
 * returning the form element. A fresh plugin instance is used each call to
 * mimic `tool-action-message` rebuilding the form on every re-render; reusing
 * the same toolUseId across calls models the draft surviving a rebuild.
 * @param {object[]} questions - Question definitions
 * @param {string} toolUseId - Stable tool-use id keying the draft
 * @param {object} [thread] - messageThread stub (defaults to a fresh one)
 * @returns {HTMLElement} The built form element
 */
function buildForm(questions, toolUseId, thread = makeThread()) {
  const item = new AskUserQuestionContextItem(/** @type {any} */ ({
    id: 'test', session: {}, conversation: {}, messageThread: {}
  }));
  return /** @type {any} */ (item)._buildMultiQuestionForm(questions, {
    conversation: null,
    messageThread: thread,
    toolUseId
  });
}

/**
 * @param {HTMLElement} form
 * @returns {string[]} Sorted labels of the selected buttons in a form
 */
function selectedLabels(form) {
  return Array.from(form.querySelectorAll('.question-option-btn.selected'))
    .map(b => b.querySelector('.option-btn-label')?.textContent)
    .sort();
}

/**
 * Run all AskUserQuestion details-rendering tests.
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors = [];

  const check = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  };

  const multiQuestions = [{
    question: 'Which surfaces?',
    header: 'Surfaces',
    multiSelect: true,
    options: [
      { label: 'Messages', description: 'msg bubbles' },
      { label: 'Code & diffs', description: 'code blocks' },
      { label: 'File refs', description: 'pinned files' },
      { label: 'Conversation tabs', description: 'tabs' }
    ]
  }];

  check('multi-select ticks every chosen option', () => {
    const selected = renderSelectedLabels(multiQuestions, 'Surfaces: Messages, File refs, Code & diffs');
    assert(selected.has('Messages'), 'expected "Messages" ticked');
    assert(selected.has('File refs'), 'expected "File refs" ticked');
    assert(selected.has('Code & diffs'), 'expected "Code & diffs" ticked');
    assert(!selected.has('Conversation tabs'), 'expected "Conversation tabs" NOT ticked');
    assert(selected.size === 3, `expected exactly 3 ticks, got ${selected.size}`);
  });

  check('multi-select with a single chosen option ticks just that one', () => {
    const selected = renderSelectedLabels(multiQuestions, 'Surfaces: File refs');
    assert(selected.size === 1 && selected.has('File refs'),
      `expected only "File refs" ticked, got ${[...selected].join(', ')}`);
  });

  check('single-select ticks exactly the chosen option', () => {
    const singleQuestions = [{
      question: 'Pick one',
      header: 'Choice',
      multiSelect: false,
      options: [
        { label: 'Alpha', description: 'a' },
        { label: 'Beta', description: 'b' }
      ]
    }];
    const selected = renderSelectedLabels(singleQuestions, 'Choice: Beta');
    assert(selected.size === 1 && selected.has('Beta'),
      `expected only "Beta" ticked, got ${[...selected].join(', ')}`);
  });

  // --- Draft survives the form rebuild that any re-render performs ---------
  // A pending form's in-progress picks live in the plugin's module-scoped
  // draft store (keyed by toolUseId), so when an unrelated re-render rebuilds
  // the form from scratch the picks come back.

  const click = (form, label) => Array.from(form.querySelectorAll('.question-option-btn'))
    .find(b => b.querySelector('.option-btn-label')?.textContent === label).click();

  check('multi-select picks survive a form rebuild', () => {
    const toolUseId = 'tu_multi_rebuild';
    const thread = makeThread();
    const form1 = buildForm(multiQuestions, toolUseId, thread);
    // User picks two options on the first-rendered form.
    click(form1, 'Messages');
    click(form1, 'File refs');
    assert(selectedLabels(form1).join(',') === 'File refs,Messages',
      `pre-rebuild expected both ticked, got ${selectedLabels(form1).join(',')}`);

    // Re-render: a brand-new form is built for the same tool-use id, sourcing
    // the draft from the module-scoped store.
    const form2 = buildForm(multiQuestions, toolUseId, thread);
    assert(selectedLabels(form2).join(',') === 'File refs,Messages',
      `post-rebuild expected both still ticked, got ${selectedLabels(form2).join(',')}`);
    // Submit must be enabled on the rebuilt form (every question answered).
    assert(!form2.querySelector('.multi-question-submit').disabled,
      'post-rebuild Submit should be enabled from the restored draft');

    // Toggling on the rebuilt form mutates the same persisted draft.
    click(form2, 'Messages');
    const form3 = buildForm(multiQuestions, toolUseId, thread);
    assert(selectedLabels(form3).join(',') === 'File refs',
      `after toggle+rebuild expected only File refs, got ${selectedLabels(form3).join(',')}`);
  });

  check('submitting resolves with every committed pick', () => {
    const toolUseId = 'tu_submit';
    const thread = makeThread();
    const form = buildForm(multiQuestions, toolUseId, thread);
    click(form, 'Messages');
    click(form, 'Code & diffs');
    form.querySelector('.multi-question-submit').click();
    const answers = JSON.parse(thread.lastResolve);
    assert(Array.isArray(answers.Surfaces) && answers.Surfaces.slice().sort().join(',') === 'Code & diffs,Messages',
      `expected both picks submitted, got ${thread.lastResolve}`);
  });

  // --- Custom free-text answer (an option you type, not an extra field) ----

  const singleQuestions = [{
    question: 'Pick one',
    header: 'Choice',
    multiSelect: false,
    options: [
      { label: 'Alpha', description: 'a' },
      { label: 'Beta', description: 'b' }
    ]
  }];

  const typeCustom = (form, text) => {
    const field = form.querySelector('.question-custom-field');
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };

  check('a custom field is rendered as an option for every question', () => {
    const form = buildForm(singleQuestions, 'tu_custom_present', makeThread());
    assert(form.querySelector('.question-options .question-custom-option .question-custom-field'),
      'custom answer must render as an option row inside the options list');
  });

  check('typing a custom answer submits the typed text as the answer', () => {
    const toolUseId = 'tu_custom_single';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form, 'something else entirely');
    // The custom option selects itself; Submit becomes enabled with no preset picked.
    assert(form.querySelector('.question-custom-option').classList.contains('selected'),
      'custom option should be selected once typed into');
    assert(!form.querySelector('.multi-question-submit').disabled,
      'a typed custom answer should satisfy the question');
    form.querySelector('.multi-question-submit').click();
    const answers = JSON.parse(thread.lastResolve);
    assert(answers.Choice === 'something else entirely',
      `expected typed text as the answer, got ${thread.lastResolve}`);
  });

  check('typing a custom answer deselects any picked preset (single-select)', () => {
    const toolUseId = 'tu_custom_replaces';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    click(form, 'Alpha');
    typeCustom(form, 'my own');
    assert(selectedLabels(form).length === 0,
      `expected no preset selected after typing, got ${selectedLabels(form).join(',')}`);
    form.querySelector('.multi-question-submit').click();
    assert(JSON.parse(thread.lastResolve).Choice === 'my own',
      `expected custom answer to win, got ${thread.lastResolve}`);
  });

  check('picking a preset clears a previously typed custom answer (single-select)', () => {
    const toolUseId = 'tu_custom_cleared';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form, 'draft text');
    click(form, 'Beta');
    assert(form.querySelector('.question-custom-field').value === '',
      'custom field should clear when a preset is chosen');
    assert(!form.querySelector('.question-custom-option').classList.contains('selected'),
      'custom option should deselect when a preset is chosen');
    form.querySelector('.multi-question-submit').click();
    assert(JSON.parse(thread.lastResolve).Choice === 'Beta',
      `expected the preset to win, got ${thread.lastResolve}`);
  });

  const pressEnter = (field, opts = {}) => field.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts }));

  check('Enter in the custom field submits when every question is answered', () => {
    const toolUseId = 'tu_custom_enter';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    const field = form.querySelector('.question-custom-field');
    typeCustom(form, 'typed and entered');
    pressEnter(field);
    assert(thread.lastResolve && JSON.parse(thread.lastResolve).Choice === 'typed and entered',
      `expected Enter to submit the typed answer, got ${thread.lastResolve}`);
  });

  check('Enter does not submit while a question is unanswered', () => {
    const toolUseId = 'tu_custom_enter_blocked';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    const field = form.querySelector('.question-custom-field');
    pressEnter(field); // nothing typed, no preset chosen
    assert(thread.lastResolve === null,
      `expected no submit while unanswered, got ${thread.lastResolve}`);
  });

  check('Shift+Enter in the custom field does not submit', () => {
    const toolUseId = 'tu_custom_shift_enter';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    const field = form.querySelector('.question-custom-field');
    typeCustom(form, 'line one');
    pressEnter(field, { shiftKey: true });
    assert(thread.lastResolve === null,
      `Shift+Enter must insert a newline, not submit; got ${thread.lastResolve}`);
  });

  check('a custom answer survives a form rebuild', () => {
    const toolUseId = 'tu_custom_rebuild';
    const thread = makeThread();
    const form1 = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form1, 'keep me');
    const form2 = buildForm(singleQuestions, toolUseId, thread);
    assert(form2.querySelector('.question-custom-field').value === 'keep me',
      'custom answer should be restored from the draft after a rebuild');
    assert(form2.querySelector('.question-custom-option').classList.contains('selected'),
      'restored custom answer should show as selected');
  });

  check('clearing a custom answer leaves the question unanswered', () => {
    const toolUseId = 'tu_custom_empty';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form, 'x');
    typeCustom(form, '   ');
    assert(form.querySelector('.multi-question-submit').disabled,
      'a blank custom answer must not satisfy the question');
  });

  check('multi-select carries the custom answer alongside a picked label', () => {
    const toolUseId = 'tu_custom_multi';
    const thread = makeThread();
    const form = buildForm(multiQuestions, toolUseId, thread);
    click(form, 'Messages');
    typeCustom(form, 'and a fourth surface');
    form.querySelector('.multi-question-submit').click();
    const answers = JSON.parse(thread.lastResolve);
    assert(Array.isArray(answers.Surfaces)
			&& answers.Surfaces.includes('Messages')
			&& answers.Surfaces.includes('and a fourth surface'),
    `expected both the pick and the custom answer, got ${thread.lastResolve}`);
  });

  check('details renders a single-select custom answer with literal ", "', () => {
    const custom = renderCustomAnswer(singleQuestions, 'Choice: a, b and c', 'Choice');
    assert(custom === 'a, b and c',
      `expected the custom answer preserved verbatim, got ${JSON.stringify(custom)}`);
  });

  check('details renders no custom-answer row when only a preset was chosen', () => {
    const custom = renderCustomAnswer(singleQuestions, 'Choice: Beta', 'Choice');
    assert(custom === null, `expected no custom-answer row, got ${JSON.stringify(custom)}`);
  });

  // ==========================================================================
  // applyApprovalResponse — the elicitation seam that folds the captured answer
  // back into the tool input before execution.
  // ==========================================================================
  const askInput = { questions: [{ header: 'Approach', options: [] }] };

  check('AskUserQuestion is declared an elicitation', () => {
    assert(AskUserQuestionContextItem.interactionKind() === 'elicitation',
      `expected interactionKind 'elicitation', got '${AskUserQuestionContextItem.interactionKind()}'`);
  });

  check('applyApprovalResponse parses a JSON multi-answer object', () => {
    const out = AskUserQuestionContextItem.applyApprovalResponse(
      askInput, JSON.stringify({ Approach: ['A', 'B'] }));
    assert(Array.isArray(out.answers.Approach) && out.answers.Approach.length === 2,
      `expected the parsed answers object, got ${JSON.stringify(out.answers)}`);
    assert(out.questions === askInput.questions, 'original input fields must be preserved');
  });

  check('applyApprovalResponse treats a non-JSON response as a single label', () => {
    const out = AskUserQuestionContextItem.applyApprovalResponse(askInput, 'Beta');
    assert(out.answers.Approach === 'Beta',
      `expected the label keyed under the first header, got ${JSON.stringify(out.answers)}`);
  });

  check('applyApprovalResponse with an empty response is a no-op passthrough', () => {
    const out = AskUserQuestionContextItem.applyApprovalResponse(askInput, '');
    assert(out === askInput, 'an empty response must return the input unchanged');
  });

  return { passed, failed, errors };
}
