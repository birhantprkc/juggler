//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The part of a sub-agent's brief that is true of every sub-agent.
 *
 * Two facts hold whatever the sub-agent is for: its context is thrown away
 * except for the last message, and there is no human in its thread. Both change
 * how it should work, and neither is discoverable from inside the run — so they
 * are stated here once, and each sub-agent supplies only the rules that are
 * actually its own.
 * @module context-items/subagents/subagent-brief
 */

/**
 * Rules that close every brief, after the agent's own.
 *
 * The no-human rule is the counterpart of `SubagentStrategyType.onToolPending`:
 * a call needing approval is refused, not queued, so an agent that plans around
 * it wastes no turns discovering that. The honesty rule is there because a
 * sub-agent's answer arrives stripped of the evidence that would expose a guess
 * — the caller cannot see the pages or files it read, so an invented answer is
 * indistinguishable from a found one until it causes damage.
 * @type {readonly string[]}
 */
const UNIVERSAL_RULES = Object.freeze([
  'Nobody is watching this thread: a call that would need approval is refused '
  + 'automatically, so stay within what needs none.',
  'Say plainly what you looked for and could not find. An honest gap is worth '
  + 'more to the caller than a plausible guess.'
]);

/**
 * Build a sub-agent's brief: the shared contract, then its working rules.
 * @param {object} spec - The agent-specific parts
 * @param {string} spec.label - Agent name in caps, e.g. 'EXPLORE'
 * @param {string} spec.scope - Where its answers come from, completing "one self-contained question …" (e.g. 'about this codebase')
 * @param {readonly string[]} spec.rules - Working rules particular to this agent; the universal ones are appended
 * @returns {string} The brief, ready to inject as guidance
 */
export function subagentBrief({ label, scope, rules }) {
  const contract =
    `${label} SUB-AGENT: you are answering one self-contained question ${scope}, `
    + 'in a context of your own. What you read here never reaches the caller — '
    + 'only your last message does, so the answer has to stand alone.';

  const working = [...rules, ...UNIVERSAL_RULES].map(rule => `- ${rule}`).join('\n');

  return `${contract}\n\nWorking rules:\n${working}`;
}
