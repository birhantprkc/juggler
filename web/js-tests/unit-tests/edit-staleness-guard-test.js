//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests the read-before-mutate freshness guard (Claude Code-style).
 *
 * The edit tool refuses to modify — and the write tool refuses to overwrite —
 * a file the model hasn't looked at this session, or whose bytes changed on
 * disk since the model last saw them. Freshness is derived entirely from the
 * durable conversation transcript (context-items/read-history.js): successful
 * read/write/edit/batch_read tool-actions (whose recorded results carry the
 * backend's contentHash) and pinned/at-mentioned file-content items.
 *
 * These tests seed that transcript state directly rather than executing reads
 * in-process — which is also the point: freshness is doc-derived, so a read
 * persisted by a PRIOR app session or ANOTHER client is honored identically,
 * with no per-process record to lose on relaunch. The full real-pipeline path
 * (write-then-edit across turns) is covered by integration-tests/edit-tests.js.
 * @module unit-tests/edit-staleness-guard
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import {
  recordWrittenHash,
  __resetWrittenHashesForTest
} from '../../extensions/juggler-core/context-items/read-history.js';

/** A syntactically valid SHA-256 that matches no real file. */
const BOGUS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/** Monotonic counter so every seeded tool-action gets a unique toolUseId. */
let seedCounter = 0;

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run read-before-mutate freshness guard tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
  assert(EditClass, 'edit action should be registered');
  const WriteClass = /** @type {any} */ (contextItemRegistry.getByToolName('write'));
  assert(WriteClass, 'write action should be registered');

  /**
   * Build an item of the given class bound to a conversation.
   * @param {any} Cls - Context-item class
   * @param {any} conversation - Conversation instance
   * @returns {any} Item instance
   */
  const mkItem = (Cls, conversation) => new Cls({
    id: Cls.MANIFEST.id,
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });

  /**
   * Seed a COMPLETED, successful tool-action into the conversation transcript
   * — the durable "the model has seen this file" record a real tool call (or a
   * prior session / another client) would leave behind. `payload` is stored
   * nested at `fullResult.result`, matching how the action pipeline persists
   * the backend's ops result.
   * @param {any} conversation - Conversation instance
   * @param {string} toolName - 'read' | 'write' | 'edit' | 'batch_read'
   * @param {object} toolInput - Tool input to record
   * @param {object} [payload] - Backend ops result to record (carries contentHash)
   * @returns {void}
   */
  const seedAction = (conversation, toolName, toolInput, payload) => {
    conversation.rootMessageThread.appendToolAction({
      toolUseId: `seed_${toolName}_${++seedCounter}`,
      toolName,
      toolInput,
      state: 'completed',
      result: {
        content: `${toolName} ok`,
        isError: false,
        ...(payload ? { fullResult: { state: 'completed', success: true, result: payload } } : {})
      }
    });
  };

  /**
   * Seed a seen-record for `path` (hash-less unless given).
   * @param {any} conversation - Conversation instance
   * @param {string} toolName - Seen-tool name
   * @param {string} path - File path the action targeted
   * @param {string} [contentHash] - Hash to record with the result
   * @returns {void}
   */
  const seedSeen = (conversation, toolName, path, contentHash) =>
    seedAction(conversation, toolName, { file_path: path },
      contentHash ? { contentHash } : undefined);

  /**
   * @param {unknown} e - Caught error
   * @returns {string} Human-readable message
   */
  const msg = (e) => (e instanceof Error ? e.message : String(e));

  /**
   * Run one test case.
   * @param {string} name - Test label for error reporting
   * @param {() => Promise<void>} fn - Test body (throws on failure)
   * @returns {Promise<void>}
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${msg(e)}`);
    }
  };

  // =========================================================================
  // Never-seen: an edit to a file with no transcript record is REFUSED. The
  // file exists on disk (seeded via the ops layer, which leaves NO
  // tool-action), so only the read-before-edit guard can reject it.
  // =========================================================================
  await test('never-seen edit refused', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-never.txt', content: 'hello world\n' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-never.txt', old_string: 'world', new_string: 'there' });

    assert(res.valid === false, `never-seen edit must be refused, got ${JSON.stringify(res)}`);
    assert(/has not been read/i.test(res.error || ''),
      `error should tell the model to read first: ${res.error}`);
  });

  // =========================================================================
  // Seen without a hash: a read/write/edit record that carries no contentHash
  // (transcripts written before hashes were recorded) counts as
  // seen-but-unverifiable and ALLOWS the edit rather than forcing a re-read.
  // =========================================================================
  await test('hash-less read allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-read.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-read.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-read.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `read-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('hash-less write allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-write.txt', content: 'hello world\n' });
    seedSeen(conversation, 'write', 'guard-write.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-write.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `write-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('hash-less edit allows re-edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-reedit.txt', content: 'hello world\n' });
    seedSeen(conversation, 'edit', 'guard-reedit.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-reedit.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `re-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Pinned / at-mentioned file-content items ALLOW the edit — pins are
  // re-rendered into context at send time, so they always count as fresh.
  // =========================================================================
  await test('pinned file allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-pin.txt', content: 'hello world\n' });
    await conversation.rootMessageThread.executeContextItem('file-content', { path: 'guard-pin.txt' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-pin.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `pinned-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Staleness: a recorded hash that does not match the file's current bytes
  // means the file changed since the model read it — the edit is REFUSED.
  // A matching recorded hash is fresh and ALLOWED.
  // =========================================================================
  await test('stale hash refuses edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-stale.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-stale.txt', BOGUS_HASH);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-stale.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === false, `stale edit must be refused, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('matching hash allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-fresh.txt', content: 'hello world\n' });
    assert(typeof writeRes.contentHash === 'string' && writeRes.contentHash,
      'writeFileOp should report the written contentHash');
    seedSeen(conversation, 'read', 'guard-fresh.txt', writeRes.contentHash);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-fresh.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `fresh-hash edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // batch_read: a file read through the batch tool counts as seen via its
  // per-file result entry; an entry whose read FAILED proves nothing.
  // =========================================================================
  await test('batch_read allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-batch.txt', content: 'hello world\n' });
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-other.txt' }, { file_path: 'guard-batch.txt' }] },
      {
        _batchType: 'read',
        results: [
          { file: 'guard-other.txt', success: false, error: 'nope' },
          { file: 'guard-batch.txt', success: true, result: { exists: true, contentHash: writeRes.contentHash } }
        ]
      });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batch.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `batch_read-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('failed batch_read entry does not count', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-batchfail.txt', content: 'hello world\n' });
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-batchfail.txt' }] },
      { _batchType: 'read', results: [{ file: 'guard-batchfail.txt', success: false, error: 'denied' }] });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batchfail.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === false, `failed batch entry must not count as seen, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // explore_code: files the sandbox script fs.readFile-ed are recorded in the
  // result's filesRead map and earn full hash credit; a stale recorded hash
  // still refuses.
  // =========================================================================
  await test('explore_code read allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-explore.txt', content: 'hello world\n' });
    seedAction(conversation, 'explore_code',
      { code: 'return (await fs.readFile("guard-explore.txt")).length' },
      { result: 12, filesRead: { 'guard-explore.txt': writeRes.contentHash } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `explore_code-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('stale explore_code read refuses edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-explore-stale.txt', content: 'hello world\n' });
    seedAction(conversation, 'explore_code',
      { code: 'return null' },
      { result: null, filesRead: { 'guard-explore-stale.txt': BOGUS_HASH } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore-stale.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === false, `stale explore_code read must refuse, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('stripped batch_read results fall back to input list', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-batchbig.txt', content: 'hello world\n' });
    // Large batches have their per-file results replaced by a count in
    // storage; the input list still proves the read covered this file.
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-batchbig.txt' }] },
      { _batchType: 'read', resultsCount: 8 });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batchbig.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `stripped batch results must still count as seen, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Path forms: `./x`, `x`, and the absolute form all canonicalise to one key
  // (path-approval.js absolutePathKey), so a file seen by one form is editable
  // by another.
  // =========================================================================
  await test('path form variance still matches', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-relform.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', './guard-relform.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-relform.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `./-prefixed read must cover the plain path, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Write tool: overwriting an EXISTING never-read file is refused (a blind
  // overwrite destroys content the model has never seen); overwriting a stale
  // file is refused; creating a new file or overwriting a seen one is allowed.
  // =========================================================================
  await test('never-read overwrite refused', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-clobber.txt', content: 'precious\n' });

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber.txt', content: 'gone\n' });
    assert(res.valid === false, `never-read overwrite must be refused, got ${JSON.stringify(res)}`);
    assert(/has not been read/i.test(res.error || ''),
      `error should tell the model to read first: ${res.error}`);
  });

  await test('stale overwrite refused', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-clobber-stale.txt', content: 'precious\n' });
    seedSeen(conversation, 'read', 'guard-clobber-stale.txt', BOGUS_HASH);

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-stale.txt', content: 'gone\n' });
    assert(res.valid === false, `stale overwrite must be refused, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('new-file write allowed', async () => {
    const conversation = await createTestConversation(session);
    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-brand-new.txt', content: 'fresh\n' });
    assert(res.valid === true, `creating a new file must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('read-then-overwrite allowed', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-clobber-ok.txt', content: 'precious\n' });
    seedSeen(conversation, 'read', 'guard-clobber-ok.txt', writeRes.contentHash);

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-ok.txt', content: 'replaced\n' });
    assert(res.valid === true, `read-then-overwrite must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // In-flight sibling edits: when several edits to the same file execute within
  // one assistant turn, an earlier edit's completed tool-action (carrying its
  // post-edit hash) may not yet be visible in the durable transcript when the
  // next edit validates. recordWrittenHash captures that hash synchronously at
  // execute time, so the follow-up edit is NOT spuriously refused as stale —
  // while a genuine out-of-band change (a hash we never wrote) still is.
  // =========================================================================
  await test('same-turn sibling edit passes via written-hash record', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    // The transcript only knows the v0 the model read.
    const v0 = await writeFileOp({ path: 'guard-sibling.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-sibling.txt', v0.contentHash);

    // An earlier edit this turn rewrote the file to v1, but its tool-action has
    // not surfaced in the transcript yet — only the in-memory record knows v1.
    const v1 = await writeFileOp({ path: 'guard-sibling.txt', content: 'hello there\n' });
    recordWrittenHash(session, 'guard-sibling.txt', v1.contentHash);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-sibling.txt', old_string: 'there', new_string: 'everyone' });
    assert(res.valid === true, `sibling edit should pass once its hash is recorded, got ${JSON.stringify(res)}`);
  });

  await test('out-of-band change still refused without a written-hash record', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFileOp({ path: 'guard-oob.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-oob.txt', v0.contentHash);

    // The file changed on disk to bytes we never wrote and never recorded.
    await writeFileOp({ path: 'guard-oob.txt', content: 'hello there\n' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-oob.txt', old_string: 'there', new_string: 'everyone' });
    assert(res.valid === false, `genuine out-of-band change must still be refused, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('same-turn sibling overwrite passes via written-hash record', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFileOp({ path: 'guard-sibling-w.txt', content: 'precious\n' });
    seedSeen(conversation, 'read', 'guard-sibling-w.txt', v0.contentHash);

    const v1 = await writeFileOp({ path: 'guard-sibling-w.txt', content: 'changed\n' });
    recordWrittenHash(session, 'guard-sibling-w.txt', v1.contentHash);

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-sibling-w.txt', content: 'again\n' });
    assert(res.valid === true, `sibling overwrite should pass once its hash is recorded, got ${JSON.stringify(res)}`);
  });

  return { passed, failed, errors };
}
