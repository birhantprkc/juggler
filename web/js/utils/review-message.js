//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A review draft written out as the message it is sent as.
 *
 * Kept apart from `utils/review-draft.js` — the record's own module — because
 * this half reaches into the extension SDK for {@link formatCodeReference}, and
 * through it into markdown and syntax highlighting. The model layer is loaded in
 * realms with no interest in any of that, and the shape of a stored comment is
 * no place to drag them.
 *
 * The format itself is the SDK's, unchanged: a review is blocks of "this code,
 * here", which is the one way this product says that, and the way the default
 * system prompt already asks the agent to say it back.
 * @module utils/review-message
 */

import { formatCodeReference } from '../../sdk/lib/context-item-utils.js';
import { normalizeReviewDraft } from './review-draft.js';

/** What the message announces itself as. */
const REVIEW_HEADER = 'Review feedback:';

/**
 * Where a comment sorts among the comments on the same file. A comment about the
 * file as a whole is about all of it, so it goes above the lines; of the two
 * sides, the old one is what the reader read first.
 * @param {string} side - The comment's side.
 * @returns {number} Its rank.
 */
function sideRank(side) {
  if (side === 'file') return 0;
  return side === 'old' ? 1 : 2;
}

/**
 * Order two comments: repository, then file, then side, then line.
 *
 * Deterministic ordering is what makes the format testable at all — an unchanged
 * draft has to write a byte-identical message twice. Comments that tie on all
 * four keep the order they are shown in, which `Array.prototype.sort` being
 * stable takes care of.
 * @param {import('./review-draft.js').ReviewComment} a - One comment.
 * @param {import('./review-draft.js').ReviewComment} b - The other.
 * @returns {number} The usual -1/0/1.
 */
function compareComments(a, b) {
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  const sides = sideRank(a.side) - sideRank(b.side);
  if (sides !== 0) return sides;
  return (a.startLine ?? 0) - (b.startLine ?? 0);
}

/**
 * One review as one message: a header, then a reference block per comment.
 *
 * The blocks are the SDK's own, so a review comment and a selection quoted out
 * of a file arrive looking identical. Nothing here is hidden and nothing is
 * parsed back — the reviewer may edit the message before it goes.
 * @param {any} draft - The review to write out, in whatever state it is stored.
 * @returns {string} The message, or '' when there is nothing to say.
 */
export function formatReviewMessage(draft) {
  const comments = normalizeReviewDraft(draft).comments.sort(compareComments);
  if (!comments.length) return '';

  const blocks = comments.map((comment) => formatCodeReference({
    // The repository a comment belongs to is part of where the file is: two
    // `src/main.go` in two nested repositories are two different files, and a
    // reference that dropped the prefix would name neither of them.
    path: comment.repo ? `${comment.repo}/${comment.path}` : comment.path,
    startLine: comment.startLine,
    endLine: comment.endLine,
    // 'file' is not a side of a diff, it is the absence of one, and the block
    // format says so by saying nothing.
    side: comment.side === 'file' ? undefined : comment.side,
    lines: comment.lineText,
    body: comment.body,
  }));

  return [REVIEW_HEADER, ...blocks].join('\n\n');
}
