//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The composer's keystroke path does not measure the box.
 *
 * autoResize() resets the textarea's height and reads `scrollHeight`, which is a
 * forced synchronous layout: the read cannot be answered until every pending
 * layout in the document has resolved. Against a settled page that is cheap.
 * Against a streaming one it is not — the transcript is dirtied again between
 * one keystroke and the next, so running it inline makes every character wait
 * for a relayout of the whole conversation before it is echoed.
 *
 * So the `input` handler queues the measurement for the next frame instead, and
 * these tests pin the three properties that has to have:
 *
 *   1. `input` changes no geometry synchronously — the whole point.
 *   2. A burst of keystrokes collapses to ONE queued measurement, not one each.
 *   3. The queue is honoured (the box still resizes) and a direct autoResize()
 *      or an unmount drops it, so nothing is left to run against a dead box.
 *
 * Frames are stubbed rather than awaited: a browser-test lane is an offscreen
 * iframe that never paints, so a real requestAnimationFrame is never delivered
 * on macOS or Linux and awaiting one would hang everywhere but Windows.
 * @module unit-tests/composer-autoresize-defer-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/**
 * Mount a <composer-box> with its listeners bound.
 *
 * render() runs synchronously in connectedCallback but DEFERS setupListeners()
 * to requestAnimationFrame, which a hidden pool window may never pump — so bind
 * directly and neutralise the pending call, as composer-send-latch-test does.
 * The box is given a real width so the textarea wraps and has a height to find.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement}} The mounted box, its textarea, and the container to remove.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px;height:600px;';
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  // The minimum MessageThread surface the input path touches.
  /** @type {any} */ (box)._messageThread = {
    getContextItems: () => [],
    hasBusyItems: () => false,
  };

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');
  return { box, textarea, container };
}

/**
 * Replace requestAnimationFrame with a queue the test drives by hand.
 *
 * Callbacks are run by id, never as a batch: the composer schedules frames for
 * other jobs too, and firing those in a deliberately minimal mount proves
 * nothing and risks throwing inside an unrelated handler.
 * @returns {{runFrame: (id: number|null) => boolean, pending: () => number, restore: () => void}} Run one queued callback by id, count what's queued, and put the real frame API back.
 */
function stubFrames() {
  const realRequest = window.requestAnimationFrame;
  const realCancel = window.cancelAnimationFrame;
  /** @type {Map<number, FrameRequestCallback>} */
  const queue = new Map();
  let nextId = 1;

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };

  return {
    runFrame: (id) => {
      if (id === null) return false;
      const cb = queue.get(id);
      if (!cb) return false;
      queue.delete(id);
      cb(performance.now());
      return true;
    },
    pending: () => queue.size,
    restore: () => {
      window.requestAnimationFrame = realRequest;
      window.cancelAnimationFrame = realCancel;
    },
  };
}

/** Text tall enough that fitting it must change the box's height. */
const TALL_TEXT = 'one\ntwo\nthree\nfour\nfive\nsix';

/**
 * Run the composer auto-resize deferral suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  const errors = [];

  // ── Test 1: typing measures nothing synchronously, and coalesces ──────────
  {
    const { box, textarea, container } = mountComposer();
    const frames = stubFrames();
    try {
      const before = textarea.style.height;

      textarea.value = TALL_TEXT;
      textarea.dispatchEvent(new Event('input'));

      // The assertion the whole change exists for. A synchronous autoResize
      // writes the fitted height right here, so this cannot pass against one.
      assert(textarea.style.height === before,
        `input must not resize the box synchronously — height went ${JSON.stringify(before)} → ${JSON.stringify(textarea.style.height)}`);

      const queuedId = /** @type {any} */ (box)._autoResizeFrame;
      assert(queuedId !== null, 'input must queue a measurement for the next frame');

      // Four more keystrokes in the same frame, as a typist produces.
      for (const text of ['a', 'ab', 'abc', 'abcd']) {
        textarea.value = TALL_TEXT + text;
        textarea.dispatchEvent(new Event('input'));
      }
      assert(/** @type {any} */ (box)._autoResizeFrame === queuedId,
        'a burst of keystrokes must share one queued measurement, not queue one each');
      assert(textarea.style.height === before,
        'no keystroke in the burst may resize the box synchronously');

      // The frame lands and the box catches up.
      assert(frames.runFrame(queuedId), 'the queued measurement must still be in the frame queue');
      assert(/** @type {any} */ (box)._autoResizeFrame === null,
        'a delivered measurement must clear its queue slot');
      assert(textarea.style.height !== before && textarea.style.height.endsWith('px'),
        `the frame must fit the box to its content, got ${JSON.stringify(textarea.style.height)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('typing-defers-measurement: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      frames.restore();
      container.remove();
    }
  }

  // ── Test 2: a direct autoResize supersedes the queued one ─────────────────
  {
    const { box, textarea, container } = mountComposer();
    const frames = stubFrames();
    try {
      textarea.value = TALL_TEXT;
      textarea.dispatchEvent(new Event('input'));
      const queuedId = /** @type {any} */ (box)._autoResizeFrame;
      assert(queuedId !== null, 'input must queue a measurement');

      // Callers that need the height NOW still measure inline, and that must
      // drop the pending frame rather than leave it to measure again.
      /** @type {any} */ (box).autoResize(textarea);

      assert(textarea.style.height.endsWith('px'), 'a direct autoResize must fit the box immediately');
      assert(/** @type {any} */ (box)._autoResizeFrame === null,
        'a direct autoResize must clear the queue slot');
      assert(frames.pending() === 0, 'a direct autoResize must cancel the queued frame, not orphan it');
      passed++;
    } catch (e) {
      failed++;
      errors.push('direct-resize-supersedes: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      frames.restore();
      container.remove();
    }
  }

  // ── Test 3: unmounting drops the queued measurement ───────────────────────
  {
    const { box, textarea, container } = mountComposer();
    const frames = stubFrames();
    try {
      textarea.value = TALL_TEXT;
      textarea.dispatchEvent(new Event('input'));
      assert(/** @type {any} */ (box)._autoResizeFrame !== null, 'input must queue a measurement');

      container.remove();

      assert(/** @type {any} */ (box)._autoResizeFrame === null,
        'unmounting must clear the queue slot');
      assert(frames.pending() === 0,
        'a removed box must leave no frame queued to measure a detached textarea');
      passed++;
    } catch (e) {
      failed++;
      errors.push('unmount-drops-measurement: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      frames.restore();
      container.remove();
    }
  }

  return { passed, failed, errors };
}
