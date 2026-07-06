//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared diff JSDoc typedefs used by both UI and tests.
 * Import this module (side-effect) to make the typedefs available to checkJs.
 */

/**
 * @typedef {{start: number, length: number, type: 'add'|'remove'}} CharChange
 */

/**
 * @typedef {{
 *   type: 'add'|'remove'|'equal',
 *   content: string,
 *   oldLineNum: number|null,
 *   newLineNum: number|null,
 *   charChanges?: CharChange[]
 * }} DiffLine
 */

/**
 * @typedef {{
 *   oldStart: number,
 *   oldCount: number,
 *   newStart: number,
 *   newCount: number,
 *   lines: DiffLine[]
 * }} DiffHunk
 */

// no runtime exports; file is imported for typedefs only
export default {};
