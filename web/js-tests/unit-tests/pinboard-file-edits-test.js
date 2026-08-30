//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the board can honestly say a conversation changed.
 *
 * `services.fileEdits` is derived from the transcript rather than kept beside it,
 * so what it reports is exactly the tool actions that completed — and everything
 * asserted here is about the gap between "this tool ran" and "this file changed".
 * An action still running, one that failed, one the user cancelled, one whose
 * backend reported `success: false`: none of them changed a file, and a list that
 * counted them would be claiming edits that never happened. That is the whole
 * risk of deriving, so it is what the fixture is built to catch.
 *
 * Against real conversation and thread models, with real Yjs items, because the
 * shapes this walks — a Y.Map result nested under `fullResult`, a `toolInput`
 * holding the file's entire contents — are exactly the shapes a hand-built fake
 * would get wrong in its own favour.
 *
 * Driven through a **probe item type** registered only here, the same way
 * `unit:pinboard-thread-source` does: a pin shipped in product code purely to be
 * measured would be a promise the app cannot keep.
 * @module unit-tests/pinboard-file-edits-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import '../../js/components/pinboard-content.js';

/** The context the probe was mounted with. */
const probe = { context: /** @type {any} */ (null) };

/** A pin type whose whole purpose is to hand back the context it was given. */
class EditProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'edit-probe',
    name: 'Edit probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
  };

  /**
   * @param {HTMLElement} container - The body region to fill.
   * @param {any} pinContext - The pin, the active snapshot and the host services.
   * @returns {{teardown: () => void}} The controller.
   */
  mount(container, pinContext) {
    probe.context = pinContext;
    container.textContent = 'edit probe';
    return { teardown: () => {} };
  }
}

/** The project this fixture pretends to be in. */
const PROJECT = '/tmp/pinboard-file-edits';

/**
 * Wait for something to become true, rather than for a length of time: a lane
 * shares one browser with every other, so a fixed delay is a coin toss.
 * @param {() => any} check - Returns something truthy once the wait is over.
 * @param {string|(() => string)} what - The complaint if it never happens.
 * @param {number} [timeout] - How long to give it.
 * @returns {Promise<any>} Whatever `check` returned.
 */
async function waitFor(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(typeof what === 'function' ? what() : what);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

/**
 * Let the board's coalescing wait come round twice — so a notification that was
 * going to arrive has, and a second one would have been seen too. Timed rather
 * than framed: the pool's window is hidden and may never be served a frame,
 * which is the whole reason the board's flush races a timer against one.
 * @returns {Promise<void>}
 */
function frames() {
  return new Promise((resolve) => { setTimeout(resolve, 260); });
}

/**
 * Wait until the conversation has stopped changing of its own accord. Earlier
 * cases write to the transcript, and the last of those writes settles some
 * milliseconds later — a real change, correctly delivered, which would be
 * counted against a burst it had nothing to do with.
 * @param {any} session - The session to watch.
 * @param {string} conversationId - The conversation being read.
 * @returns {Promise<void>}
 */
async function quiesce(session, conversationId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let stirred = false;
    const stop = session.subscribe((/** @type {any} */ e) => {
      if (e.data?.conversationId === conversationId) stirred = true;
    });
    await frames();
    stop();
    if (!stirred) return;
  }
  throw new Error('the conversation never settled');
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

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across suites, so start from a known registry and
  // hand back one with no probe types in it.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(EditProbePin, { extensionId: 'test' });
  probe.context = null;

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let content = null;
  /** @type {any} */
  let tab = null;

  /** Stamps rise so "newest first" has something to sort by. */
  let clock = 1;

  /**
   * Put one tool action on a thread, exactly as the worker leaves it.
   * @param {any} thread - The thread to append to.
   * @param {object} spec - What this action is.
   * @param {string} spec.tool - The tool name.
   * @param {string} [spec.path] - The `path` input, when it has one.
   * @param {string} [spec.filePath] - The `file_path` input, for the tools spelling it that way.
   * @param {string} [spec.state] - Its lifecycle state; 'completed' unless said otherwise.
   * @param {any} [spec.result] - The result blob; a successful one unless said otherwise.
   * @param {number} [spec.added] - Lines added, reported on the ops payload.
   * @param {number} [spec.removed] - Lines removed.
   * @param {boolean} [spec.dated] - False to leave it unstamped, as a just-inserted item is.
   * @returns {string} The action's item id.
   */
  function addAction(thread, spec) {
    const {
      tool, path, filePath, state = 'completed', added = 0, removed = 0, dated = true,
    } = spec;
    /** @type {any} */
    const input = {};
    if (path !== undefined) input.path = path;
    if (filePath !== undefined) input.file_path = filePath;
    // A write's input carries the whole file. It is here so the walk is measured
    // against the real shape, where reaching the filename through toJSON() would
    // copy every byte of it.
    input.content = 'x'.repeat(4096);

    const result = 'result' in spec ? spec.result : {
      isError: false,
      fullResult: { success: true, result: { path: path ?? filePath, linesAdded: added, linesRemoved: removed } },
    };

    const message = thread.appendToolAction({
      toolUseId: `tu_${clock}`,
      toolName: tool,
      toolInput: input,
      state,
      result,
    });

    // Find the Y.Map just appended so the stamp goes on the stored item.
    const items = thread.items;
    const ymap = items[items.length - 1];
    if (dated) {
      // Rising stamps, a second apart, so ordering is unambiguous.
      ymap.set('timestamp', new Date(1700000000000 + clock * 1000).toISOString());
    }
    clock++;
    return ymap.get('itemId') || message.itemId;
  }

  /**
   * The active-context snapshot the panel hands the content band.
   * @param {string|null} threadId - The thread being read, null for the root.
   * @returns {any} The snapshot.
   */
  const activeContext = (threadId) => ({
    project: { path: PROJECT, displayName: 'pinboard-file-edits' },
    conversation: { id: conversation.id, title: conversation.name },
    thread: { id: threadId },
  });

  /**
   * The service under test, as a pin receives it.
   * @returns {any} `services.fileEdits`.
   */
  const service = () => probe.context.services.fileEdits;

  /**
   * The edits for the mutation tools, which is what every case is asking about.
   * @param {object} [query] - Overrides.
   * @returns {any[]} The edits.
   */
  const edits = (query = {}) => service().list({ tools: ['write', 'edit'], ...query });

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);
    session.setConversationName(conversation.id, 'File edits');
    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;

    /** @type {string} */
    let subThread = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Change some files'));
      subThread = root.createSubThread({
        goal: 'Do the edits',
        initialItems: [createAssistantMessage('Editing.')],
      }).threadId;
    }, conversation._doc.authorId);

    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);
    content.setSession(session);
    content.setPin({ id: 'pin_probe', type: 'edit-probe', config: {} }, activeContext(null));
    await waitFor(() => probe.context, 'the probe pin never mounted');

    // --- what counts as an edit ---------------------------------------------

    await run('an empty transcript has changed nothing', () => {
      assert(edits().length === 0, `expected no edits, got ${JSON.stringify(edits())}`);
    });

    await run('a completed write is an edit, with its path made absolute', () => {
      addAction(root, { tool: 'write', path: 'web/js/app.js', added: 12, removed: 3 });
      const list = edits();
      assert(list.length === 1, `expected one edit, got ${JSON.stringify(list)}`);
      assert(list[0].path === `${PROJECT}/web/js/app.js`,
        `a relative tool path is resolved against the project; got ${list[0].path}`);
      assert(list[0].added === 12 && list[0].removed === 3,
        `the diffstat comes off the ops payload; got +${list[0].added} -${list[0].removed}`);
      assert(list[0].toolName === 'write', `expected the tool named; got ${list[0].toolName}`);
      assert(list[0].threadId === null, `a root-thread edit has no thread id; got ${list[0].threadId}`);
    });

    await run('an absolute tool path is left alone', () => {
      addAction(root, { tool: 'write', path: `${PROJECT}/absolute.js` });
      assert(edits().some((e) => e.path === `${PROJECT}/absolute.js`),
        `an absolute path must not be prefixed twice: ${JSON.stringify(edits().map((e) => e.path))}`);
    });

    await run('the edit tool spells its input file_path, and is read anyway', () => {
      addAction(root, { tool: 'edit', filePath: 'lib/thing.js' });
      assert(edits().some((e) => e.path === `${PROJECT}/lib/thing.js` && e.toolName === 'edit'),
        `expected the edit tool's file_path read; got ${JSON.stringify(edits().map((e) => e.path))}`);
    });

    await run('an edit inside a sub-thread says which thread it was', () => {
      const sub = conversation.resolveMessageThread(subThread);
      addAction(sub, { tool: 'write', path: 'in-sub.js' });
      const found = edits().find((e) => e.path.endsWith('in-sub.js'));
      assert(!!found, 'a sub-thread edit belongs to the conversation as much as a root one');
      assert(found.threadId === subThread,
        `expected the owning thread ${subThread}; got ${found.threadId}`);
    });

    // --- what is not an edit --------------------------------------------------

    await run('a tool still running has not changed anything yet', () => {
      const before = edits().length;
      addAction(root, { tool: 'write', path: 'in-flight.js', state: 'running', result: null });
      assert(edits().length === before,
        `an unfinished write is not an edit: ${JSON.stringify(edits().map((e) => e.path))}`);
    });

    await run('a cancelled tool never ran', () => {
      const before = edits().length;
      addAction(root, { tool: 'write', path: 'abandoned.js', state: 'cancelled' });
      assert(edits().length === before,
        `a cancelled write changed no file: ${JSON.stringify(edits().map((e) => e.path))}`);
    });

    await run('a failed tool changed nothing', () => {
      const before = edits().length;
      addAction(root, {
        tool: 'write',
        path: 'failed.js',
        result: { isError: true, fullResult: { success: false } },
      });
      assert(edits().length === before,
        `an errored write is not an edit: ${JSON.stringify(edits().map((e) => e.path))}`);
    });

    await run('a tool that completed but reported failure changed nothing', () => {
      const before = edits().length;
      addAction(root, {
        tool: 'write',
        path: 'unsuccessful.js',
        // The subtle one: no error flag, the action reached 'completed', and the
        // backend still says it did not do it.
        result: { isError: false, fullResult: { success: false, result: { path: 'unsuccessful.js' } } },
      });
      assert(edits().length === before,
        `success:false is a refusal, not an edit: ${JSON.stringify(edits().map((e) => e.path))}`);
    });

    await run('a result marked cancelled changed nothing', () => {
      const before = edits().length;
      addAction(root, {
        tool: 'write',
        path: 'raced.js',
        result: { isError: false, cancelled: true, fullResult: { success: true, result: {} } },
      });
      assert(edits().length === before,
        `a cancelled result is not an edit: ${JSON.stringify(edits().map((e) => e.path))}`);
    });

    await run('a tool nobody named is not counted, however successful', () => {
      addAction(root, { tool: 'read', path: 'only-read.js' });
      assert(!edits().some((e) => e.path.endsWith('only-read.js')),
        'reading a file is not changing it, and the caller did not ask about reads');
      // And the caller's list is what decides, not a hardcoded set: ask for
      // reads and the same action is there.
      assert(service().list({ tools: ['read'] }).some((/** @type {any} */ e) => e.path.endsWith('only-read.js')),
        'the tool names are the caller\'s to choose');
    });

    await run('an action with no path in its input is not a file edit', () => {
      const before = edits().length;
      addAction(root, { tool: 'write' });
      assert(edits().length === before,
        'without a path there is no file to claim was changed');
    });

    await run('an ordinary message is not an edit', () => {
      const before = edits().length;
      root.addEvent(createAssistantMessage('Just talking.'));
      assert(edits().length === before, 'only tool actions are edits');
    });

    // --- ordering and bounds --------------------------------------------------

    await run('the newest edit comes first', () => {
      const list = edits();
      const stamps = list.map((/** @type {any} */ e) => e.at);
      const sorted = [...stamps].sort((a, b) => b - a);
      assert(JSON.stringify(stamps) === JSON.stringify(sorted),
        `expected descending stamps, got ${JSON.stringify(stamps)}`);
    });

    await run('an edit the worker has not stamped yet sorts as the newest', () => {
      addAction(root, { tool: 'write', path: 'just-now.js', dated: false });
      const list = edits();
      assert(list[0].path.endsWith('just-now.js'),
        `an unstamped item is one that has only just happened, not one from 1970; got ${list[0].path}`);
    });

    await run('the limit takes the newest, not the first found', () => {
      const all = edits();
      const capped = edits({ limit: 2 });
      assert(capped.length === 2, `expected 2, got ${capped.length}`);
      assert(capped[0].itemId === all[0].itemId && capped[1].itemId === all[1].itemId,
        'a cap keeps the newest edits, since those are the ones anyone is looking for');
    });

    await run('asking for no tools asks nothing of the transcript', () => {
      assert(service().list({ tools: [] }).length === 0,
        'an empty tool list is a query for nothing, not a query for everything');
    });

    await run('a limit of zero returns nothing', () => {
      assert(edits({ limit: 0 }).length === 0, 'zero means zero');
    });

    // --- staying current ------------------------------------------------------

    await run('a change to the transcript reaches a watching pin', async () => {
      let fired = 0;
      const stop = service().onChange(() => { fired++; });
      addAction(root, { tool: 'write', path: 'watched.js' });
      await waitFor(() => fired > 0, 'writing a tool action must tell a watching pin');
      stop();

      const before = fired;
      addAction(root, { tool: 'write', path: 'after-stop.js' });
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert(fired === before, `unsubscribing must stop the notifications; ${before} → ${fired}`);
    });

    // --- what the pin is not told ---------------------------------------------

    // `conversation:changed` is emitted per applied Yjs transaction, so a turn
    // streaming anywhere in the session arrives at the sync rate — around a
    // hundred a second. A pin reads one conversation, and re-reading its whole
    // transcript because a different one moved is work with no possible result.
    await run("a change in another conversation is not this pin's news", async () => {
      await quiesce(session, conversation.id);
      let fired = 0;
      const stop = service().onChange(() => { fired++; });
      try {
        for (let i = 0; i < 50; i++) {
          session.notifyConversationChange('conversation:changed', { conversationId: 'conv_elsewhere' });
        }
        await frames();
        assert(fired === 0, `another conversation must not reach this pin; fired ${fired} times`);
      } finally {
        stop();
      }
    });

    // The same burst, this time about the conversation the pin is reading. Every
    // one of them is genuinely news — and every one says the same thing, so the
    // pin is told once and re-reads once.
    await run('a burst about this conversation is one piece of news', async () => {
      await quiesce(session, conversation.id);
      let fired = 0;
      const stop = service().onChange(() => { fired++; });
      try {
        for (let i = 0; i < 50; i++) {
          session.notifyConversationChange('conversation:changed', { conversationId: conversation.id });
        }
        await frames();
        assert(fired === 1, `50 transactions must coalesce into one re-read, got ${fired}`);
      } finally {
        stop();
      }
    });

    // Closing the board unmounts nothing: the panel is put away with a transform
    // and stays in the document. A pin that went on rebuilding there would be
    // drawing for nobody, at the streaming rate, for as long as it stayed shut.
    await run('a board nobody can see holds its news until it can be seen', async () => {
      await quiesce(session, conversation.id);
      let fired = 0;
      const stop = service().onChange(() => { fired++; });
      try {
        content.setVisible(false);
        for (let i = 0; i < 20; i++) {
          session.notifyConversationChange('conversation:changed', { conversationId: conversation.id });
        }
        await frames();
        assert(fired === 0, `a board nobody can see must not render; fired ${fired} times`);

        content.setVisible(true);
        await frames();
        assert(fired === 1, `and must be told, once, on the way back; got ${fired}`);
      } finally {
        stop();
        content.setVisible(true);
      }
    });

    // --- pointing back at the conversation ------------------------------------

    await run('revealing an edit selects the action that made it', async () => {
      tab = /** @type {any} */ (document.createElement('conversation-tab'));
      container.appendChild(tab);
      tab.setConversation(conversation);
      tab.setActive();
      await waitFor(() => tab.querySelector('conversation-area'), 'the tab never built a column');

      const sub = conversation.resolveMessageThread(subThread);
      const deep = addAction(sub, { tool: 'write', path: 'reveal-me.js' });
      service().reveal(deep);

      await waitFor(
        () => tab._selection.selections.includes(deep),
        () => 'revealing an item must select it; the chain is ' +
          JSON.stringify(tab._selection.selections)
      );
      // It lives inside a sub-thread, so reaching it had to open that thread's
      // column: the chain is the thread and then the item, not the item alone.
      assert(tab._selection.selections[0] === subThread,
        `expected the sub-thread opened first; chain is ${JSON.stringify(tab._selection.selections)}`);
      assert(tab._selection.activeColumnIndex === tab._selection.selections.length - 1,
        'the active column is the one holding the item, not one beyond it');
    });

    await run('revealing something that is not there does nothing', () => {
      const chain = JSON.stringify(tab._selection.selections);
      service().reveal('item_that_does_not_exist');
      assert(JSON.stringify(tab._selection.selections) === chain,
        'an unknown item must leave the reader where they were');
    });

    // --- the pin gets a copy, not the model -----------------------------------

    await run('an edit is a snapshot the pin cannot write back through', () => {
      const list = edits();
      list[0].path = '/tampered';
      assert(edits()[0].path !== '/tampered',
        'a pin holding the list must not be holding the conversation');
    });

    await run('the whole file content never leaves the model', () => {
      const list = edits();
      const serialised = JSON.stringify(list);
      assert(!serialised.includes('xxxxxxxxxx'),
        'the projection must not carry the file contents the tool input holds');
    });
  } finally {
    tab?.remove();
    content?.remove();
    container.remove();
    pinboardItemRegistry.reset();
    probe.context = null;
  }

  return { passed, failed, errors };
}
