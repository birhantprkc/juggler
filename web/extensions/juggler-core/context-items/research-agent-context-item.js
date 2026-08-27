//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import SubagentContextItem from './subagents/subagent-item.js';
import ResearchSubagentStrategyType from './subagents/research-strategy.js';

/**
 * ResearchAgentContextItem - the `Research` sub-agent.
 *
 * Every call delegates: the question is answered by a child thread under a
 * hidden strategy this item owns (search + fetch, plus read-only local lookups),
 * and only its answer comes back. The multi-source loop — search, read five
 * pages, reconcile them against the version actually installed — is where a
 * caller's context normally dies; here it dies in the child instead.
 *
 * The mechanics are {@link SubagentContextItem}'s; what is Research rather than
 * Explore is the descriptor below.
 * @class
 * @augments SubagentContextItem
 */
class ResearchAgentContextItem extends SubagentContextItem {
  static MANIFEST = {
    id: 'research-agent',
    name: 'Research',
    version: '1.0.0',
    description: 'Answer a question from the web in a sub-agent context',
    author: 'Juggler Team',
    requiresApproval: false,
    // Always delegates: buildSubthreadSpec never returns null, and there is no
    // inline Research — so requiresDelegation lets the worker withhold the tool
    // on turns that cannot delegate, leaving the inherited execute() reachable
    // only when the engine round-trip itself fails.
    delegatesToSubthread: true,
    requiresDelegation: true,
    // The child reads the web and reports back; its strategy admits nothing that
    // touches the working tree. So two Research runs may go at once.
    readOnlySubthread: true
  };

  /** @type {import('./subagents/subagent-item.js').SubagentDescriptor} */
  static SUBAGENT = {
    tool: 'Research',
    strategy: ResearchSubagentStrategyType,
    badge: { color: 'thread', icon: 'icon-search' },
    description:
      'Answer a question from the web in a sub-agent context and get back only the answer. ' +
      'The sub-agent searches, reads as many pages as it needs, and checks what they say against the version actually installed in this project; none of those pages enter this conversation.\n' +
      'Use it when the answer takes several sources — API behaviour, what changed between versions, how a library is meant to be used. ' +
      'For one page you already know the URL of, `WebFetch` with a `prompt` is cheaper. Use `Explore` instead for questions about this codebase.',
    goalExample: 'Check React 20 changes',
    task:
      'What to find out, stated in full — including the library, version, or platform it concerns. ' +
      'The sub-agent shares your project but none of your conversation.',
    continues: 'research',
    lead: 'Answer the following question thoroughly.',
    resultSpec:
      'the answer, with a source URL for each claim, and a note of anything that differs from ' +
      'the version installed in this project. Where you found nothing, say so explicitly rather than offering a plausible guess.',
    verbs: { pending: 'Researching…', done: 'Researched' },
    fallback: 'Search the web directly with WebSearch and WebFetch.'
  };
}

export default ResearchAgentContextItem;
