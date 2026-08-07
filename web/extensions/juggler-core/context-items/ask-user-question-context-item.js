//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';

/**
 * Uncommitted multi-question selections for pending forms, keyed by toolUseId.
 * The approval form is rebuilt from scratch whenever `tool-action-message`
 * re-renders (the engine's post-PENDING approvalOptions/displayData writes each
 * trigger one), which would otherwise discard the user's in-progress picks.
 * This is transient, client-local, pre-commit input — never persisted to Yjs;
 * the committed answer flows to the doc via resolveApproval on Submit. Module
 * scope (one per iframe realm) so all rebuilds of the same form share it.
 * @type {Map<string, Record<string, string|string[]>>}
 */
const DRAFT_SELECTIONS = new Map();

/**
 * @typedef {object} QuestionOption
 * @property {string} label - The display text for this option
 * @property {string} description - Explanation of what this option means
 */

/**
 * @typedef {object} Question
 * @property {string} question - The complete question to ask the user
 * @property {string} header - Short label displayed as a chip/tag (max 128 chars)
 * @property {QuestionOption[]} options - The available choices (2-4 options)
 * @property {boolean} multiSelect - Whether to allow multiple selections
 */

/**
 * @typedef {object} AskUserQuestionParams
 * @property {Question[]} questions - Array of questions to ask (1-4 questions)
 */

/**
 * @typedef {object} AskUserQuestionResult
 * @property {Record<string, string|string[]>} answers - User's answers keyed by question header
 */

/**
 * AskUserQuestionContextItem - Ask the user questions during execution
 *
 * Allows the LLM to gather user preferences, clarify instructions,
 * or get decisions on implementation choices.
 * @class
 * @augments ContextItem
 */
class AskUserQuestionContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'ask', icon: 'icon-question' };
  }

  /**
   * The result of this tool IS the user's answer, so re-running must re-ask
   * the question (reset to pending) rather than replay the stored response.
   * @override
   * @returns {boolean} Always true
   */
  static rerunRequiresReprompt() {
    return true;
  }

  static MAX_HEADER_LENGTH = 128;

  static MANIFEST = {
    id: 'ask-user-question',
    name: 'Ask User Question',
    version: '1.0.0',
    description: 'Ask the user questions with structured options',
    author: 'Juggler Team',
    requiresApproval: true,
    // This tool's approval surface is a data-entry form, not a go/no-go gate:
    // the user's submission IS the tool's answer. Declaring it an elicitation
    // makes that non-delegable everywhere — approval automation never resolves
    // it, and its resolution payload is folded back via applyApprovalResponse.
    interaction: /** @type {const} */ ('elicitation')
  };

  /**
   * Get tool definitions for AskUserQuestion action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'AskUserQuestion',
        category: 'read',
        description: 'Ask the user questions to gather preferences, clarify instructions, or get decisions on implementation choices.',
        input_schema: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              description: 'Questions to ask the user (1-4 questions)',
              minItems: 1,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string',
                    description: 'The complete question to ask the user'
                  },
                  header: {
                    type: 'string',
                    description: 'Short label displayed as a chip/tag'
                  },
                  options: {
                    type: 'array',
                    description: 'The available choices (2-4 options)',
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: 'object',
                      properties: {
                        label: {
                          type: 'string',
                          description: 'The display text for this option'
                        },
                        description: {
                          type: 'string',
                          description: 'Explanation of what this option means'
                        }
                      },
                      required: ['label', 'description']
                    }
                  },
                  multiSelect: {
                    type: 'boolean',
                    description: 'Whether to allow multiple selections'
                  }
                },
                required: ['question', 'header', 'options', 'multiSelect']
              }
            }
          },
          required: ['questions']
        }
      }
    ];
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {AskUserQuestionParams} */ (toolInput);

    if (!params.questions || !Array.isArray(params.questions)) {
      return { valid: false, error: 'Missing required parameter: questions' };
    }

    if (params.questions.length === 0) {
      return { valid: false, error: 'At least one question is required' };
    }

    if (params.questions.length > 4) {
      return { valid: false, error: 'Maximum 4 questions allowed' };
    }

    // Validate each question
    for (const [i, q] of params.questions.entries()) {
      if (!q.question || typeof q.question !== 'string') {
        return { valid: false, error: `Question ${i + 1}: missing question text` };
      }
      if (!q.header || typeof q.header !== 'string') {
        return { valid: false, error: `Question ${i + 1}: missing header` };
      }
      if (q.header.length > AskUserQuestionContextItem.MAX_HEADER_LENGTH) {
        return { valid: false, error: `Question ${i + 1}: header must be max ${AskUserQuestionContextItem.MAX_HEADER_LENGTH} characters` };
      }
      if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
        return { valid: false, error: `Question ${i + 1}: at least 2 options required` };
      }
      if (q.options.length > 4) {
        return { valid: false, error: `Question ${i + 1}: maximum 4 options allowed` };
      }
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Build approval UI configuration for user questions.
   * Converts question options into approval buttons - clicking a button
   * submits that option as the answer.
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    const questionParams = /** @type {AskUserQuestionParams} */ (params);
    const questions = questionParams.questions;

    // Always use custom form — single path for 1 or N questions
    const title = questions.length === 1 ? /** @type {Question} */ (questions[0]).header : `${questions.length} questions`;
    return {
      title,
      message: '',
      options: [{ label: 'Cancel', value: 'cancel', style: 'secondary' }],
      display: { questions }
    };
  }

  /**
   * Fold the user's captured answer (the approval response) into the tool input
   * before execution. This is the elicitation half of {@link INTERACTION_KIND}:
   * the response string carries the answer, not a verdict.
   *
   * The form submits a JSON-encoded answers object; a bare single-question
   * resolution (a lone selected label) is the fallback, keyed under the first
   * question's header.
   * @override
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @param {string} response - The resolveApproval response string
   * @returns {Record<string, unknown>} Tool input with `answers` populated
   */
  static applyApprovalResponse(toolInput, response) {
    if (!response) return toolInput;
    let answers;
    try {
      // Multi-question: response is a JSON-encoded answers object.
      answers = JSON.parse(response);
    } catch {
      // Single-question: response is the selected label.
      const questions = /** @type {Array<{header?: string}>|undefined} */ (toolInput.questions);
      const header = questions?.[0]?.header || 'Answer';
      answers = { [header]: response };
    }
    return { ...toolInput, answers };
  }

  /**
   * Execute is called after user provides answers
   * The answers are passed through the approval flow
   * @param {Record<string, unknown>} params - Prepared params with user answers
   * @returns {Promise<AskUserQuestionResult>} User's answers
   */
  async execute(params) {
    // The answers should be populated by the UI approval flow
    const answers = /** @type {Record<string, string|string[]>} */ (params.answers || {});

    return { answers };
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return {
        summary: outcome.error || 'Failed to get user response',
        details: '',
        success: false,
        icon: '✗'
      };
    }

    const result = /** @type {AskUserQuestionResult} */ (outcome.result);
    const answers = result.answers || {};

    // Format answers for LLM
    const lines = [];
    for (const [header, answer] of Object.entries(answers)) {
      if (Array.isArray(answer)) {
        lines.push(`${header}: ${answer.join(', ')}`);
      } else {
        lines.push(`${header}: ${answer}`);
      }
    }

    return {
      summary: lines.join('\n') || 'No answers provided',
      details: '',
      success: true,
      icon: '✓'
    };
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @param {{conversation?: import('../../../js/model/conversation.js').default, messageThread?: import('../../../js/model/message-thread.js').MessageThread, toolUseId?: string}} [context] - UI context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput, context) {
    if (!actionStatus) {
      return null;
    }

    const params = /** @type {AskUserQuestionParams} */ (toolInput);
    const displayData = /** @type {{questions?: Question[]}|undefined} */ (actionStatus.displayData);
    // `toolInput.questions` is the immutable source of truth; displayData is a
    // derived cache that a re-run clears. Guard against the empty-array trap:
    // `[] || params.questions` returns `[]` (truthy), which would render "0
    // questions" with no option buttons. Only prefer displayData when it
    // actually carries questions; otherwise fall back to the toolInput.
    const questions = (displayData?.questions?.length ? displayData.questions : params.questions) || [];

    /** @type {string|HTMLElement} */
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    /** @type {HTMLElement|undefined} */
    let customFormElement;

    if (actionStatus.pending) {
      // Title is the short `header` chip, not the full question — the question
      // text is rendered in full inside the form below, so repeating it here
      // would duplicate it.
      summary = questions.length === 1
        ? (questions[0]?.header || 'Waiting for user response...')
        : `Answering ${questions.length} questions...`;
      if (context) {
        customFormElement = this._buildMultiQuestionForm(questions, context);
      }
      status = 'running';
    } else if (actionStatus.success) {
      const result = /** @type {AskUserQuestionResult} */ (actionStatus.result);
      const answers = result.answers || {};

      const answerEntries = Object.entries(answers);
      if (answerEntries.length === 1) {
        const [header, answer] = /** @type {[string, string | string[]]} */ (answerEntries[0]); // bounded: length===1
        const answerText = Array.isArray(answer) ? answer.join(', ') : answer;
        summary = `${header}: ${answerText}`;
      } else if (answerEntries.length > 1) {
        summary = `Answered ${answerEntries.length} questions`;
      } else {
        summary = 'No answer provided';
      }
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus));
    }

    return { typeName: "Question", summary, status, customFormElement };
  }

  /**
   * Build a self-contained multi-question form that handles its own submission.
   * Each question shows a header chip, question text, and option buttons.
   * The Submit button is enabled once every question is answered, but the
   * answers are only submitted when the user explicitly clicks Submit — this
   * lets the user revise earlier choices after answering the last question.
   * @param {Question[]} questions - The questions to render
   * @param {{conversation?: import('../../../js/model/conversation.js').default, messageThread?: import('../../../js/model/message-thread.js').MessageThread, toolUseId?: string}} context - UI context
   * @returns {HTMLElement} Form element
   * @private
   */
  _buildMultiQuestionForm(questions, context) {
    const form = document.createElement('div');
    form.className = 'multi-question-form';

    // Selections survive the full form rebuild that a re-render performs by
    // living in the module-scoped DRAFT_SELECTIONS map (keyed by toolUseId),
    // not in form-local state. Reuse the SAME object reference so click
    // handlers mutate the persisted draft; each rebuild re-seeds from it.
    const messageThread = context.messageThread;
    const toolUseId = context.toolUseId;
    /** @type {Record<string, string|string[]>} */
    const selections = (toolUseId && DRAFT_SELECTIONS.get(toolUseId)) || {};
    if (toolUseId) DRAFT_SELECTIONS.set(toolUseId, selections);

    const submit = () => {
      if (messageThread && toolUseId) {
        DRAFT_SELECTIONS.delete(toolUseId);
        messageThread.resolveApproval(toolUseId, JSON.stringify(selections));
      }
    };

    /**
     * @param {Question} q - The question to check
     * @returns {boolean} Whether the question has at least one selection
     */
    const isAnswered = q => {
      const sel = selections[q.header];
      return Array.isArray(sel) ? sel.length > 0 : Boolean(sel);
    };

    const updateSubmitState = () => {
      const allAnswered = questions.every(isAnswered);
      submitBtn.disabled = !allAnswered;
      if (allAnswered) {
        submitBtn.classList.add('ready');
        submitBtn.classList.add('primary');
        submitBtn.classList.remove('secondary');
      } else {
        submitBtn.classList.remove('ready');
        submitBtn.classList.remove('primary');
        submitBtn.classList.add('secondary');
      }
    };

    for (const q of questions) {
      const group = document.createElement('div');
      group.className = 'question-group';

      const questionText = document.createElement('div');
      questionText.className = 'question-text';
      questionText.textContent = q.question;
      group.appendChild(questionText);

      const btnGroup = document.createElement('div');
      btnGroup.className = 'question-options';

      // The set of model-provided labels lets us tell a picked option apart
      // from the user's own typed answer: any selected value NOT in this set is
      // the custom answer (so the typed text needs no separate storage key).
      const optionLabels = new Set(q.options.map(o => o.label));
      // Assigned when the custom-answer option is built below; the single-select
      // option handlers call it to clear a typed answer when a preset is chosen.
      let clearCustomAnswer = () => {};

      for (const opt of q.options) {
        const btn = document.createElement('button');
        btn.className = 'action-confirmation-button secondary question-option-btn';
        btn.type = 'button';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'option-btn-label';
        labelSpan.textContent = opt.label;
        btn.appendChild(labelSpan);

        if (opt.description) {
          const descSpan = document.createElement('span');
          descSpan.className = 'option-btn-desc';
          descSpan.textContent = opt.description;
          btn.appendChild(descSpan);
        }

        /** @param {boolean} on */
        const setSelected = on => {
          btn.classList.toggle('selected', on);
          btn.classList.toggle('primary', on);
          btn.classList.toggle('secondary', !on);
        };

        // Seed the selected visual from the doc-backed draft so every
        // rebuild (and every column/client) reflects the committed picks.
        const draftSel = selections[q.header];
        const wasSelected = Array.isArray(draftSel)
          ? draftSel.includes(opt.label)
          : draftSel === opt.label;
        if (wasSelected) setSelected(true);

        btn.addEventListener('click', () => {
          if (q.multiSelect) {
            // Toggle this option in/out of the answer array; siblings stay.
            const existing = selections[q.header];
            /** @type {string[]} */
            const current = Array.isArray(existing) ? existing : [];
            const idx = current.indexOf(opt.label);
            if (idx === -1) {
              current.push(opt.label);
              setSelected(true);
            } else {
              current.splice(idx, 1);
              setSelected(false);
            }
            selections[q.header] = current;
          } else {
            // Single-select: choosing one option deselects its siblings.
            btnGroup.querySelectorAll('.question-option-btn').forEach(b => {
              b.classList.remove('selected');
              b.classList.remove('primary');
              b.classList.add('secondary');
            });
            setSelected(true);
            selections[q.header] = opt.label;
            // Picking a preset clears any answer the user had typed.
            clearCustomAnswer();
          }
          updateSubmitState();
        });

        btnGroup.appendChild(btn);
      }

      // Custom free-text answer — a selectable option the user types INSTEAD of
      // picking one of the model's. It carries its own value, so the typed text
      // *is* the answer (stored under q.header like a label, not as an extra
      // field). Rendered as one more row in the options list.
      const customOption = document.createElement('label');
      customOption.className = 'question-custom-option';

      const customLabel = document.createElement('span');
      customLabel.className = 'option-btn-label';
      customLabel.textContent = 'Your own answer';
      customOption.appendChild(customLabel);

      const customField = document.createElement('textarea');
      customField.className = 'question-custom-field';
      customField.rows = 1;
      customField.placeholder = q.multiSelect
        ? 'Type another answer…'
        : 'Type a different answer…';
      customOption.appendChild(customField);

      /** @param {boolean} on */
      const setCustomSelected = on => { customOption.classList.toggle('selected', on); };

      // Grow the borderless textarea to fit its content (it has resize:none).
      const autoGrow = () => {
        customField.style.height = 'auto';
        customField.style.height = `${customField.scrollHeight}px`;
      };

      clearCustomAnswer = () => {
        customField.value = '';
        setCustomSelected(false);
        autoGrow();
      };

      // Seed from the draft: a selected value that isn't a model label is the
      // user's custom answer, so refill the field and show it as selected.
      const draftAnswer = selections[q.header];
      const draftCustom = Array.isArray(draftAnswer)
        ? (draftAnswer.find(v => !optionLabels.has(v)) || '')
        : (typeof draftAnswer === 'string' && draftAnswer && !optionLabels.has(draftAnswer) ? draftAnswer : '');
      if (draftCustom) {
        customField.value = draftCustom;
        setCustomSelected(true);
      }

      customField.addEventListener('input', () => {
        autoGrow();
        const text = customField.value.trim();
        if (q.multiSelect) {
          // The custom answer is the lone non-label entry alongside any picks.
          const existing = selections[q.header];
          const labelsOnly = (Array.isArray(existing) ? existing : []).filter(v => optionLabels.has(v));
          selections[q.header] = text ? [...labelsOnly, text] : labelsOnly;
        } else if (text) {
          // Typing a custom answer replaces any picked preset (radio semantics).
          btnGroup.querySelectorAll('.question-option-btn').forEach(b => {
            b.classList.remove('selected');
            b.classList.remove('primary');
            b.classList.add('secondary');
          });
          selections[q.header] = text;
        } else {
          delete selections[q.header];
        }
        setCustomSelected(Boolean(text));
        updateSubmitState();
      });

      // Enter submits (when every question is answered); Shift+Enter inserts a
      // newline — mirroring the main user-message composer.
      customField.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (!submitBtn.disabled) submit();
        }
      });

      btnGroup.appendChild(customOption);
      group.appendChild(btnGroup);
      form.appendChild(group);
    }

    // Submit / Cancel row
    const actions = document.createElement('div');
    actions.className = 'multi-question-actions';

    const submitBtn = document.createElement('button');
    submitBtn.className = 'action-confirmation-button secondary multi-question-submit';
    submitBtn.type = 'button';
    submitBtn.textContent = 'Submit';
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => submit());

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-confirmation-button secondary';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      if (messageThread && toolUseId) {
        DRAFT_SELECTIONS.delete(toolUseId);
        messageThread.resolveApproval(toolUseId, 'cancel');
      }
    });

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    // Reflect any restored draft in the Submit button's enabled state.
    updateSubmitState();

    return form;
  }

  /**
   * Build the expandable details element showing questions, options, and answers.
   * @param {Question[]} questions - The questions that were asked
   * @param {Record<string, string|string[]>} answers - User's answers keyed by header
   * @returns {HTMLElement} Details element
   * @private
   */
  _buildDetailsElement(questions, answers) {
    const container = document.createElement('div');
    container.className = 'ask-user-question-details';

    for (const q of questions) {
      const questionBlock = document.createElement('div');
      questionBlock.className = 'question-block';

      // Question text
      const questionText = document.createElement('div');
      questionText.className = 'question-text';
      questionText.textContent = q.question;
      questionBlock.appendChild(questionText);

      // Options list
      const optionsList = document.createElement('ul');
      optionsList.className = 'options-list';

      const selectedAnswer = answers[q.header];
      const selectedLabels = Array.isArray(selectedAnswer)
        ? selectedAnswer
        : (selectedAnswer === null || selectedAnswer === undefined ? [] : [selectedAnswer]);

      for (const opt of q.options) {
        const optionItem = document.createElement('li');
        optionItem.className = 'option-item';

        const isSelected = selectedLabels.includes(opt.label);
        if (isSelected) {
          optionItem.classList.add('selected');
        }

        // Tick box rendered as a real checkbox with a check glyph, not as
        // monospace "[x]"/"[ ]" text.
        const tick = document.createElement('span');
        tick.className = isSelected ? 'option-tick checked' : 'option-tick';
        const tickIcon = document.createElement('span');
        tickIcon.className = 'icon-check';
        tick.appendChild(tickIcon);
        optionItem.appendChild(tick);

        const optionText = document.createElement('span');
        optionText.className = 'option-text';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'option-label';
        labelSpan.textContent = opt.label;
        optionText.appendChild(labelSpan);

        // Option description
        if (opt.description) {
          const descSpan = document.createElement('span');
          descSpan.className = 'option-description';
          descSpan.textContent = opt.description;
          optionText.appendChild(descSpan);
        }

        optionItem.appendChild(optionText);
        optionsList.appendChild(optionItem);
      }

      // The user's own typed answer is any selected value that isn't one of the
      // model's labels. Render it as one more ticked option carrying the text.
      const optionLabels = new Set(q.options.map(o => o.label));
      for (const custom of selectedLabels.filter(l => l && !optionLabels.has(l))) {
        const optionItem = document.createElement('li');
        optionItem.className = 'option-item selected custom-answer';

        const tick = document.createElement('span');
        tick.className = 'option-tick checked';
        const tickIcon = document.createElement('span');
        tickIcon.className = 'icon-check';
        tick.appendChild(tickIcon);
        optionItem.appendChild(tick);

        const optionText = document.createElement('span');
        optionText.className = 'option-text';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'option-label';
        labelSpan.textContent = custom;
        optionText.appendChild(labelSpan);
        const descSpan = document.createElement('span');
        descSpan.className = 'option-description';
        descSpan.textContent = 'Your own answer';
        optionText.appendChild(descSpan);
        optionItem.appendChild(optionText);
        optionsList.appendChild(optionItem);
      }

      questionBlock.appendChild(optionsList);
      container.appendChild(questionBlock);
    }

    return container;
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input } = ctx;
    const questions = input.questions || [];
    if (questions.length === 0) return { skipResultSection: true };

    // Reuse _buildDetailsElement on a fresh instance with answers.
    // getSummary serialises each answer as "Header: a, b, c" (multi-select
    // labels joined by ", "). Only multi-select answers are comma-joined lists
    // worth splitting back; a single-select answer (including a typed custom
    // one that may itself contain ", ") stays a single string.
    const multiByHeader = new Map(questions.map((/** @type {Question} */ q) => [q.header, Boolean(q.multiSelect)]));
    const result = toolAction.get('result');
    const resultContent = (result?.get ? result.get('content') : result?.content) || '';
    /** @type {Record<string, string|string[]>} */
    const answers = {};
    for (const line of resultContent.split('\n')) {
      const colonIdx = line.indexOf(': ');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 2);
        answers[key] = (multiByHeader.get(key) && value.includes(', ')) ? value.split(', ') : value;
      }
    }
    const detailsEl = this._buildDetailsElement(questions, answers);
    const section = document.createElement('properties-panel-subsection');
    const labelEl = document.createElement('h4');
    labelEl.className = 'properties-panel-subtitle';
    labelEl.textContent = 'Questions';
    section.appendChild(labelEl);
    section.appendChild(detailsEl);
    wrapper.appendChild(section);
    return { skipResultSection: true };
  }
}

export default AskUserQuestionContextItem;
