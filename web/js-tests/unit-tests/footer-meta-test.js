//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The footer's readings row — the token meter and the "Updated …" time. Neither
 * is a control, and each fails for its own reasons:
 *   1. `MessageThread.lastActivityAt` derives the time by scanning back for the
 *      newest item the worker dated. Nothing stores a conversation-level
 *      modification time, so items the client inserted optimistically (no
 *      `timestamp` yet) must not blank the answer.
 *   2. The time shows only at rest — a running turn must not leave a label on
 *      screen claiming a time that is really "now", and a group column
 *      (status-only) is a lens on a run of rows, not the thread the time is of.
 *   3. The row has to survive a narrow column: every figure stays joined to the
 *      unit or word that qualifies it, and a million-token window is stated in
 *      millions rather than as four digits of thousands.
 *   4. The button that opens this conversation's log rides with the time — the
 *      same reading, so the same visibility — and must name the conversation it
 *      belongs to when it deep-links into the Logs tab.
 * @module unit-tests/footer-meta-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-footer.js';
import '../../js/components/token-display.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import { formatRelativeDateTime, formatTokens } from '../../js/utils/format.js';

/**
 * Run the footer readings-row test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {unknown} e - Whatever a check threw.
   * @returns {string} The error's message.
   */
  const msg = (e) => e instanceof Error ? e.message : String(e);

  // --- 1: lastActivityAt reads the newest dated item -----------------------
  try {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const thread = conversation.rootMessageThread;

    assert(thread.lastActivityAt === 0, 'a thread with no items has no last-activity time');

    const older = new Date('2026-02-03T10:00:00Z');
    const newer = new Date('2026-02-03T10:05:00Z');
    thread.addEvent({ type: 'user', content: 'first', timestamp: older.toISOString() });
    assert(thread.lastActivityAt === older.getTime(), 'one dated item dates the thread');

    thread.addEvent({ type: 'assistant', content: 'second', timestamp: newer.toISOString() });
    assert(thread.lastActivityAt === newer.getTime(), 'the newest dated item wins');

    // The client appends before the worker echoes the item back with its
    // timestamp; that gap must leave the previous answer standing rather than
    // clearing the label to nothing.
    thread.addEvent({ type: 'user', content: 'not yet dated' });
    assert(thread.lastActivityAt === newer.getTime(),
      'an undated item is skipped, not treated as "unknown"');
    passed++;
  } catch (e) { failed++; errors.push(`lastActivityAt: ${msg(e)}`); }

  // --- 2: the footer shows it at rest, and only at rest --------------------
  const footer = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(footer);
  try {
    const at = new Date('2026-02-03T10:05:00Z').getTime();
    const { short, full } = formatRelativeDateTime(at);
    const label = () => /** @type {HTMLElement|null} */ (footer.querySelector('.footer-last-activity'));
    // The time and the log button are one reading, shown and hidden together, so
    // the `hidden` class lives on the pair rather than on either of them.
    const group = () => /** @type {HTMLElement|null} */ (footer.querySelector('.footer-activity'));
    /**
     * @param {Element|null} el - A part of the footer.
     * @returns {boolean} True when that part is hidden.
     */
    const hidden = (el) => !!el?.classList.contains('hidden');

    footer.update({ isProcessing: false, canContinue: true, lastActivityAt: at });
    assert(!hidden(group()), 'an idle footer dates the thread it ends');
    assert(label()?.textContent === `Updated ${short}`,
      'the label reads through the app-wide relative date-time formatter');
    assert(label()?.title === `Last updated ${full}`,
      'the tooltip carries the full absolute time the short label elides');
    assert(group()?.contains(footer.querySelector('.footer-log-btn')),
      'the log button rides with the time rather than standing on its own');
    passed++;

    footer.update({ isProcessing: true, statusMessage: 'Running…', lastActivityAt: at });
    assert(hidden(group()), 'a running turn dates itself, so the label goes for the duration');
    passed++;

    footer.update({ isProcessing: false, canContinue: false, lastActivityAt: 0 });
    assert(hidden(group()), 'a conversation with nothing in it has no date to show');
    passed++;

    footer.setStatusOnly(true);
    footer.update({ isProcessing: false, canContinue: true, lastActivityAt: at });
    assert(hidden(group()) && hidden(footer.querySelector('.footer-meta')),
      'a group column shows a run of rows, not the thread whose time this is');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`footer render: ${msg(e)}`);
  } finally {
    footer.remove();
  }

  // --- 3: the meter reads the same however narrow the column ---------------
  const pill = /** @type {any} */ (document.createElement('token-display'));
  document.body.appendChild(pill);
  try {
    pill.setUsage({ total: 872000, cached: null, budget: 1048576 });
    const text = pill.textContent || '';
    assert(text.includes('872k'), `the total states its own figure, got ${JSON.stringify(text)}`);
    assert(text.includes('/\u00A01M'),
      `the window reads in millions, glued to its slash, got ${JSON.stringify(text)}`);
    assert(!/\/ /.test(text),
      `nothing in the meter may wrap after the slash, got ${JSON.stringify(text)}`);
    passed++;

    assert(formatTokens(1000000) === '1M', 'a round million is a bare "1M"');
    assert(formatTokens(1500000) === '1.5M', 'a part million keeps one decimal');
    assert(formatTokens(2097152) === '2M', 'a redundant decimal is dropped');
    assert(formatTokens(999999) === '999k',
      'the million tier floors like the thousand tier, so a count never reads high');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`token meter: ${msg(e)}`);
  } finally {
    pill.remove();
  }

  // --- 4: the log button names its own conversation ------------------------
  const logFooter = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(logFooter);
  /** @type {(() => void)|null} */
  let restoreOpener = null;
  try {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    logFooter.setMessageThread(conversation.rootMessageThread);

    /** @type {Array<[string|undefined, any]>} */
    const opened = [];
    restoreOpener = registerSettingsOpener((tab, options) => { opened.push([tab, options]); });

    /** @type {HTMLElement} */ (logFooter.querySelector('.footer-log-btn')).click();
    assert(opened.length === 1, `one click opens settings once, got ${opened.length}`);
    assert(opened[0][0] === 'logs', `on the Logs tab, got ${JSON.stringify(opened[0][0])}`);
    // Without the id the Logs tab would open on server.log and leave the user
    // hunting their conversation in the picker — the thing the button exists to
    // avoid.
    assert(opened[0][1]?.conversationLog === conversation.id,
      `naming this conversation, got ${JSON.stringify(opened[0][1])}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`log button: ${msg(e)}`);
  } finally {
    if (restoreOpener) restoreOpener();
    logFooter.remove();
  }

  return { passed, failed, errors };
}
