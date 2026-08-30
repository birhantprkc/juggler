//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Rendering a plan or a todo list as markdown, for the surfaces that show the
 * assistant's own checklist.
 *
 * Four of those exist: the plan and todo context items, which render into the
 * LLM's context block and into each tool-action row, and the Plan and Todo pins
 * on the pinboard. Since neither context item draws a standing transcript card,
 * the pins are the only place persistent plan and todo state is visible at all —
 * so it matters that all four agree, and they do by sharing the rendering here.
 *
 * One rendering serves both audiences: the viewer shows it through the standard
 * markdown block, and the model reads the same text in its context block and in
 * each step action's tool_result echo, so the list the user reads and the list
 * the model reads cannot drift apart. The options add to the model's copy only,
 * where it needs what the viewer conveys by other means — a step's executing
 * thread, which the transcript shows, and its status in words, which the viewer
 * draws as a distinct box.
 * @module lib/task-lists
 */

import { taskMarker, taskStatusWord } from 'juggler/ui';
import { createTextBlock } from 'juggler/item-utils';

/**
 * Indent every line after the first to the width of a numbered list marker, so
 * multi-line step or item text stays inside its own list item when rendered.
 * @param {string} text - Step content, item content, or result summary.
 * @returns {string} The text with continuation lines indented.
 */
function indentContinuation(text) {
  return String(text || '').replace(/\n/g, '\n   ');
}

/**
 * How much of a list is done. The pins show this as a tab badge, where there is
 * room for a count and not for a list.
 * @param {Array<{status?: string}>} items - Plan steps or todo items.
 * @returns {{completed: number, total: number}} Completed against total.
 */
export function taskProgress(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    completed: list.filter((item) => item?.status === 'completed').length,
    total: list.length,
  };
}

/**
 * Render a plan as markdown: a title heading, a status/progress line, and a
 * numbered task list — each step a tick box carrying its status, with any result
 * summary beneath it.
 * @param {{title?: string, status?: string, steps?: Array<Record<string, any>>}} planData - Plan data to render.
 * @param {object} [opts] - Rendering options.
 * @param {boolean} [opts.includeThreadIds] - Append the executing sub-thread's id to a step (LLM text only).
 * @param {boolean} [opts.statusWords] - Append the status in words to a step (LLM text only).
 * @returns {string} Markdown, or '' when the plan has no steps.
 */
export function renderPlanMarkdown(planData, opts = {}) {
  const steps = planData?.steps || [];
  if (steps.length === 0) return '';

  const { completed } = taskProgress(steps);
  const lines = [
    `# Plan${planData.title ? ': ' + planData.title : ''}`,
    `Status: ${planData.status || 'planning'} | Progress: ${completed}/${steps.length} completed`,
    ''
  ];

  for (const [i, step] of steps.entries()) {
    let line = `${i + 1}. ${taskMarker(step.status)} ${indentContinuation(step.content)}`;
    const words = opts.statusWords ? taskStatusWord(step.status) : '';
    if (words) {
      line += ` _(${words})_`;
    }
    if (opts.includeThreadIds && step.threadItemId) {
      line += ` (thread: ${step.threadItemId})`;
    }
    lines.push(line);
    if (step.result) {
      lines.push(`   Result: ${indentContinuation(step.result)}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a todo list as markdown: a progress line and a numbered task list, each
 * item a tick box carrying its status.
 * @param {Array<Record<string, any>>} todos - The list to render.
 * @param {object} [opts] - Rendering options.
 * @param {boolean} [opts.statusWords] - Append the status in words to an item (LLM text only).
 * @returns {string} Markdown, or '' when the list is empty.
 */
export function renderTodoMarkdown(todos, opts = {}) {
  const list = todos || [];
  if (list.length === 0) return '';

  const { completed } = taskProgress(list);
  const lines = [
    '# Todo list',
    `Progress: ${completed}/${list.length} completed`,
    ''
  ];

  for (const [i, todo] of list.entries()) {
    const words = opts.statusWords ? taskStatusWord(todo.status) : '';
    const note = words ? ` _(${words})_` : '';
    lines.push(`${i + 1}. ${taskMarker(todo.status)} ${indentContinuation(todo.content)}${note}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * The plan's markdown in the standard markdown block.
 * @param {{title?: string, status?: string, steps?: Array<Record<string, any>>}} planData - Plan data to render.
 * @returns {HTMLElement} Rendered markdown element.
 */
export function createPlanBlock(planData) {
  return createTextBlock(renderPlanMarkdown(planData));
}

/**
 * The todo list's markdown in the standard markdown block.
 * @param {Array<Record<string, any>>} todos - The list to render.
 * @returns {HTMLElement} Rendered markdown element.
 */
export function createTodoBlock(todos) {
  return createTextBlock(renderTodoMarkdown(todos));
}
