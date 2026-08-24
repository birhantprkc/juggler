//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import SubagentContextItem from './subagents/subagent-item.js';
import ExploreSubagentStrategyType from './subagents/explore-strategy.js';

/**
 * ExploreAgentContextItem - the `Explore` sub-agent.
 *
 * Every call delegates: the investigation runs as a child thread under a hidden
 * strategy this item owns (read tools + `bash`, no network, no writes), and only
 * the child's final answer comes back as the tool result. The dozen greps and
 * file reads it took never enter the caller's context, which is the whole point
 * — an open question like "how does auth work here" costs the caller one tool
 * result instead of thirty.
 *
 * The mechanics are {@link SubagentContextItem}'s; what is Explore rather than
 * Research is the descriptor below.
 * @class
 * @augments SubagentContextItem
 */
class ExploreAgentContextItem extends SubagentContextItem {
  static MANIFEST = {
    id: 'explore-agent',
    name: 'Explore',
    version: '1.0.0',
    description: 'Investigate this codebase in a sub-agent context',
    author: 'Juggler Team',
    requiresApproval: false,
    // Always delegates: buildSubthreadSpec never returns null, and there is no
    // inline Explore — so requiresDelegation lets the worker withhold the tool
    // on turns that cannot delegate, leaving the inherited execute() reachable
    // only when the engine round-trip itself fails.
    delegatesToSubthread: true,
    requiresDelegation: true
  };

  /** @type {import('./subagents/subagent-item.js').SubagentDescriptor} */
  static SUBAGENT = {
    tool: 'Explore',
    strategy: ExploreSubagentStrategyType,
    badge: { color: 'thread', icon: 'icon-grep' },
    description:
      'Investigate this codebase in a sub-agent context and get back only what it found. ' +
      'The sub-agent searches and reads with its own read-only tools; the files it opens never enter this conversation, so an open-ended question costs you one result instead of thirty tool calls.\n' +
      'Use it for questions that need reading and judgment — "how does auth work here", "what calls this and why", "where would a new X go". ' +
      'Use `query_code` instead when the answer is one you can compute in a script and want exactly; use `Research` instead when the answer is on the web (Explore has no network access).',
    goalExample: 'Trace auth flow',
    task:
      'What to find out, stated in full. The sub-agent shares your project but none of your conversation, ' +
      'so name the files, symbols, or behaviour you mean rather than referring to what was said here.',
    continues: 'investigation',
    lead: 'Investigate this codebase and answer the following.',
    resultSpec:
      'the answer to the task; the evidence as a list of `file:line — what is there`; ' +
      'and the paths worth reading next. Say what you looked for and did not find rather than guessing.',
    verbs: { pending: 'Exploring…', done: 'Explored' },
    fallback: 'Search the code directly with grep, glob and read.'
  };
}

export default ExploreAgentContextItem;
