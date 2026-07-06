//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Slash-command completions on the input box.
 *
 * Typing `/` at the START of a message activates the shared caret-anchored
 * completion menu (the same one `@` file-mentions use), populated from the
 * registered slash commands. This suite pins:
 *   1. the slash provider triggers only at message start (a bare `/`, `/cl`),
 *      never mid-message and never for an `@` mention,
 *   2. its fetch is filtered by the typed prefix and offers /clear,
 *   3. accepting a command inserts `/name ` (text only) — matching the
 *      `@`-mention model where accept splices text and the user still presses
 *      Enter to run it,
 *   4. the input box wires slash + file-mention providers into one menu, with
 *      slash taking precedence at the message start.
 *
 * Assertions read SYNCHRONOUS, deterministic state: `handleInput()` selects the
 * active provider and anchor before it kicks off the (debounced) fetch, the
 * provider's `fetch`/`insert` are awaited/called directly, and `accept()` is
 * driven from explicit menu state exactly as the `@`-mention test driver does.
 * The debounced fetch and the layout-dependent popup surface are deliberately
 * NOT exercised here — background-window timer throttling makes them racy, and
 * the provider contract above is what actually matters.
 * @module unit-tests/slash-completion-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import slashCommandHandler from '../../js/services/slash-command-handler.js';
import { slashCommandProvider } from '../../js/components/slash-command-provider.js';
import { fileMentionProvider } from '../../js/components/file-mention-provider.js';
import '../../js/components/input-box.js';

/**
 * Mount an <input-box> and bind its listeners synchronously (render() defers
 * setupListeners() to rAF, which never pumps in the hidden test window).
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement}} The mounted input-box, its textarea and container.
 */
function mountInputBox() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:480px;height:600px;';
  const box = document.createElement('input-box');
  container.appendChild(box); // connectedCallback → render() writes the DOM now
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'input-box must render a textarea');
  return { box, textarea, container };
}

/**
 * Run the slash-command completion suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  await initializeRegistries();
  await slashCommandHandler.init();

  let passed = 0;
  let failed = 0;
  const errors = [];

  // ── Test 1: provider triggers only at message start; fetch filters ────────
  {
    try {
      // detect() is the trigger gate — synchronous and pure.
      const bare = slashCommandProvider.detect('/');
      assert(!!bare && bare.anchorPos === 0 && bare.query === '',
        `"/" must trigger at anchor 0 with empty query, got ${JSON.stringify(bare)}`);

      const partial = slashCommandProvider.detect('/cl');
      assert(!!partial && partial.anchorPos === 0 && partial.query === 'cl',
        `"/cl" must trigger with query "cl", got ${JSON.stringify(partial)}`);

      assert(slashCommandProvider.detect('run /cl') === null,
        'a "/" that is not at the message start must NOT trigger');
      assert(slashCommandProvider.detect('@src/main.go') === null,
        'an @-mention must NOT trigger the slash provider');
      assert(slashCommandProvider.detect('/two words') === null,
        'once a space is typed the command name is settled — no trigger');

      // fetch() is registry-backed; await it directly (no debounce).
      const all = (await slashCommandProvider.fetch('')).map((c) => c.name);
      assert(all.includes('clear'), `fetch("") must offer /clear, got ${JSON.stringify(all)}`);

      const filtered = (await slashCommandProvider.fetch('cl')).map((c) => c.name);
      assert(filtered.length > 0 && filtered.every((n) => n.startsWith('cl')),
        `fetch("cl") must return only cl* commands, got ${JSON.stringify(filtered)}`);
      assert(filtered.includes('clear'), `fetch("cl") must still offer /clear, got ${JSON.stringify(filtered)}`);

      // insert() splices text only — "/name " with a trailing space, no send.
      assert(slashCommandProvider.insert({ name: 'clear' }) === '/clear ',
        'insert must produce "/clear " (text only)');
      passed++;
    } catch (e) {
      failed++;
      errors.push('slash-provider-detect-and-fetch: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 2: the input box wires both providers; slash wins at msg start ────
  {
    const { box, textarea, container } = mountInputBox();
    try {
      const menu = box._completions;
      assert(!!menu, 'input-box must construct a CompletionMenu');
      assert(menu._providers.some((/** @type {any} */ p) => p === slashCommandProvider),
        'the menu must include the slash-command provider');
      assert(menu._providers.some((/** @type {any} */ p) => p === fileMentionProvider),
        'the menu must include the file-mention provider');

      // handleInput() selects the active provider + anchor SYNCHRONOUSLY, before
      // the debounced fetch — so this is deterministic in a throttled window.
      textarea.value = '/cl';
      textarea.selectionStart = textarea.selectionEnd = 3;
      menu.handleInput();
      assert(menu._provider === slashCommandProvider,
        'typing "/cl" at message start must select the slash-command provider');
      assert(menu._anchorPos === 0, 'the slash anchor must be the message start');

      // A "/" mid-message selects no provider and closes the menu.
      textarea.value = 'run /cl';
      textarea.selectionStart = textarea.selectionEnd = 7;
      menu.handleInput();
      assert(!menu.isActive() && menu._provider === null,
        'a "/" mid-message must not activate any completion provider');
      passed++;
    } catch (e) {
      failed++;
      errors.push('input-box-wires-providers: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._completions.close();
      container.remove();
    }
  }

  // ── Test 3: accepting a command inserts "/name " and closes the menu ──────
  // Driven from explicit menu state, exactly as the @-mention test driver does
  // (bypasses the debounced fetch + popup surface, which are timer/layout bound).
  {
    const { box, textarea, container } = mountInputBox();
    try {
      const menu = box._completions;
      textarea.value = '/cl';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

      menu._provider = slashCommandProvider;
      menu._anchorPos = 0;
      menu._items = [{ name: 'clear', label: 'Clear', description: 'Clear the conversation' }];
      menu._index = 0;
      menu._active = true;

      menu.accept();

      assert(textarea.value === '/clear ',
        `accepting /clear must insert "/clear " (text only), got ${JSON.stringify(textarea.value)}`);
      assert(!menu.isActive(), 'accepting a command must close the menu');
      passed++;
    } catch (e) {
      failed++;
      errors.push('slash-accept-inserts-text: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._completions.close();
      container.remove();
    }
  }

  return { passed, failed, errors };
}
