//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { subagentBrief } from './subagent-brief.js';

/**
 * The Explore sub-agent's brief, injected as durable guidance when its strategy
 * activates. Its own module so the strategy file stays about behaviour and this
 * text can be read (and edited) as prose. Only the rules peculiar to Explore are
 * here; {@link subagentBrief} adds the contract every sub-agent works under.
 * @type {string}
 */
export const EXPLORE_GUIDANCE = subagentBrief({
  label: 'EXPLORE',
  scope: 'about this codebase',
  rules: [
    'Search the code, do not guess. Ground every claim in a file and line you '
    + 'actually read.',
    'You have the read tools and `bash` for inspection (`git log`, `git blame`). '
    + 'You cannot edit anything, and you have no network access.',
    'Prefer `query_code` when the answer is computable in one pass, and '
    + '`batch_read` / `batch_grep` over many single calls.'
  ]
});
