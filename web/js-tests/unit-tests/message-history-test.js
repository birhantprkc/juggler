//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Prompt-history structure tests — the up/down-arrow history stores a message
 * snapshot ({content, attachments}), not a bare string, and reuses that one
 * shape everywhere it touches a message.
 *
 * Backend-free:
 *  1. normalize — normalizeHistoryEntry coerces legacy strings, passes objects
 *     through, and defends against a null/garbage entry;
 *  2. dedup — addMessageToHistory dedups on content and keeps the NEWEST
 *     attachments, floating a resend to the most-recent slot; a bare string is
 *     accepted and wrapped;
 *  3. recall — ArrowUp restores BOTH the text and the staged image chips;
 *  4. broken asset — an entry whose attachment no longer resolves still recalls
 *     without throwing (the chip renders broken and drops at send).
 * @module unit-tests/message-history-test
 */

import Session, { normalizeHistoryEntry } from '../../js/model/session.js';
import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/**
 * A sample uploaded image attachment ref.
 * @param {string} id
 * @returns {{id:string,mime:string,filename:string,bytes:number,width:number,height:number}} A sample uploaded image AssetRef.
 */
function ref(id) {
  return { id, mime: 'image/png', filename: `${id}.png`, bytes: 100, width: 1, height: 1 };
}

/**
 * Mount an <composer-box> offscreen with listeners bound synchronously (render
 * defers setupListeners to rAF, which never pumps in the hidden test window).
 * @returns {{box: any, container: HTMLElement}} The mounted box and its container.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:360px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);
  /** @type {any} */ (box).setupListeners?.();
  /** @type {any} */ (box).setupListeners = () => {};
  return { box, container };
}

/**
 * Invoke addMessageToHistory against a minimal stub, isolating the dedup/cap
 * logic from the full Session construction (workerManager, registries, …).
 * @param {Array<any>} history
 * @param {any} message
 * @returns {Array<any>} The mutated history array (same reference).
 */
function addToHistory(history, message) {
  const stub = { messageHistory: history, save() {} };
  Session.prototype.addMessageToHistory.call(stub, message);
  return stub.messageHistory;
}

/**
 * Run the message-history test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 1. Normalize ──────────────────────────────────────────────────────────

  await test('normalizeHistoryEntry wraps a legacy bare string', () => {
    const got = normalizeHistoryEntry('hello world');
    assert(got.content === 'hello world', `content wrong: ${JSON.stringify(got)}`);
    assert(Array.isArray(got.attachments) && got.attachments.length === 0, 'legacy string has no attachments');
  });

  await test('normalizeHistoryEntry passes an object through and normalizes attachments', () => {
    const got = normalizeHistoryEntry({ content: 'hi', attachments: [ref('sha1')] });
    assert(got.content === 'hi', 'content preserved');
    assert(got.attachments.length === 1 && got.attachments[0].id === 'sha1', 'attachment preserved as AssetRef');
  });

  await test('normalizeHistoryEntry defends against null/garbage', () => {
    for (const bad of [null, undefined, 42, {}]) {
      const got = normalizeHistoryEntry(/** @type {any} */ (bad));
      assert(typeof got.content === 'string' && Array.isArray(got.attachments),
        `must degrade to an empty message for ${JSON.stringify(bad)}: ${JSON.stringify(got)}`);
    }
  });

  // ── 2. Dedup ──────────────────────────────────────────────────────────────

  await test('addMessageToHistory appends normalized entries', () => {
    const h = addToHistory([], { content: 'first', attachments: [] });
    addToHistory(h, { content: 'second', attachments: [ref('a')] });
    assert(h.length === 2, `expected 2 entries, got ${h.length}`);
    assert(h[1].content === 'second' && h[1].attachments[0].id === 'a', 'newest entry at the end with its attachments');
  });

  await test('addMessageToHistory accepts a bare string and wraps it', () => {
    const h = addToHistory([], 'typed text');
    assert(h.length === 1 && h[0].content === 'typed text' && h[0].attachments.length === 0,
      `bare string not wrapped: ${JSON.stringify(h)}`);
  });

  await test('addMessageToHistory dedups on content and keeps the newest attachments', () => {
    const h = addToHistory([], { content: 'dupe', attachments: [ref('old')] });
    addToHistory(h, { content: 'other', attachments: [] });
    addToHistory(h, { content: 'dupe', attachments: [ref('new')] });
    assert(h.length === 2, `dedup should leave 2 entries, got ${h.length}`);
    const last = h[h.length - 1];
    assert(last.content === 'dupe', 'resend floats to the most-recent slot');
    assert(last.attachments.length === 1 && last.attachments[0].id === 'new',
      `newest attachments must win: ${JSON.stringify(last.attachments)}`);
  });

  // ── 3. Recall ─────────────────────────────────────────────────────────────

  await test('ArrowUp restores both the text and the staged image chip', () => {
    const { box, container } = mountComposer();
    try {
      box.session = { messageHistory: [{ content: 'recall me', attachments: [ref('img-sha')] }] };
      const textarea = box.querySelector('textarea');
      textarea.value = '';
      textarea.selectionStart = textarea.selectionEnd = 0;
      box._navigateHistoryUp(textarea, 0, 0);
      assert(box.getText() === 'recall me', `text not recalled: ${JSON.stringify(box.getText())}`);
      assert(box._pendingAttachments.length === 1 && box._pendingAttachments[0].id === 'img-sha',
        `image chip not re-staged: ${JSON.stringify(box._pendingAttachments)}`);
    } finally {
      container.remove();
    }
  });

  await test('ArrowUp then ArrowDown restores the original draft and its attachments', () => {
    const { box, container } = mountComposer();
    try {
      box.session = { messageHistory: [{ content: 'old prompt', attachments: [] }] };
      const textarea = box.querySelector('textarea');
      // The live draft carries text; navigate up into history, then back down.
      textarea.value = 'draft in progress';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      box._navigateHistoryUp(textarea, textarea.value.length, textarea.value.length);
      assert(box.getText() === 'old prompt', 'up lands on history entry');
      const end = box.getText().length;
      textarea.selectionStart = textarea.selectionEnd = end;
      box._navigateHistoryDown(textarea, end, end);
      assert(box.getText() === 'draft in progress', `down must restore the draft: ${JSON.stringify(box.getText())}`);
    } finally {
      container.remove();
    }
  });

  // ── 4. Broken asset ───────────────────────────────────────────────────────

  await test('an entry whose asset no longer resolves recalls without throwing', () => {
    const { box, container } = mountComposer();
    try {
      box.session = { messageHistory: [{ content: 'gone', attachments: [ref('missing-sha')] }] };
      const textarea = box.querySelector('textarea');
      textarea.value = '';
      textarea.selectionStart = textarea.selectionEnd = 0;
      // Must not throw even though the asset bytes are gone: the chip stages and
      // renders broken; the missing part is dropped at send (llm_caller).
      box._navigateHistoryUp(textarea, 0, 0);
      assert(box.getText() === 'gone', 'text still recalled with a dead asset');
      assert(box._pendingAttachments.length === 1 && box._pendingAttachments[0].id === 'missing-sha',
        'the (broken) chip is still staged');
    } finally {
      container.remove();
    }
  });

  return { passed, failed, errors };
}
