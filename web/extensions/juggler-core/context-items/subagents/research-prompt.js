//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { subagentBrief } from './subagent-brief.js';

/**
 * The Research sub-agent's brief, injected as durable guidance when its strategy
 * activates. Its own module so the strategy file stays about behaviour and this
 * text can be read (and edited) as prose. Only the rules peculiar to Research are
 * here; {@link subagentBrief} adds the contract every sub-agent works under.
 * @type {string}
 */
export const RESEARCH_GUIDANCE = subagentBrief({
  label: 'RESEARCH',
  scope: 'from the open web',
  rules: [
    'Read more than one source. A single page is a claim; agreement across '
    + 'sources, or the primary docs, is evidence.',
    'Check what is actually installed here before answering. You have `read`, '
    + '`grep` and `glob` for exactly that — lockfiles, manifests, vendored '
    + 'source. Advice for the wrong version is worse than no advice.',
    'Cite a URL for every claim you make.',
    'You have no shell and can change nothing: this is a reading job.'
  ]
});
