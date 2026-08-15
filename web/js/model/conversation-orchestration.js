//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy/LLM orchestration entry points for a Conversation. Free functions
 * taking the conversation as their first arg so `Conversation` itself stays
 * focused on Yjs document ownership and state accessors; orchestration is its
 * own concern.
 *
 * Public Conversation methods delegate here so external callers
 * (`conversation.continueThread(...)`) are unchanged.
 * @module model/conversation-orchestration
 */

import workerManager from '../services/worker-manager.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * Wait for user to approve/deny a tool use.
 * @param {import('./conversation.js').default} conversation
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @returns {Promise<string>} 'yes', 'no', 'yes-always', or 'cancel'
 */
export async function waitForApproval(conversation, messageThread, toolUseId) {
  if (conversation._autoApprove) return 'yes';

  while (true) {
    const message = messageThread.getToolAction(toolUseId);

    if (!message) return 'cancel';

    if (message.get('state') !== TOOL_STATES.PENDING && messageThread.hasToolResult(toolUseId)) {
      const response = message.get('approvalResponse');
      if (response) return response;
      if (message.get('state') === TOOL_STATES.RUNNING || message.get('state') === TOOL_STATES.COMPLETED) return 'yes';
      return 'cancel';
    }

    await conversation._waitForStateChange();
  }
}

/**
 * Continue the conversation without a user message.
 * @param {import('./conversation.js').default} conversation
 * @param {import('./message-thread.js').default} messageThread
 */
export async function continueThread(conversation, messageThread) {
  const { default: actionExecutor } = await import('../services/action-executor.js');

  if (conversation.isProcessing || actionExecutor.hasRunningActions() || messageThread.hasBusyItems()) {
    return;
  }

  messageThread.cancelPendingApprovals();

  if (conversation._conversationArea) {
    conversation._conversationArea.scrollToBottom(true);
  }

  if (workerManager.isWorkerReady(conversation.id)) {
    workerManager.continue(conversation.id, messageThread.threadItemId);
    return;
  }

  // Turns are driven exclusively by the Go worker; there is no viewer-side loop.
  // If the worker isn't up yet (still starting, or spawn failed), refuse rather
  // than running anything on the main thread.
  conversation.showWarning('Still connecting to the engine — try again in a moment.', 5000);
}
