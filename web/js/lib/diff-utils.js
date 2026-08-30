//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/** @typedef {import('./diff-types.js').DiffLine} DiffLine */
/** @typedef {import('./diff-types.js').DiffHunk} DiffHunk */

/**
 * Build a line-level diff using a simple LCS algorithm.
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [startLineNumber=1]
 * @returns {DiffLine[]} An array of DiffLine objects representing the line-level differences.
 */
function buildDiffLines(oldText, newText, startLineNumber = 1) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  // DP table for LCS lengths
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const dpi = /** @type {number[]} */ (dp[i]); // bounded: dp has m+1 rows
    const dpi1 = /** @type {number[]} */ (dp[i + 1]);
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dpi[j] = (dpi1[j + 1] ?? 0) + 1;
      else dpi[j] = Math.max(dpi1[j] ?? 0, dpi[j + 1] ?? 0);
    }
  }

  /** @type {DiffLine[]} */
  const out = [];
  let i = 0, j = 0;
  let oldLineNum = startLineNumber;
  let newLineNum = startLineNumber;

  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      out.push(/** @type {DiffLine} */ ({ type: 'equal', content: /** @type {string} */ (oldLines[i]), oldLineNum, newLineNum }));
      i++; j++; oldLineNum++; newLineNum++;
    } else if (i < m && (j === n || (dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0))) {
      // Prefer emitting the removal on a tie so that within a modified block
      // the '-' line precedes the '+' line, matching POSIX unified diff order.
      out.push(/** @type {DiffLine} */ ({ type: 'remove', content: /** @type {string} */ (oldLines[i]), oldLineNum, newLineNum: null }));
      i++; oldLineNum++;
    } else {
      out.push(/** @type {DiffLine} */ ({ type: 'add', content: /** @type {string} */ (newLines[j]), oldLineNum: null, newLineNum }));
      j++; newLineNum++;
    }
  }

  return out;
}

/**
 * Group diff lines into hunks with context.
 * @param {DiffLine[]} lines
 * @param {number} [startLineNumber=1]
 * @param {number} [contextLines=3]
 * @returns {DiffHunk[]} An array of DiffHunk objects, where each hunk represents a contiguous block of changes.
 */
function groupIntoHunks(lines, startLineNumber = 1, contextLines = 3) {
  if (!lines || lines.length === 0) return [];

  const hasChanges = lines.some(l => l.type !== 'equal');
  if (!hasChanges) {
    const first = /** @type {DiffLine} */ (lines[0]); // bounded: length > 0 checked above
    return [/** @type {DiffHunk} */ ({
      oldStart: /** @type {number} */ (first.oldLineNum || startLineNumber),
      oldCount: lines.length,
      newStart: /** @type {number} */ (first.newLineNum || startLineNumber),
      newCount: lines.length,
      lines: [...lines]
    })];
  }

  /** @type {DiffHunk[]} */
  const hunks = [];
  let currentHunk = null;
  /** @type {DiffLine[]} */
  let contextBuffer = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = /** @type {DiffLine} */ (lines[idx]); // bounded by idx < lines.length

    if (line.type === 'equal') {
      if (currentHunk) {
        contextBuffer.push(line);

        if (contextBuffer.length >= contextLines) {
          // Another change close behind keeps the hunk open, so the lines
          // between the two changes stay in it as interior context.
          let hasMore = false;
          for (let k = idx + 1; k < Math.min(idx + contextLines * 2 + 1, lines.length); k++) {
            if (/** @type {DiffLine} */ (lines[k]).type !== 'equal') { hasMore = true; break; }
          }

          if (!hasMore) {
            const ctx = contextBuffer.slice(0, contextLines);
            currentHunk.lines.push(...ctx);
            finalizeHunkStarts(currentHunk, startLineNumber);
            hunks.push(currentHunk);
            currentHunk = null;
            contextBuffer = [];
          } else {
            currentHunk.lines.push(...contextBuffer);
            contextBuffer = [];
          }
        }
      } else {
        contextBuffer.push(line);
        if (contextBuffer.length > contextLines) contextBuffer.shift();
      }
    } else {
      if (!currentHunk) {
        currentHunk = /** @type {DiffHunk} */ ({ oldStart: startLineNumber, oldCount: 0, newStart: startLineNumber, newCount: 0, lines: [...contextBuffer] });
      } else {
        // Context held back as a possible hunk tail turned out to be interior:
        // it must land ahead of this change, not after it.
        currentHunk.lines.push(...contextBuffer);
      }
      contextBuffer = [];
      currentHunk.lines.push(line);
    }
  }

  if (currentHunk) {
    // Whatever context is left at end of input is this hunk's tail.
    if (contextBuffer.length > 0) currentHunk.lines.push(...contextBuffer.slice(0, contextLines));
    finalizeHunkStarts(currentHunk, startLineNumber);
    hunks.push(currentHunk);
  }

  for (const h of hunks) {
    h.oldCount = 0; h.newCount = 0;
    for (const l of h.lines) {
      if (l.type === 'remove' || l.type === 'equal') h.oldCount++;
      if (l.type === 'add' || l.type === 'equal') h.newCount++;
    }
  }

  return hunks;
}

/**
 * Calculates and sets the correct start line numbers for a diff hunk.
 * @param {DiffHunk} hunk - The diff hunk to finalize.
 * @param {number} fallbackStart - The fallback start line number if no old/new lines are found.
 */
function finalizeHunkStarts(hunk, fallbackStart) {
  const firstOld = hunk.lines.find(l => l.oldLineNum !== null);
  const firstNew = hunk.lines.find(l => l.newLineNum !== null);
  hunk.oldStart = (firstOld && firstOld.oldLineNum !== null) ? /** @type {number} */ (firstOld.oldLineNum) : fallbackStart;
  hunk.newStart = (firstNew && firstNew.newLineNum !== null) ? /** @type {number} */ (firstNew.newLineNum) : fallbackStart;
}

/**
 * Computes the diff between two texts and groups them into hunks.
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [startLineNumber=1]
 * @param {number} [contextLines=3]
 * @returns {DiffHunk[]} An array of DiffHunk objects representing the grouped changes with context.
 */
export function computeDiff(oldText, newText, startLineNumber = 1, contextLines = 3) {
  const diffLines = buildDiffLines(oldText, newText, startLineNumber);
  const hunks = groupIntoHunks(diffLines, startLineNumber, contextLines);
  return hunks;
}
