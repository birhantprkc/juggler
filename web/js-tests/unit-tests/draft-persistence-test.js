//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Integration test for draft persistence across reload.
 *
 * A draft message is ONE object — its text AND its image attachments. Both
 * halves must survive a save/reload cycle (the user's quit-and-restart): the
 * historical bug kept the text but silently dropped the attachments, because
 * the text lived in the Yjs doc while the attachments lived only on the
 * composer-box component. This test sets a draft as a single {text, attachments}
 * record on the model, reloads the conversation from the backend, and asserts
 * both halves come back.
 *
 * Mirrors conversation-name-persistence-test.js (true destroy + reload), not an
 * in-memory shortcut, so it exercises the on-disk Yjs round-trip.
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation
} from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';
import logger from '../utilities/test-logger.js';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  await initializeRegistries();

  // Operate ONLY on our own conversation — never terminateAll() or clear the
  // session's other conversations. In the shared iframe pool that bulldozes
  // sibling lanes' live conversations (see project memory: cross-lane conv
  // bulldoze). We create one conversation, reload just that one, and verify.
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const convId = conversation.id;

  const draftText = 'unsent message with an image attachment';
  const ref = { id: 'sha-draft-1', mime: 'image/png', filename: 'pixel.png', bytes: 123, width: 1, height: 1 };
  // A pending "send after a delay" is part of the same draft record — its
  // epoch-ms target must survive quit/restart too, or a scheduled send silently
  // evaporates on reload (the whole point of persisting it on the draft rather
  // than in a live-only timer).
  const scheduledSendAt = Date.now() + 3_600_000;

  // Set the draft as ONE object — text + attachments + scheduled-send target.
  conversation.rootMessageThread.draft = { text: draftText, attachments: [ref], scheduledSendAt };
  // Push the write to the worker promptly so the only thing left to wait on is
  // the worker's debounced save, not browser→worker sync latency.
  conversation._doc.flushPendingUpdates();

  // Force the worker to persist now and wait for the write to complete, instead
  // of sleeping past the 2s SaveDebounceTime. Deterministic: the flush stops the
  // debounce timer and saves synchronously, acking only once the write is done,
  // so the save is guaranteed on disk before the destroy below (a destroy marks
  // the worker deleting and SKIPS saves).
  await workerManager.flushPersistence(convId);

  // Destroy + reload (simulates quit/restart).
  await workerManager.destroyConversationAndWorker(conversation);
  session.conversations.delete(convId);
  await session.load();
  // Deterministically wait for the reloaded conversation's doc to load from
  // disk (mirrors context-item-persistence) rather than racing a fixed delay.
  await session.ensureConversationLoaded(convId);

  const reloaded = session.conversations.get(convId);
  if (!reloaded) {
    return { passed: 0, failed: 1, errors: ['Conversation did not reload from backend'] };
  }

  /** @type {string[]} */
  const errors = [];
  const draft = reloaded.rootMessageThread.draft;

  if (!draft || draft.text !== draftText) {
    errors.push(`Draft text not persisted across reload. Expected ${JSON.stringify(draftText)}, got ${JSON.stringify(draft && draft.text)}`);
  }

  const atts = (draft && draft.attachments) || [];
  if (atts.length !== 1) {
    errors.push(`Draft attachment count wrong after reload. Expected 1, got ${atts.length}: ${JSON.stringify(atts)}`);
  } else {
    const a = atts[0];
    if (a.id !== ref.id || a.mime !== ref.mime || a.filename !== ref.filename) {
      errors.push(`Draft attachment ref not persisted faithfully. Expected ${JSON.stringify(ref)}, got ${JSON.stringify(a)}`);
    }
  }

  if (!draft || draft.scheduledSendAt !== scheduledSendAt) {
    errors.push(`Draft scheduled-send target not persisted across reload. Expected ${scheduledSendAt}, got ${JSON.stringify(draft && draft.scheduledSendAt)}`);
  }

  if (!draft || draft.scheduledSendMode !== 'delay') {
    errors.push(`Draft scheduled-send mode should default to 'delay', got ${JSON.stringify(draft && draft.scheduledSendMode)}`);
  }

  // The other wait — "send at end of turn" — rides the same record as a mode
  // beside the instant, and the instant is what disarms BOTH: clearing
  // scheduledSendAt must leave no turn-end wait behind to fire against a later,
  // unrelated draft.
  const thread = reloaded.rootMessageThread;
  thread.draft = { text: draftText, scheduledSendAt: Date.now(), scheduledSendMode: 'turn-end' };
  if (thread.draft.scheduledSendMode !== 'turn-end') {
    errors.push(`Turn-end scheduled-send mode did not round-trip, got ${JSON.stringify(thread.draft.scheduledSendMode)}`);
  }
  thread.draft = { text: draftText, scheduledSendAt: null, scheduledSendMode: 'turn-end' };
  if (thread.draft.scheduledSendMode !== 'delay') {
    errors.push(`Clearing the target left a turn-end wait armed, got ${JSON.stringify(thread.draft.scheduledSendMode)}`);
  }

  if (errors.length === 0) {
    logger.info('[draft-persistence-test] Test PASSED - draft text + attachments + scheduled-send target persisted across reload');
    return { passed: 1, failed: 0, errors: [] };
  }
  return { passed: 0, failed: errors.length, errors };
}
