//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The `execute` permission domain, shared by every plugin that runs a shell
 * command (the bash tool and the Monitor tool). Both ask the same two
 * questions of the same conversation state, so both ask them here rather than
 * hand-copying the wiring: which grants apply, and does the static analyser in
 * `./command-approval.js` accept the command under them.
 * @module juggler-core/context-items/execute/command-permission
 */

import { isCommandAutoApproved, isCatastrophicDeletion } from './command-approval.js';

/**
 * Is this shell command already permitted by the conversation's `execute`
 * rules? Pulls the user's enabled `glob` rules plus the conversation's
 * allowed-paths list and defers to the static analyser.
 * @param {string} command - The shell command to judge
 * @param {object} opts - Conversation state
 * @param {any} opts.messageThread - Owning message thread (source of rules + allowed paths)
 * @param {any} opts.session - Owning session (platform + home)
 * @param {boolean} [opts.writeEnabled] - Whether file-writing is auto-approved,
 *   which lets a redirect into an allowed path be stripped as a permitted
 *   output destination. Monitor never enables it: it only tails output.
 * @returns {boolean} True when the command auto-approves
 */
export function isShellCommandPermitted(command, { messageThread, session, writeEnabled = false }) {
  if (!command || !messageThread) return false;
  const patterns = messageThread.getRulesFor('execute')
    .filter((/** @type {any} */ r) => r.kind === 'glob')
    .map((/** @type {any} */ r) => /** @type {string} */ (r.value));
  return isCommandAutoApproved(command, {
    platform: session?.platform || 'darwin',
    home: session?.home || '',
    allowedRoots: messageThread.getAllowedPaths(),
    // The server runs every shell command at the project root (the bash op's
    // scope root), so that is the directory a relative path — and a leading
    // `cd` — is judged against.
    cwd: session?.projectPath || '',
    patterns,
    writeEnabled
  });
}

/**
 * Is this a recursive/forced delete of a catastrophic radius — the project
 * root, an ancestor of it, the home dir, or a filesystem root? Such a command
 * must never be silently auto-approved: not by the conversation auto-approve
 * toggle and not by a strategy's out-of-band reviewer. Every other command —
 * including a routine `rm -rf ./build` — stays auto-approvable.
 * @param {string} command - The shell command to judge
 * @param {any} session - Owning session (platform, home, project path)
 * @returns {boolean} True only for a catastrophic-radius recursive delete
 */
export function isShellCommandCatastrophic(command, session) {
  if (!command) return false;
  return isCatastrophicDeletion(command, {
    platform: session?.platform || 'darwin',
    home: session?.home || '',
    projectRoot: session?.projectPath || ''
  });
}
