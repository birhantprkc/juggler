//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The whole conversation column is a file drop zone, not just its composer.
 *
 * The interesting part is the overlap: the composer sits inside the column, so
 * both zones see every drop that lands on the box. The column stands down for
 * those (the box's handler runs first and cancels the event), which is what
 * keeps one dropped file from being staged twice — and staging twice is a
 * silent fault, since the second copy just looks like a second attachment.
 *
 * The staging itself (size gates, binary sniffing, upload) is covered by
 * `unit:dropped-file`; what is asserted here is routing: which surface catches
 * a drop, which composer it reaches, and that the event is always cancelled so
 * a stray file can never navigate the window away from the app.
 * @module unit-tests/column-file-drop-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-tab.js';

/**
 * A drag payload standing in for a real one. Only `types`, `files` and
 * `dropEffect` are ever read, and WebKit has no constructible `DataTransfer`.
 * @param {File[]} files - The files the drag carries.
 * @returns {any} A DataTransfer-shaped object.
 */
function fakeDataTransfer(files) {
  return { types: files.length ? ['Files'] : ['text/plain'], files, dropEffect: 'none' };
}

/**
 * Dispatch a drag event with a payload attached. `DragEvent` is not
 * constructible with files, so the payload is defined onto a plain event.
 * @param {EventTarget} target - Where the drag is over.
 * @param {string} type - `dragover`, `dragleave` or `drop`.
 * @param {any} dataTransfer - The payload, from {@link fakeDataTransfer}.
 * @param {EventTarget|null} [relatedTarget] - For dragleave, the element being entered.
 * @returns {Event} The dispatched event, for reading `defaultPrevented`.
 */
function dispatchDrag(target, type, dataTransfer, relatedTarget = null) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  target.dispatchEvent(event);
  return event;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let session = null;

  try {
    session = await createTestSession();
    conversation = await createTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const column = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!column, 'root conversation column should exist');
    const composer = /** @type {any} */ (column.composer);
    assert(!!composer, 'the column should have a composer');

    // A composer defers setupListeners to a rAF, which never runs in a test
    // lane — bind them here, as the dropped-file suite does.
    composer.setupListeners();

    // Stand in for the staging pipeline: this suite is about which files reach
    // which composer, not about what staging does with them.
    /** @type {File[]} */
    const staged = [];
    composer._handleFiles = (/** @type {File[]} */ list) => staged.push(...Array.from(list));
    composer._handleTextFiles = (/** @type {File[]} */ list) => staged.push(...Array.from(list));

    const file = () => new window.File(['notes'], 'notes.txt', { type: 'text/plain' });
    const list = /** @type {HTMLElement} */ (column.querySelector('#message-list'));
    assert(!!list, 'the column should have a message list to drop onto');

    // --- A drop on the transcript reaches the column's composer ---

    const onTranscript = dispatchDrag(list, 'drop', fakeDataTransfer([file()]));
    assert(staged.length === 1,
      `a file dropped on the transcript should be staged once, got ${staged.length}`);
    assert(onTranscript.defaultPrevented,
      'the drop must be cancelled, or the browser navigates to the file and the app is gone');

    // --- A drop on the composer is staged once, not once per zone ---

    const textarea = /** @type {HTMLElement} */ (composer.querySelector('textarea'));
    assert(!!textarea, 'the composer should have a textarea to drop onto');
    dispatchDrag(textarea, 'drop', fakeDataTransfer([file()]));
    assert(staged.length === 2,
      `a file dropped on the composer should be staged once more, got ${staged.length - 1} ` +
      'extra — the column and the box both took it');

    // --- A drag that carries no files is left alone ---

    const textDrag = dispatchDrag(list, 'drop', fakeDataTransfer([]));
    assert(staged.length === 2, 'a drag carrying no files should stage nothing');
    assert(!textDrag.defaultPrevented,
      'a non-file drag must keep its native behaviour');

    // --- The column shows it will take the drop, and stops when the drag leaves ---

    dispatchDrag(list, 'dragover', fakeDataTransfer([file()]));
    assert(column.classList.contains('file-drag-over'),
      'dragging a file over the transcript should mark the column as the drop target');

    dispatchDrag(list, 'dragleave', fakeDataTransfer([file()]), textarea);
    assert(column.classList.contains('file-drag-over'),
      'crossing between the column\u2019s own children is not leaving it');

    dispatchDrag(list, 'dragleave', fakeDataTransfer([file()]), document.body);
    assert(!column.classList.contains('file-drag-over'),
      'the highlight should go when the drag leaves the column');

    // --- The cursor says where a file may be dropped ---

    // Wails' own runtime handler cancels every file drag and sets "no drop", so
    // the guard behind the zones has to re-assert the effect (and does it off
    // the zone's mark, not off defaultPrevented, which that handler has set
    // either way).
    const overColumn = fakeDataTransfer([file()]);
    dispatchDrag(list, 'dragover', overColumn);
    assert(overColumn.dropEffect === 'copy',
      `dragging a file over the column should offer to copy it, got "${overColumn.dropEffect}"`);

    const overNothing = fakeDataTransfer([file()]);
    dispatchDrag(document.body, 'dragover', overNothing);
    assert(overNothing.dropEffect === 'none',
      `dragging a file over nothing in particular should refuse it, got "${overNothing.dropEffect}"`);
    column.classList.remove('file-drag-over');

    // --- A column with no input takes nothing ---

    column.setAttribute('data-hide-input', '');
    const hidden = dispatchDrag(list, 'drop', fakeDataTransfer([file()]));
    assert(staged.length === 2,
      'a column whose input is hidden has nowhere to put a file and must not take one');
    assert(hidden.defaultPrevented,
      'an untaken file drop should still be swallowed by the document-level guard, ' +
      'which is what stops the browser navigating to it');
    dispatchDrag(list, 'dragover', fakeDataTransfer([file()]));
    assert(!column.classList.contains('file-drag-over'),
      'a column that cannot take a file should not offer to');
    column.removeAttribute('data-hide-input');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'column-file-drop:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
