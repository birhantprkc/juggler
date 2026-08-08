//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Answering an inline approval must hand the keyboard back to the message box.
 *
 * An action-confirmation holds focus on one of its own buttons while it is up,
 * then removes itself when answered — which drops focus to <body>. No other
 * focus rule fires at the end of a turn to reclaim it, so without the explicit
 * hand-back the user has to click the box before they can type again. The
 * widget signals with a bubbling `restore-input-focus` and conversation-tab
 * decides where focus lands (Rule 20). Regression guard for that.
 * @module unit-tests/approval-focus-return-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-tab.js';
import '../../js/components/action-confirmation.js'; // registers <action-confirmation>

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:800px;';
  document.body.appendChild(container);

  try {
    const session = await createTestSession();
    const conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    await waitFor(
      () => !!tab.querySelector('composer-box textarea'),
      { description: "active tab's composer-box textarea to build" }
    );

    const textarea = /** @type {HTMLTextAreaElement} */ (
      tab.querySelector('composer-box textarea')
    );
    assert(!!textarea, 'active tab should have a composer-box textarea');

    // Let the post-rebuild focus re-assertion window lapse before touching
    // focus. _reassertInputFocus retries for ~150ms after a column build,
    // re-focusing the box whenever focus is lost to <body> — which would mask
    // the behaviour under test with a pass that has nothing to do with it.
    await new Promise(resolve => setTimeout(resolve, 300));

    // Mount the approval inside the message-list wrapper, where
    // tool-action-message puts one: the wrapper's capture-phase click handler
    // is what classifies a click as an approval action rather than navigation,
    // so mounting anywhere else exercises a different code path.
    const host = /** @type {HTMLElement} */ (
      tab.querySelector('conversation-area #message-list')
      || tab.querySelector('conversation-area conversation-message-list-wrapper')
    );
    assert(!!host, 'tab should have a conversation-area message list');

    const approval = /** @type {any} */ (document.createElement('action-confirmation'));
    host.appendChild(approval);

    /** @type {string|null} */
    let answered = null;
    approval.setOptions(
      { options: [{ label: 'Yes', value: 'yes', style: 'primary' }] },
      (/** @type {string} */ value) => { answered = value; }
    );

    // The widget takes the keyboard, as it does when engaged or clicked.
    const button = /** @type {HTMLButtonElement} */ (
      approval.querySelector('.action-confirmation-button')
    );
    assert(!!button, 'approval should render its option button');
    button.focus();
    assert(
      document.activeElement === button,
      'precondition: approval button holds focus while the approval is up'
    );

    // Answer it, as a click does.
    button.click();
    assert(answered === 'yes', `approval should resolve with its value (got: ${answered})`);
    assert(!approval.isConnected, 'answered approval should remove itself');

    // The behaviour under test: focus comes back to the box, so the next
    // keystroke composes the next message. Deferred a frame by Rule 20.
    await waitFor(
      () => document.activeElement === textarea,
      { timeoutMs: 2000, description: 'focus to return to the message box' }
    ).catch(() => {});

    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const where = active === textarea
      ? 'textarea'
      : (active?.tagName || 'none') + (active === document.body ? '(body)' : '');
    assert(
      active === textarea,
      `message box must hold focus after answering an approval, but focus was on: ${where}`
    );

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
