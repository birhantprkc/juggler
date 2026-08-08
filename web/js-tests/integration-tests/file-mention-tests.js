//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: @ File Mention
 *
 * Tests that selecting a file via the at-sign completion menu immediately adds a
 * file-content context item and removes the typed path text from the textarea.
 * @module integration-tests/file-mention-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const atMentionAddsFileContentItem = {
  name: 'at-mention-adds-file-content-item',
  description: 'Selecting a file via @ completion adds a file-content context item and strips @path from message',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('I can see the file content.')
  ],

  operations: [
    { type: 'at-mention-file', path: 'src/main.go' },
    { type: 'send-message', message: '@src/main.go explain this file' },
    { type: 'validate-context-snapshot', expectedContent: ['Hello, World!'] }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'file-content', itemId: '$ITEM_2' },
      { type: 'user', content: '@src/main.go explain this file' },
      { type: 'assistant', content: 'I can see the file content.' }
    ]
  },

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    if (fileItems.length === 0) {
      throw new Error('Expected a file-content context item but none found');
    }
    const fileItem = /** @type {any} */ (fileItems[0]);
    if (fileItem.data.path !== 'src/main.go') {
      throw new Error(`Expected file path "src/main.go", got "${fileItem.data.path}"`);
    }
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const atMentionDeduplicates = {
  name: 'at-mention-deduplicates',
  description: 'Selecting the same file twice via @ results in only one file-content context item',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Got it.')
  ],

  operations: [
    { type: 'at-mention-file', path: 'src/main.go' },
    { type: 'at-mention-file', path: 'src/main.go' },
    { type: 'send-message', message: '@src/main.go @src/main.go look at this' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'file-content', itemId: '$ITEM_2' },
      { type: 'user', content: '@src/main.go @src/main.go look at this' },
      { type: 'assistant', content: 'Got it.' }
    ]
  },

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    if (fileItems.length !== 1) {
      throw new Error(`Expected exactly 1 file-content item but found ${fileItems.length}`);
    }
  }
};

// On send, every at-mention in the message text should be parsed and turned
// into a file-content context item. Covers multiple paths, a quoted path
// containing spaces, a backslash-escaped space, and trailing punctuation
// that should be stripped from the path.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
export const sendMessageCreatesFileItemsForAllMentions = {
  name: 'send-message-creates-file-items-for-all-mentions',
  description: 'Sending a message containing multiple @-mentions (quoted, escaped, and plain) creates a file-content item for each path',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Looked at all of those.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'Please review @src/main.go and @"docs/notes with spaces.md" plus @docs/notes\\ with\\ spaces.md and @README.md.'
    }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    const paths = /** @type {any[]} */ (fileItems).map(f => f.data.path).sort();

    // 'docs/notes with spaces.md' appears twice in the message (quoted and
    // backslash-escaped) — mergeOrReplace dedupes by path, so we expect three
    // unique items: src/main.go, docs/notes with spaces.md, README.md.
    const expected = ['README.md', 'docs/notes with spaces.md', 'src/main.go'];
    const actual = JSON.stringify(paths);
    const want = JSON.stringify(expected);
    if (actual !== want) {
      throw new Error(`Expected file-content paths ${want} but got ${actual}`);
    }

    // Freeze-at-add: each pin snapshots its rendered content into Yjs (data.content)
    // when the mention is created, so a 'prefix'-positioned pin rides the cached
    // prefix instead of being re-read live every turn. Persisted keys are bounded
    // to {path, isDirectory, content}; content must be a non-empty snapshot.
    const allowed = new Set(['path', 'isDirectory', 'content']);
    for (const f of /** @type {any[]} */ (fileItems)) {
      const extra = Object.keys(f.data).filter(k => !allowed.has(k));
      if (extra.length > 0) {
        throw new Error(`file-content item for "${f.data.path}" persisted unexpected fields: ${extra.join(', ')}`);
      }
      if (typeof f.data.content !== 'string' || f.data.content.length === 0) {
        throw new Error(`file-content item for "${f.data.path}" is missing its frozen content snapshot`);
      }
    }
  }
};

// Trailing sentence punctuation after an unquoted path should be stripped so
// the path resolves correctly. A bare "@" with no path after it should be
// ignored entirely (no spurious empty-path file-content item).
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
export const sendMessageHandlesPunctuationAndBareAt = {
  name: 'send-message-handles-punctuation-and-bare-at',
  description: 'Trailing punctuation after @path is stripped; a bare @ with no following path is ignored',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Got it.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'See @src/main.go, then check @README.md! Also @ alone should not match.'
    }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    const paths = /** @type {any[]} */ (fileItems).map(f => f.data.path).sort();
    const expected = ['README.md', 'src/main.go'];
    if (JSON.stringify(paths) !== JSON.stringify(expected)) {
      throw new Error(`Expected paths ${JSON.stringify(expected)} but got ${JSON.stringify(paths)}`);
    }
  }
};

// A pinned file must:
//   (a) reach the LLM with the bytes captured when it was pinned, and
//   (b) persist that frozen snapshot in Yjs (data.content) so later turns re-use
//       it instead of re-reading the live file.
// Together these are the load-bearing invariants of the freeze-at-add pin model:
// the snapshot is what lets a 'prefix'-positioned pin ride the cached prefix and
// be paid for once, rather than being re-billed at the uncached tail every turn.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
export const pinFreezesSnapshotAtAdd = {
  name: 'pin-freezes-snapshot-at-add',
  description: 'A pinned file is snapshotted at add-time; the frozen content reaches the LLM and is persisted in Yjs',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Read it.')
  ],

  operations: [
    { type: 'at-mention-file', path: 'src/main.go' },
    { type: 'send-message', message: '@src/main.go look at this' },
    // The frozen snapshot's bytes must appear in the outgoing context.
    { type: 'validate-context-snapshot', expectedContent: ['Hello, World!'] }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    if (fileItems.length !== 1) {
      throw new Error(`Expected exactly 1 file-content item, got ${fileItems.length}`);
    }
    const data = /** @type {any} */ (fileItems[0]).data;

    if (data.path !== 'src/main.go') {
      throw new Error(`Expected path "src/main.go", got "${data.path}"`);
    }

    // Persisted keys are bounded to {path, isDirectory, content}.
    const allowedKeys = new Set(['path', 'isDirectory', 'content']);
    const extra = Object.keys(data).filter(k => !allowedKeys.has(k));
    if (extra.length > 0) {
      throw new Error(
        `Pin persisted unexpected fields beyond {path, isDirectory, content}: ${extra.join(', ')}`
      );
    }

    // The frozen snapshot IS persisted — its bytes ('Hello, World!' from the
    // fixture) must be present in data.content.
    if (typeof data.content !== 'string' || !data.content.includes('Hello, World!')) {
      throw new Error('Pin must persist the frozen content snapshot in Yjs data.content');
    }
  }
};

// A directory typed or pasted without its conventional trailing slash must still
// be fetched as a tree. The completion UI supplies a slash, but raw text (and
// absolute Finder paths) does not.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
export const sendMessageTreatsDirectoryMentionWithoutTrailingSlashAsFolder = {
  name: 'send-message-treats-directory-mention-without-trailing-slash-as-folder',
  description: 'A directory @-mention without trailing slash reaches the LLM as a directory listing',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Read the folder.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'Review @mentioned-directory please.'
    },
    { type: 'validate-context-snapshot', expectedContent: ['child.txt'] }
  ]
};

// Export all tests
export const tests = [
  atMentionAddsFileContentItem,
  atMentionDeduplicates,
  sendMessageCreatesFileItemsForAllMentions,
  sendMessageHandlesPunctuationAndBareAt,
  pinFreezesSnapshotAtAdd,
  sendMessageTreatsDirectoryMentionWithoutTrailingSlashAsFolder
];
