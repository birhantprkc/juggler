//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Static auto-approval analysis for shell commands.
 *
 * Decides whether a command is safe to run without prompting the user. The
 * decision is purely static — no filesystem syscalls, no execution. The
 * tokenizer is POSIX-shaped (sh / bash / zsh syntax); Windows is handled by
 * a shape-check that opts in for WSL- and git-bash-style commands and bails
 * on native cmd.exe / PowerShell.
 *
 * Pipeline:
 *   1. Tokenize. Bail on backticks, bare `$`/expansions, an unterminated
 *      heredoc, or unmatched quotes. An unquoted top-level newline is a
 *      sequential command separator (like `;`); a backslash-newline is a line
 *      continuation that joins the two lines. A terminated heredoc
 *      (`cmd <<DELIM … DELIM`) is stripped as an inert input redirect — the
 *      body is stdin data, so the command is judged by its words alone.
 *   2. On `platform === 'windows'`, require POSIX shape (no `\` paths,
 *      no `%VAR%`, no native cmd/PowerShell tokens, no standalone `&`).
 *   3. Repeatedly strip trailing read-only sinks: ` 2>&1`, ` >/dev/null`,
 *      ` 2>/dev/null`, ` >>/dev/null`, ` | <safe-sink>` where `<safe-sink>`
 *      is `cat`, `tail`, `head`, or `wc` with whitelisted args — or `tee`,
 *      whose file operands (write targets) are gated exactly like a write
 *      redirect (writeEnabled + inside an allowed path).
 *   4. Strip a leading `cd <path-inside-project> &&` if present.
 *   5. Split on top-level `&&`, `||`, `;` (not splitting inside `( … )` /
 *      `{ …; }` groups). Every sub-segment must be safe; a grouped segment is
 *      safe iff its interior — validated recursively as its own command
 *      sequence — is safe.
 *      Precedence-safe: every piece is validated independently, so no
 *      precedence quirk can let an unsafe piece through.
 *   6. A segment is safe iff (after stripping its own trailing sinks) it
 *      contains NO remaining operator tokens AND its head command is in
 *      the {@link COMMAND_HANDLERS} registry with arguments accepted by
 *      that handler — OR it matches one of the user's enabled glob
 *      patterns.
 *
 * SECURITY: write/append redirects (`>`, `>>`, `2>`) are stripped only when the
 * target is `/dev/null`, or — when file-writing is enabled for the conversation
 * (`writeEnabled`) — when the target resolves inside an allowed path. Any other
 * target leaves an op token in the segment, which triggers rejection. Stripping
 * a redirect only removes an output destination the LLM is already permitted to
 * write; the command words are still validated independently, so it can never
 * approve a command that would otherwise be rejected. A terminated heredoc
 * (`<<`) is stripped at tokenize time as an inert input redirect (its body is
 * stdin data); an unterminated one bails. Command substitution (`$(`,
 * backticks) and variable expansion (`$`) are rejected at tokenize time.
 *
 * Each builtin command has its own handler class (see {@link CommandHandler}).
 * Tiny by design — each handler owns the policy for one command, so adding
 * a new command means adding a class, not extending a god function.
 * @module model/command-approval
 */

import {
  posixNormalize,
  isPathInsideAllowedRoots,
  canonicalRoot,
  isGrantableRoot,
} from 'juggler/utils/path-containment';

// The path-containment helpers used to live in this file; they now live in the
// shared SDK module above so the file write/edit tools enforce containment with
// the exact same logic. Re-export the ones that were historically public here
// (bash-command-approval-unit-test.js and plugin code import them from this
// module) so those callers keep resolving.
export { posixNormalize, isPathInsideAllowedRoots, canonicalRoot, isGrantableRoot };

/**
 * @typedef {{type: 'word', text: string, raw: string, start: number, end: number, subst?: string[], unquotedVar?: boolean}} WordToken
 * @typedef {{type: 'op', text: string, start: number, end: number}} OpToken
 * @typedef {WordToken | OpToken} ShellToken
 * @typedef {{platform: string, allowedRoots: string[], home?: string, patterns?: string[], writeEnabled?: boolean, vars?: Map<string, VarProvenance>}} ApprovalCtx
 * @typedef {{kind: 'literal', value: string} | {kind: 'inProjectPath'}} VarProvenance
 */

/**
 * Typed indexed access for bounds-checked array reads. Runtime behavior is the
 * same as `arr[i]`; the cast records the local invariant for the JS checker.
 * @template T
 * @param {ArrayLike<T>} arr array-like value
 * @param {number} i index
 * @returns {T} item
 */
function checkedAt(arr, i) { return /** @type {T} */ (arr[i]); }

/**
 * Operators recognised at top level. Longer matches first so `&&` wins over
 * `&`, `||` over `|`, `2>&1` over `2>`, etc. Subshell-grouping parens `(` / `)`
 * are control operators too: as bare tokens they can only mean subshell
 * grouping (a literal paren in an argument arrives quoted or backslash-escaped,
 * so it's consumed as word text before the operator scan). Tokenising them as
 * ops lets the segment walker treat `( … )` as a group and validate its
 * interior recursively — so `(echo x)` is approved exactly when `echo x` is,
 * and `(echo x; rm y)` is rejected because `rm y` is. Brace groups `{ …; }`
 * use the reserved words `{` / `}`, which arrive as ordinary word tokens.
 */
const SHELL_OPERATORS = [
  '2>&1', '2>>', '||', '&&', ';;', '|&', '<&', '>&', '>>', '<<', '2>',
  ';', '|', '<', '>', '&', '(', ')'
];

/** Operators that split commands at top level. */
const TOP_LEVEL_SPLIT_OPS = new Set(['&&', '||', ';']);

/** Native Windows shell tokens we refuse outright. */
const WINDOWS_NATIVE_TOKENS = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'dir', 'copy', 'move', 'del', 'erase', 'rd', 'rmdir', 'md', 'mkdir',
  'cls', 'ren', 'rename', 'where',
  'wscript', 'wscript.exe', 'cscript', 'cscript.exe'
]);

// ============================================================================
// Tokenizer
// ============================================================================

/**
 * Placeholder a command substitution `$(…)` leaves in a word token's `text`.
 * The raw inner command is captured on the token's `subst` array instead. The
 * sentinel embeds NUL bytes so it can never match a real path, flag, or command
 * name — every downstream check that sees it fails closed. The ONLY code that
 * treats a `subst` token as anything but unsafe is the pure-assignment path
 * (`NAME=$(…)`), which independently re-validates the inner command.
 */
const SUBST_SENTINEL = '\u0000SUBST\u0000';

/**
 * Scan a `$(…)` command substitution starting at `checkedAt(input, i)` (`checkedAt(input, i)` is `$`,
 * `input[i+1]` is `(`). Returns the inner command text and the index just past
 * the closing `)`, tracking paren depth across nested `$(…)`, single/double
 * quotes, and backslash escapes. Bails (returns null) on backticks or an
 * unterminated substitution — anything we can't bound precisely.
 * @param {string} input full command string
 * @param {number} i index of the `$`
 * @returns {{inner: string, end: number} | null} inner text + end index, or null
 */
function scanCommandSubst(input, i) {
  let j = i + 2;
  let depth = 1;
  while (j < input.length) {
    const c = input[j];
    if (c === '`') return null;
    if (c === '\\') { j += 2; continue; }
    if (c === "'") {
      const end = input.indexOf("'", j + 1);
      if (end === -1) return null;
      j = end + 1;
      continue;
    }
    if (c === '"') {
      j++;
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') { j += 2; continue; }
        if (input[j] === '`') return null;
        if (input[j] === '$' && input[j + 1] === '(') {
          const sub = scanCommandSubst(input, j);
          if (!sub) return null;
          j = sub.end;
          continue;
        }
        j++;
      }
      if (j >= input.length) return null;
      j++;
      continue;
    }
    if (c === '$' && input[j + 1] === '(') {
      const sub = scanCommandSubst(input, j);
      if (!sub) return null;
      j = sub.end;
      continue;
    }
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') {
      depth--;
      j++;
      if (depth === 0) return { inner: input.slice(i + 2, j - 1), end: j };
      continue;
    }
    j++;
  }
  return null;
}

/**
 * Scan a heredoc redirection (`<<` / `<<-`) starting at `input[i]` (`input[i]`
 * and `input[i+1]` are both `<`). Reads the optional `-` (leading-tab-stripping
 * form) and the here-end delimiter word, which may be unquoted, single- or
 * double-quoted, or backslash-escaped. Quoting only governs whether the body is
 * expanded — irrelevant here, since the body is inert stdin data — so we record
 * the unquoted delimiter text used to match the closing line. Returns the
 * delimiter, whether the tab-stripping form was used, and the index just past
 * the delimiter word. Returns null when no delimiter word is present — notably
 * the `<<<` here-string operator (a different construct), so it stays a bail.
 * @param {string} input full command string
 * @param {number} i index of the first `<`
 * @returns {{delimiter: string, dashStrip: boolean, end: number} | null} delimiter info, or null
 */
function scanHeredocDelimiter(input, i) {
  let j = i + 2;
  let dashStrip = false;
  if (input[j] === '-') { dashStrip = true; j++; }
  while (j < input.length && (input[j] === ' ' || input[j] === '\t')) j++;
  let delimiter = '';
  let sawWord = false;
  while (j < input.length) {
    const c = checkedAt(input, j);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c === ';' || c === '|' || c === '&' || c === '<' || c === '>' || c === '(' || c === ')') break;
    if (c === "'") {
      const end = input.indexOf("'", j + 1);
      if (end === -1) return null;
      delimiter += input.slice(j + 1, end);
      j = end + 1;
      sawWord = true;
      continue;
    }
    if (c === '"') {
      const end = input.indexOf('"', j + 1);
      if (end === -1) return null;
      delimiter += input.slice(j + 1, end);
      j = end + 1;
      sawWord = true;
      continue;
    }
    if (c === '\\') {
      if (j + 1 >= input.length) return null;
      delimiter += checkedAt(input, j + 1);
      j += 2;
      sawWord = true;
      continue;
    }
    delimiter += c;
    j++;
    sawWord = true;
  }
  if (!sawWord || delimiter === '') return null;
  return { delimiter, dashStrip, end: j };
}

/**
 * Tokenise a POSIX-shaped shell command.
 *
 * Returns `null` if anything we can't reason about statically appears:
 * backticks, bare variable expansions, an unterminated heredoc, or unmatched
 * quotes. An unquoted top-level newline is emitted as a `;` separator operator
 * (so a multi-line script is validated segment-by-segment exactly like a
 * `;`-joined one); a backslash-newline is consumed as a line continuation. A
 * terminated heredoc (`cmd <<DELIM … DELIM`) is stripped as an inert input
 * redirect: the operator and the body up to the closing delimiter are consumed,
 * so the command is analysed by its words alone (the body is stdin data and
 * cannot introduce shell-level commands).
 * A command substitution `$(…)` is captured on the word token's `subst` field
 * (its text gets a {@link SUBST_SENTINEL} placeholder) so the segment layer can
 * either re-validate it (pure assignment) or reject it (any other position).
 * @param {string} input the command string
 * @returns {ShellToken[] | null} tokens, or null on bail
 */
export function tokenize(input) {
  /** @type {ShellToken[]} */
  const tokens = [];
  let i = 0;
  let cur = '';
  let curStart = -1;
  /** @type {string[]} command-substitution inner commands seen in the current word */
  let curSubst = [];
  /** @type {boolean} whether the current word contains an UNQUOTED expansion (`$NAME`, `${…}`, `$1`, `$@`, `$((…))`) that can word-split / glob at runtime */
  let curUnquotedVar = false;
  /** @type {Array<{delimiter: string, dashStrip: boolean}>} heredocs whose bodies are consumed at the next newline, FIFO */
  const pendingHeredocs = [];

  const flushWord = (/** @type {number} */ endIdx) => {
    if (curStart !== -1) {
      /** @type {WordToken} */
      const tok = {
        type: 'word',
        text: cur,
        raw: input.slice(curStart, endIdx),
        start: curStart,
        end: endIdx
      };
      if (curSubst.length > 0) tok.subst = curSubst;
      if (curUnquotedVar) tok.unquotedVar = true;
      tokens.push(tok);
      cur = '';
      curStart = -1;
      curSubst = [];
      curUnquotedVar = false;
    }
  };

  /**
   * Consume a `$(…)` command substitution at `checkedAt(input, i)`, appending a
   * {@link SUBST_SENTINEL} placeholder to the current word and recording the
   * inner command. Returns true on success (and advances `i`), false to bail.
   * @returns {boolean} true if captured, false if the caller must bail
   */
  const captureSubst = () => {
    const sub = scanCommandSubst(input, i);
    if (!sub) return false;
    if (curStart === -1) curStart = i;
    cur += SUBST_SENTINEL;
    curSubst.push(sub.inner);
    i = sub.end;
    return true;
  };

  /**
   * Advance one newline at `p` (which must point at `\n` or `\r`), handling a
   * `\r\n` pair as a single line break.
   * @param {number} p index of a newline character
   * @returns {number} index of the first character of the next line
   */
  const skipNewline = (p) => (input[p] === '\r' && input[p + 1] === '\n' ? p + 2 : p + 1);

  /**
   * Consume the bodies of all {@link pendingHeredocs} (FIFO), each running from
   * the line after `startIdx` up to and including a line equal to its delimiter
   * (leading tabs stripped first for the `<<-` form). Returns the index of the
   * newline that ends the last delimiter line (or end-of-input), or null if any
   * heredoc is never terminated.
   * @param {number} startIdx index of the newline that begins the first body
   * @returns {number | null} index just past the last delimiter line, or null
   */
  const consumeHeredocBodies = (startIdx) => {
    let pos = startIdx;
    while (pendingHeredocs.length > 0) {
      const hd = /** @type {{delimiter: string, dashStrip: boolean}} */ (pendingHeredocs.shift());
      for (;;) {
        if (pos >= input.length) return null;
        pos = skipNewline(pos);
        let lineEnd = pos;
        while (lineEnd < input.length && input[lineEnd] !== '\n' && input[lineEnd] !== '\r') lineEnd++;
        const line = input.slice(pos, lineEnd);
        const cmp = hd.dashStrip ? line.replace(/^\t+/, '') : line;
        if (cmp === hd.delimiter) {
          pos = lineEnd; // leave pos at the delimiter line's trailing newline (or EOF)
          break;
        }
        if (lineEnd >= input.length) return null; // EOF before the delimiter
        pos = lineEnd;
      }
    }
    return pos;
  };

  while (i < input.length) {
    const c = checkedAt(input, i);

    if (c === ' ' || c === '\t') { flushWord(i); i++; continue; }
    if (c === '\n' || c === '\r') {
      // An unquoted newline at top level is a sequential command
      // separator, exactly like `;` (quotes and `$(…)` consume their own
      // interior newlines before reaching here; a `\`-newline line
      // continuation is consumed by the `\\` branch below). Skip it when
      // the previous token is already an operator — the line ends with
      // `&&`/`||`/`|`/etc., a continuation — so we never synthesise an
      // empty segment from the line break.
      flushWord(i);
      // A pending heredoc body begins at this newline: consume it (and any
      // further queued heredocs) and resume after the closing delimiter, rather
      // than treating the line break as a command separator.
      if (pendingHeredocs.length > 0) {
        const after = consumeHeredocBodies(i);
        if (after === null) return null;
        i = after;
        continue;
      }
      const prev = tokens[tokens.length - 1];
      if (!prev || prev.type !== 'op') {
        tokens.push({ type: 'op', text: ';', start: i, end: i + 1 });
      }
      i++;
      continue;
    }
    if (c === '`') return null;
    if (c === '$') {
      // Bare (unquoted) `$(…)` command substitution: capture it structurally
      // (re-validated only in the pure-assignment path; rejected everywhere
      // else via its SUBST_SENTINEL).
      if (checkedAt(input, i + 1) === '(' && input[i + 2] !== '(') {
        if (!captureSubst()) return null;
        continue;
      }
      // Any OTHER unquoted expansion — `$NAME`, `${NAME}`, `$1`, `$$`, `$@`,
      // `$((expr))` — is kept as LITERAL word text and the word is marked
      // `unquotedVar`. Unlike a double-quoted expansion, an unquoted one can
      // word-split / glob-expand at runtime, so a marked word is never trusted
      // by a builtin handler (see isSegmentSafe / isSafeSinkTail); it can only
      // be approved by an explicit user glob pattern, whose match is on the
      // literal command text and is unaffected by word-splitting (the head and
      // operators are fixed at parse time, before expansion). This mirrors the
      // double-quoted `$`-handling below, minus the split-safety guarantee.
      const nx = checkedAt(input, i + 1);
      if (nx === '(' && input[i + 2] === '(') {
        // `$((expr))` arithmetic. Scan to the matching `))` by paren depth and
        // reject a smuggled command substitution / backtick in the body.
        let depth = 0;
        let k = i + 1;
        for (; k < input.length; k++) {
          const a = checkedAt(input, k);
          if (a === '(') depth++;
          else if (a === ')') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0 || k >= input.length || checkedAt(input, k) !== ')') return null;
        const arith = input.slice(i + 3, k - 1);
        if (arith.includes('`') || arith.includes('$(')) return null;
        if (curStart === -1) curStart = i;
        cur += input.slice(i, k + 1);
        curUnquotedVar = true;
        i = k + 1;
        continue;
      }
      if (nx === '{') {
        const close = input.indexOf('}', i + 2);
        if (close === -1) return null;
        const body = input.slice(i + 2, close);
        // Same subscript grammar as the double-quoted `${…}` branch: a bare
        // name or a literal-number / `@` / `*` / identifier subscript is a pure
        // value read; anything else (notably a `$(…)` inside the subscript) bails.
        if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:[0-9]+|@|\*|[A-Za-z_][A-Za-z0-9_]*)\])?$/.test(body)) return null;
        if (curStart === -1) curStart = i;
        cur += input.slice(i, close + 1);
        curUnquotedVar = true;
        i = close + 1;
        continue;
      }
      if (nx && /[A-Za-z_]/.test(nx)) {
        let k = i + 1;
        while (k < input.length && /[A-Za-z0-9_]/.test(checkedAt(input, k))) k++;
        if (curStart === -1) curStart = i;
        cur += input.slice(i, k);
        curUnquotedVar = true;
        i = k;
        continue;
      }
      if (nx && /[0-9$?!#*@]/.test(nx)) {
        // `$1`…`$9`, `$$`, `$?`, `$!`, `$#`, `$*`, `$@` — special parameters.
        if (curStart === -1) curStart = i;
        cur += checkedAt(input, i) + nx;
        curUnquotedVar = true;
        i += 2;
        continue;
      }
      // Literal `$` (before space / quote / operator / EOL): `$(` and backticks
      // were handled above, so this is a bare dollar with no expansion. Emit it
      // literally; it does NOT word-split, so the word is NOT marked.
      if (curStart === -1) curStart = i;
      cur += '$';
      i++;
      continue;
    }

    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) return null;
      if (curStart === -1) curStart = i;
      cur += input.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      if (curStart === -1) curStart = i;
      i++;
      while (i < input.length && checkedAt(input, i) !== '"') {
        const ch = checkedAt(input, i);
        if (ch === '`') return null;
        if (ch === '$') {
          // Inside `"..."`, `$NAME` / `${NAME}` / `$N` / `$$` / `$?`
          // / `$!` / `$#` / `$*` / `$@` are pure variable expansions
          // whose values become literal characters in the resulting
          // argument — they can't introduce new args, flags, or
          // commands. `$(...)` is command substitution; still reject.
          // A `$` NOT starting any of these (e.g. a regex end-anchor
          // `"FAIL$|…"`, or `$` before a space/quote) is a literal
          // dollar in POSIX double-quoting — emit it literally rather
          // than bail.
          const next = checkedAt(input, i + 1);
          if (next === '(' && input[i + 2] === '(') {
            // Arithmetic expansion `$((expr))`. The result is always a
            // numeric value, so it can't introduce new args, flags, or
            // commands. Scan to the matching `))` by paren depth, then
            // reject if the body smuggles a command substitution or
            // backtick (`$(( $(cmd) ))`).
            let depth = 0;
            let k = i + 1;
            for (; k < input.length; k++) {
              const a = checkedAt(input, k);
              if (a === '"') break; // can't cross the closing quote
              if (a === '(') depth++;
              else if (a === ')') { depth--; if (depth === 0) break; }
            }
            if (depth !== 0 || k >= input.length || checkedAt(input, k) !== ')') return null;
            const arith = input.slice(i + 3, k - 1);
            if (arith.includes('`') || arith.includes('$(')) return null;
            cur += input.slice(i, k + 1);
            i = k + 1;
            continue;
          }
          if (next === '(') {
            // Command substitution `"$(…)"` inside double quotes.
            // Capture it (the sentinel keeps the surrounding literal
            // text — e.g. `"prefix-$(cmd)"` — intact).
            if (!captureSubst()) return null;
            continue;
          }
          if (next === '{') {
            const close = input.indexOf('}', i + 2);
            if (close === -1) return null;
            const body = input.slice(i + 2, close);
            // `${NAME}` or `${NAME[idx]}`. An array subscript whose
            // index is a literal number (`${PIPESTATUS[0]}`), `@`/`*`
            // (whole array), or a bare identifier (`${arr[i]}`) is a
            // pure value read — it can't introduce new args/commands.
            // Anything else in the subscript (notably `$(...)`, which
            // bash arithmetic-evaluates) must still bail.
            if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:[0-9]+|@|\*|[A-Za-z_][A-Za-z0-9_]*)\])?$/.test(body)) return null;
            cur += input.slice(i, close + 1);
            i = close + 1;
            continue;
          }
          if (next && /[A-Za-z_]/.test(next)) {
            let k = i + 1;
            while (k < input.length && /[A-Za-z0-9_]/.test(checkedAt(input, k))) k++;
            cur += input.slice(i, k);
            i = k;
            continue;
          }
          if (next && /[0-9$?!#*@]/.test(next)) {
            cur += checkedAt(input, i) + checkedAt(input, i + 1);
            i += 2;
            continue;
          }
          // Literal `$` (not an expansion). `$(` and backticks were
          // already rejected above, so this can't be substitution.
          cur += '$';
          i++;
          continue;
        }
        if (ch === '\\') {
          if (i + 1 >= input.length) return null;
          // POSIX: inside double quotes `\` is special ONLY before
          // `$`, `` ` ``, `"`, `\`, or newline — there it escapes the
          // next char. Before anything else the backslash is literal
          // and BOTH characters survive (e.g. a grep pattern like
          // `"\-\-bg-\s*:"` must keep its backslashes, not collapse to
          // `--bg-s*:` which then looks like an unknown `--` flag).
          const n = checkedAt(input, i + 1);
          if (n === '$' || n === '`' || n === '"' || n === '\\' || n === '\n') {
            cur += n;
          } else {
            cur += ch + n;
          }
          i += 2;
          continue;
        }
        cur += ch;
        i++;
      }
      if (i >= input.length) return null;
      i++;
      continue;
    }

    if (c === '\\') {
      if (i + 1 >= input.length) return null;
      // `\`-newline is a line continuation: the shell removes both
      // characters and joins the lines, so consume them without emitting
      // anything (the current word, if any, keeps accumulating).
      if (checkedAt(input, i + 1) === '\n') { i += 2; continue; }
      if (checkedAt(input, i + 1) === '\r' && input[i + 2] === '\n') { i += 3; continue; }
      if (curStart === -1) curStart = i;
      cur += checkedAt(input, i + 1);
      i += 2;
      continue;
    }

    // An unquoted `#` at a word boundary begins a comment that runs to the end
    // of the line (POSIX). It is only a comment at the START of a word: a `#`
    // inside a word (`foo#bar`, `$VAR#`) is a literal character, so we require
    // `curStart === -1` (no word currently accumulating — quoted `#` never
    // reaches here, it is consumed inside the quote branches). The terminating
    // newline is left in place for the newline branch to handle as a normal
    // command separator, so a comment line behaves exactly like a blank line.
    if (c === '#' && curStart === -1) {
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++;
      continue;
    }

    let matched = null;
    for (const op of SHELL_OPERATORS) {
      if (input.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      if (matched === '<<') {
        // Heredoc: queue its delimiter and strip the operator. The body is
        // consumed at the next newline (see consumeHeredocBodies); the `<<<`
        // here-string and any other delimiter-less form yields null → bail.
        const hd = scanHeredocDelimiter(input, i);
        if (!hd) return null;
        flushWord(i);
        pendingHeredocs.push({ delimiter: hd.delimiter, dashStrip: hd.dashStrip });
        i = hd.end;
        continue;
      }
      flushWord(i);
      tokens.push({ type: 'op', text: matched, start: i, end: i + matched.length });
      i += matched.length;
      continue;
    }

    if (curStart === -1) curStart = i;
    cur += c;
    i++;
  }
  flushWord(i);
  // A heredoc whose delimiter line never arrived (e.g. `cat <<EOF` with no
  // body) is an incomplete command — bail rather than analyse a fragment.
  if (pendingHeredocs.length > 0) return null;
  return tokens;
}

// ============================================================================
// Path policy — posixNormalize / windowsToComparable / toComparablePath /
// isPathInsideAllowedRoots / canonicalRoot / isGrantableRoot now live in the
// shared SDK module juggler/utils/path-containment (imported and re-exported at
// the top of this file), so the file write/edit tools apply identical
// containment logic.
// ============================================================================

// ============================================================================
// Glob matching
// ============================================================================

/**
 * Glob-match a command string against a pattern. `*` matches anything except
 * newlines; all other regex metacharacters are escaped.
 * @param {string} pattern glob pattern
 * @param {string} command command string
 * @returns {boolean} true on match
 */
export function matchesGlob(pattern, command) {
  if (pattern === '*') return true;
  if (pattern === command) return true;
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^\\n]*');
  try {
    return new RegExp('^' + re + '$').test(command);
  } catch {
    return false;
  }
}

// ============================================================================
// Command handlers — one class per builtin
// ============================================================================

/**
 * Base class for a per-command safety policy.
 *
 * Each subclass owns the policy for exactly one head command. Keep them
 * tiny: a class per command, registered in {@link COMMAND_HANDLERS}, is the
 * extension point — not a switch statement.
 */
class CommandHandler {
  /** @type {string} command name */
  static commandName = '';

  /**
   * Safety as a top-level command (`<cmd> <args>`). Default: unsafe.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {boolean} true if these args are safe with this command
   */
  // eslint-disable-next-line no-unused-vars
  static isSafe(args, ctx) { return false; }

  /**
   * Safety as a pipeline sink (`... | <cmd> <args>`). Input comes from the
   * pipe, so no in-project-path arg is required. Default: not a sink.
   *
   * Override in commands that are unambiguously non-mutating and useful at
   * the end of a read-only pipeline (cat, head, tail, wc, grep, …). The
   * optional `cfg` carries the redirect policy (allowedRoots + writeEnabled +
   * home + platform) for the few sinks that WRITE (`tee`) and so must scope
   * their file operands; read-only sinks ignore it.
   * @param {string[]} args positional + flag args (no head command)
   * @param {RedirectCfg} [cfg] redirect policy (only needed by writing sinks)
   * @returns {boolean} true if these args are safe in sink position
   */
  // eslint-disable-next-line no-unused-vars
  static isSafeAsSink(args, cfg) { return false; }

  /**
   * Output-path domain of this command's stdout. Returns `'inProjectPath'`
   * when stdout is a list of in-project filesystem paths that may safely feed
   * a later path argument through a `NAME=$(cmd)` substitution; otherwise null
   * (stdout is opaque content/metadata, not paths). Only consulted for a
   * command that already auto-approves on its own. Default: null.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {'inProjectPath' | null} output-path domain, or null
   */
  // eslint-disable-next-line no-unused-vars
  static outputPathDomain(args, ctx) { return null; }

  /**
   * The filesystem-path arguments this command reads, which must lie inside the
   * allowed roots — i.e. the paths a folder grant would need to cover to make
   * the command auto-approve. Returns `null` when the command's flag/shape
   * grammar is itself unsafe or unparseable (so no path grant can rescue it),
   * and `[]` when the command reads no path arguments. Default: `null` (the
   * handler can't characterise its path arguments).
   *
   * A read-only file-reading handler overrides this; the base
   * {@link outOfRootPaths} then filters the result to the out-of-root subset.
   * The handler need NOT re-confirm full safety here — {@link segmentRemedies}
   * re-verifies the whole segment with the candidate roots granted, so any
   * non-path reason the command is unsafe still suppresses the grant.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {string[] | null} path arguments, or null if uncharacterised/unsafe
   */
  // eslint-disable-next-line no-unused-vars
  static pathArgs(args, ctx) { return null; }

  /**
   * Out-of-root path obstacles: this command's {@link pathArgs} filtered to the
   * subset that falls outside the allowed roots. When this is the ONLY reason a
   * command is rejected, granting these folders (adding them to the
   * allowed-paths list) makes it auto-approve — a far more useful "don't ask
   * again" than wildcarding the command. Returns `[]` when the shape itself is
   * unsafe (pathArgs → null) or no path argument is out of root.
   *
   * Derived from {@link pathArgs} so a handler only declares which arguments are
   * paths; this single implementation owns the out-of-root filtering.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {string[]} out-of-root path arguments, or [] if not a path obstacle
   */
  static outOfRootPaths(args, ctx) {
    const paths = this.pathArgs(args, ctx);
    if (paths === null) return [];
    return paths.filter(p => !isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform));
  }

  /**
   * Suggest auto-approval glob patterns of increasing breadth that would let
   * a rejected segment with this head command pass the analyser's pattern
   * fallback. `words` is the normalised word list (head command first, after
   * sink/env stripping). The caller prepends the exact segment text as the
   * narrowest tier and dedupes, so handlers only return generalisations.
   *
   * Default: a single command-scoped wildcard (`<cmd> *`). Override in
   * commands with sub-structure worth a middle tier (see {@link GitHandler}).
   * @param {string[]} words segment words, head command first
   * @returns {string[]} generalisation patterns, narrowest→broadest
   */
  static suggestPatterns(words) {
    return [`${words[0]} *`];
  }
}

/** Commands that take no arguments at all. */
class NoArgsHandler extends CommandHandler {
  /** @type {string} command name */
  static commandName = '';
  /**
   * @param {string[]} args args
   * @returns {boolean} true if no args
   */
  static isSafe(args) { return args.length === 0; }
}

class PwdHandler extends NoArgsHandler { static commandName = 'pwd'; }
class WhoamiHandler extends NoArgsHandler { static commandName = 'whoami'; }
class IdHandler extends NoArgsHandler { static commandName = 'id'; }
class DateHandler extends NoArgsHandler { static commandName = 'date'; }
class TrueHandler extends NoArgsHandler { static commandName = 'true'; }
class FalseHandler extends NoArgsHandler { static commandName = 'false'; }
class ColonHandler extends NoArgsHandler { static commandName = ':'; }
class HostnameHandler extends NoArgsHandler { static commandName = 'hostname'; }
class UptimeHandler extends NoArgsHandler { static commandName = 'uptime'; }

/**
 * `sleep DURATION [DURATION...]` — pause for a fixed duration. Read-only,
 * no FS / network effects. Each duration must be numeric with an optional
 * single-letter suffix (`s`, `m`, `h`, `d`) per GNU coreutils. Reject
 * anything else so a shell-substituted duration can never slip through (the
 * tokenizer already bails on `$(…)` / backticks, but this is defense in
 * depth).
 */
class SleepHandler extends CommandHandler {
  static commandName = 'sleep';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    if (args.length === 0) return false;
    return args.every(a => /^\d+(?:\.\d+)?[smhd]?$/.test(a));
  }
}

class UnameHandler extends CommandHandler {
  static commandName = 'uname';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.every(a => /^-[amrsnpiov]+$/.test(a));
  }
}

class EchoHandler extends CommandHandler {
  static commandName = 'echo';
  // Backticks and `$(…)` substitution are rejected before we get here, and an
  // unquoted expansion routes the segment to pattern-only approval (see
  // isSegmentSafe) rather than to this handler; a quoted expansion is opaque
  // literal text. echo is read-only w.r.t. the filesystem, so any surviving
  // args are safe.
  /** @returns {boolean} safe */
  static isSafe() { return true; }
}

class PrintfHandler extends CommandHandler {
  static commandName = 'printf';
  /**
   * Same reasoning as echo — no FS effect; substitutions/backticks are rejected
   * earlier and unquoted expansions route to pattern-only approval.
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) { return args.length >= 1; }
}

class WhichHandler extends CommandHandler {
  static commandName = 'which';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.length >= 1 && args.every(a => !a.startsWith('-'));
  }
}

class TypeHandler extends CommandHandler {
  static commandName = 'type';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.length >= 1 && args.every(a => !a.startsWith('-'));
  }
}

class CommandBuiltinHandler extends CommandHandler {
  static commandName = 'command';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.length === 2 && checkedAt(args, 0) === '-v' && !checkedAt(args, 1).startsWith('-');
  }
}

/**
 * `cd <path>` — change directory. Safe as a segment anywhere in a sequence (not
 * just leading) when the single target path resolves inside an allowed root.
 * `cd` itself does nothing dangerous; the risk is that a *later* command's
 * relative paths resolve against the new cwd, but every later segment is
 * validated independently and its relative paths are rejected if they escape
 * via `..` — so a `cd` into the project can't widen what follows. Bare `cd`
 * (→ $HOME), `cd -` (→ $OLDPWD), and flag forms stay unrecognised (prompt),
 * since their destination isn't a known in-project path.
 */
class CdHandler extends CommandHandler {
  static commandName = 'cd';
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    return args.length === 1
			&& !checkedAt(args, 0).startsWith('-')
			&& isPathInsideAllowedRoots(checkedAt(args, 0), ctx.allowedRoots, ctx.home, ctx.platform);
  }
}

/**
 * Short single-letter flags common to read-only directory listings.
 * Any combination in a single `-XYZ` cluster is accepted. Adding a letter
 * here is the way to liberalise — no need to enumerate combinations.
 */
const LS_SHORT_FLAGS = 'aAbBcCdfFghHiklLmnopqrRsStuUvxX1';
const LS_LONG_FLAGS = new Set([
  '--all', '--almost-all', '--color', '--classify', '--directory',
  '--group-directories-first', '--human-readable', '--inode',
  '--reverse', '--recursive', '--size', '--sort'
]);

class LsHandler extends CommandHandler {
  static commandName = 'ls';

  /**
   * Parse args into positional path arguments, validating flags along the way.
   * Returns null when a flag is unrecognised — the command shape itself is
   * unsafe, so no path grant could rescue it.
   * @param {string[]} args args
   * @returns {string[] | null} positional paths, or null on an unsafe flag
   */
  static _parsePaths(args) {
    /** @type {string[]} */
    const paths = [];
    for (const a of args) {
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (!LS_LONG_FLAGS.has(flag)) return null;
        continue;
      }
      if (a.startsWith('-') && a !== '-') {
        const cluster = a.slice(1);
        if (cluster.length === 0) return null;
        for (const ch of cluster) {
          if (!LS_SHORT_FLAGS.includes(ch)) return null;
        }
        continue;
      }
      paths.push(a);
    }
    return paths;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = LsHandler._parsePaths(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * @param {string[]} args args
   * @returns {string[] | null} positional paths, or null on an unsafe flag
   */
  static pathArgs(args) {
    return LsHandler._parsePaths(args);
  }
}

/**
 * `du` — disk usage reporting. It is read-only, but every explicit path and
 * every flag-provided input file (currently `-X` / `--exclude-from`) must stay
 * inside the allowed roots. With no paths, `du` defaults to cwd, which is
 * treated as the conversation root and is safe.
 */
class DuHandler extends CommandHandler {
  static commandName = 'du';

  /** Boolean short flags accepted in clusters (BSD/GNU common read-only flags). */
  static BOOL_SHORT = 'abcDhkHklLmsxP0';

  /** Short flags that take a following/attached value. */
  static VALUE_SHORT = new Set(['d', 't', 'B', 'I', 'X']);

  /** Long flags that take no value. */
  static BOOL_LONG = new Set([
    '--all', '--total', '--human-readable', '--summarize', '--separate-dirs',
    '--one-file-system', '--count-links', '--dereference', '--dereference-args',
    '--no-dereference', '--apparent-size', '--inodes', '--si', '--time',
    '--null', '--bytes', '--kilobytes'
  ]);

  /** Long flags that take a value (either `--key=val` or `--key val`). */
  static VALUE_LONG = new Set([
    '--max-depth', '--threshold', '--block-size', '--exclude', '--exclude-from',
    '--time-style', '--time'
  ]);

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {string[] | null} positional paths, or null on unsafe flags/values
   */
  static _parseFlags(args, ctx) {
    const paths = [];
    let stopOptions = false;
    for (let i = 0; i < args.length; i++) {
      const a = checkedAt(args, i);
      if (stopOptions || !a.startsWith('-') || a === '-') {
        paths.push(a);
        continue;
      }
      if (a === '--') { stopOptions = true; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (DuHandler.BOOL_LONG.has(flag)) continue;
        if (DuHandler.VALUE_LONG.has(flag)) {
          let val = eq === -1 ? '' : a.slice(eq + 1);
          if (eq === -1) {
            if (i + 1 >= args.length) return null;
            val = checkedAt(args, ++i);
          }
          if ((flag === '--max-depth') && !/^\d+$/.test(val)) return null;
          if (flag === '--exclude-from' && !isPathInsideAllowedRoots(val, ctx.allowedRoots, ctx.home, ctx.platform)) return null;
          continue;
        }
        return null;
      }

      const cluster = a.slice(1);
      if (!cluster) return null;
      for (let k = 0; k < cluster.length; k++) {
        const ch = checkedAt(cluster, k);
        if (!DuHandler.BOOL_SHORT.includes(ch) && !DuHandler.VALUE_SHORT.has(ch)) return null;
        if (DuHandler.VALUE_SHORT.has(ch)) {
          let val = cluster.slice(k + 1);
          if (!val) {
            if (i + 1 >= args.length) return null;
            val = checkedAt(args, ++i);
          }
          if (ch === 'd' && !/^\d+$/.test(val)) return null;
          if (ch === 'X' && !isPathInsideAllowedRoots(val, ctx.allowedRoots, ctx.home, ctx.platform)) return null;
          break;
        }
      }
    }
    return paths;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = DuHandler._parseFlags(args, ctx);
    if (paths === null) return false;
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * Sink/xargs position: accept only flags, no pre-supplied paths. This keeps
   * `find … | xargs du -sh` useful while still preventing hidden path reads.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const paths = DuHandler._parseFlags(args, { platform: '', allowedRoots: [] });
    return paths !== null && paths.length === 0;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {string[] | null} positional paths, or null on unsafe flags/values
   */
  static pathArgs(args, ctx) {
    return DuHandler._parseFlags(args, ctx);
  }
}
class FlaggedFileReader extends CommandHandler {
  /** @returns {(arg: string) => boolean} flag matcher */
  static flagMatcher() { return () => false; }

  /**
   * Walk the flag prefix, then return the trailing positional file paths, or
   * null on any unrecognised flag / missing numeric value.
   * @param {string[]} args args
   * @returns {string[] | null} positional file paths, or null on reject
   */
  static pathArgs(args) {
    const matcher = this.flagMatcher();
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '-') {
      if (!matcher(checkedAt(args, i))) return null;
      if (/^-[ncC]$/.test(checkedAt(args, i))) {
        if (i + 1 >= args.length || !/^\d+$/.test(checkedAt(args, i + 1))) return null;
        i += 2;
        continue;
      }
      i++;
    }
    return args.slice(i);
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = this.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }
}

class TailHandler extends FlaggedFileReader {
  static commandName = 'tail';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-(?:n|c|C|f|q|v|\d+)$/.test(a) || /^-[fqv]+$/.test(a); }
  /**
   * Safe as a sink with `-N`, `-n N`, `-c N`, or no args.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    if (args.length === 0) return true;
    if (args.length === 1) return /^-\d+$/.test(checkedAt(args, 0)) || /^-[fqv]+$/.test(checkedAt(args, 0));
    if (args.length === 2 && (checkedAt(args, 0) === '-n' || checkedAt(args, 0) === '-c') && /^\d+$/.test(checkedAt(args, 1))) return true;
    return false;
  }
}

class HeadHandler extends FlaggedFileReader {
  static commandName = 'head';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-(?:n|c|C|q|v|\d+)$/.test(a) || /^-[qv]+$/.test(a); }
  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    if (args.length === 0) return true;
    if (args.length === 1) return /^-\d+$/.test(checkedAt(args, 0)) || /^-[qv]+$/.test(checkedAt(args, 0));
    if (args.length === 2 && (checkedAt(args, 0) === '-n' || checkedAt(args, 0) === '-c') && /^\d+$/.test(checkedAt(args, 1))) return true;
    return false;
  }
}

class WcHandler extends FlaggedFileReader {
  static commandName = 'wc';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-[lwcmL]+$/.test(a); }
  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    if (args.length === 0) return true;
    if (args.length === 1 && /^-[lwcmL]+$/.test(checkedAt(args, 0))) return true;
    return false;
  }
}

/**
 * `sort` — order lines. Read-only except for the output / program flags, which
 * are rejected:
 *   - `-o FILE` / `--output=FILE`     — writes the result to a file.
 *   - `--compress-program=PROG`       — runs an arbitrary program.
 *   - `--random-source=FILE` / `--files0-from=F` — name files; excluded to keep
 *     the surface small (no legitimate need in an auto-approved read).
 * Everything else (`-u`, `-n`, `-r`, `-k`, `-t`, `-S`, `-T`, …) just reads and
 * sorts. As a sink the input is the pipe, so no file args are allowed.
 */
class SortHandler extends CommandHandler {
  static commandName = 'sort';

  /** Long flags that take no value. */
  static BOOL_LONG = new Set([
    '--ignore-leading-blanks', '--dictionary-order', '--ignore-case',
    '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting',
    '--month-sort', '--numeric-sort', '--reverse', '--random-sort',
    '--stable', '--unique', '--version-sort', '--check', '--zero-terminated',
    '--debug'
  ]);

  /** Long flags taking a value that writes / execs nothing. */
  static VALUE_LONG = new Set([
    '--key', '--field-separator', '--buffer-size', '--temporary-directory'
  ]);

  /** Short cluster letters that take no value. */
  static BOOL_SHORT = 'bdfghiMnrRsuVcCz';

  /** Short flags taking a value (glued `-k2` or separate `-k 2`). */
  static VALUE_SHORT = new Set(['k', 't', 'S', 'T']);

  /**
   * Walk the flag prefix. Returns the index of the first positional arg, or
   * -1 if any flag is unrecognised or writes/execs.
   * @param {string[]} args args
   * @returns {number} first-positional index, or -1 on reject
   */
  static _parseFlags(args) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') return i + 1;
      if (!a.startsWith('-') || a === '-') break;

      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (SortHandler.BOOL_LONG.has(flag)) { i++; continue; }
        if (SortHandler.VALUE_LONG.has(flag)) {
          if (eq === -1) {
            if (i + 1 >= args.length) return -1;
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        return -1;
      }

      const cluster = a.slice(1);
      let consumedNext = false;
      let j = 0;
      while (j < cluster.length) {
        const ch = checkedAt(cluster, j);
        if (SortHandler.VALUE_SHORT.has(ch)) {
          const rest = cluster.slice(j + 1);
          if (rest.length === 0) {
            if (i + 1 >= args.length) return -1;
            consumedNext = true;
          }
          j = cluster.length;
          break;
        }
        if (!SortHandler.BOOL_SHORT.includes(ch)) return -1;
        j++;
      }
      i += consumedNext ? 2 : 1;
    }
    return i;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const start = SortHandler._parseFlags(args);
    if (start === -1) return false;
    for (let j = start; j < args.length; j++) {
      if (!isPathInsideAllowedRoots(checkedAt(args, j), ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const start = SortHandler._parseFlags(args);
    if (start === -1) return false;
    return start === args.length;
  }

  /**
   * @param {string[]} args args
   * @returns {string[] | null} positional (input) file paths, or null on reject
   */
  static pathArgs(args) {
    const start = SortHandler._parseFlags(args);
    return start === -1 ? null : args.slice(start);
  }
}

/**
 * `uniq` — collapse / count adjacent duplicate lines. A read-only line filter.
 *
 * Every accepted flag is non-writing. The one hazard is uniq's positional
 * grammar `uniq [OPTION]... [INPUT [OUTPUT]]`: a SECOND positional names an
 * OUTPUT file that uniq overwrites. So we allow at most one positional (the
 * INPUT, which must be in-project) at top level, and none in sink position —
 * the output-file form can never be auto-approved.
 *
 * Value-taking flags are `-f N` / `--skip-fields=N` (skip fields), `-s N` /
 * `--skip-chars=N`, `-w N` / `--check-chars=N`, all numeric. `--all-repeated`
 * / `--group` take an OPTIONAL `=METHOD`; their short forms (`-D`, none) take
 * no value.
 */
class UniqHandler extends CommandHandler {
  static commandName = 'uniq';

  /** Long flags that take no value. */
  static BOOL_LONG = new Set([
    '--count', '--repeated', '--ignore-case', '--unique', '--zero-terminated'
  ]);

  /** Long flags taking a (numeric) value, either `--key=N` or `--key N`. */
  static VALUE_LONG = new Set(['--skip-fields', '--skip-chars', '--check-chars']);

  /** Long flags with an OPTIONAL `=METHOD` value and never a separate arg. */
  static OPTIONAL_VALUE_LONG = new Set(['--all-repeated', '--group']);

  /** Short cluster letters that take no value (`-D` = all-repeated, no method). */
  static BOOL_SHORT = 'cduizD';

  /** Short flags taking a numeric value (glued `-f2` or separate `-f 2`). */
  static VALUE_SHORT = new Set(['f', 's', 'w']);

  /**
   * Walk the flag prefix; return the positional args, or null on any
   * unrecognised flag or non-numeric value.
   * @param {string[]} args args
   * @returns {string[] | null} positionals, or null on reject
   */
  static _parseFlags(args) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;

      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (UniqHandler.BOOL_LONG.has(flag)) { i++; continue; }
        if (UniqHandler.OPTIONAL_VALUE_LONG.has(flag)) { i++; continue; }
        if (UniqHandler.VALUE_LONG.has(flag)) {
          if (eq === -1) {
            if (i + 1 >= args.length || !/^\d+$/.test(checkedAt(args, i + 1))) return null;
            i += 2;
          } else {
            if (!/^\d+$/.test(a.slice(eq + 1))) return null;
            i++;
          }
          continue;
        }
        return null;
      }

      const cluster = a.slice(1);
      let consumedNext = false;
      let j = 0;
      while (j < cluster.length) {
        const ch = checkedAt(cluster, j);
        if (UniqHandler.VALUE_SHORT.has(ch)) {
          const rest = cluster.slice(j + 1);
          if (rest.length > 0) {
            if (!/^\d+$/.test(rest)) return null;
          } else {
            if (i + 1 >= args.length || !/^\d+$/.test(checkedAt(args, i + 1))) return null;
            consumedNext = true;
          }
          j = cluster.length;
          break;
        }
        if (!UniqHandler.BOOL_SHORT.includes(ch)) return null;
        j++;
      }
      i += consumedNext ? 2 : 1;
    }
    return args.slice(i);
  }

  /**
   * Top-level: at most one positional (the INPUT file), in-project. A second
   * positional is uniq's OUTPUT file (a write) and is rejected.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const positionals = UniqHandler._parseFlags(args);
    if (positionals === null) return false;
    if (positionals.length > 1) return false; // 2nd positional = output file
    for (const p of positionals) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * Sink: input from the pipe; no positionals (an INPUT positional would
   * shadow stdin, an OUTPUT positional would write a file).
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const positionals = UniqHandler._parseFlags(args);
    if (positionals === null) return false;
    return positionals.length === 0;
  }

  /**
   * Only the single INPUT positional is a readable path. A 2nd positional is an
   * OUTPUT file uniq overwrites — a write, never rescued by a read grant — so we
   * return null there (ungrantable shape).
   * @param {string[]} args args
   * @returns {string[] | null} the INPUT path, or null on reject / output-file form
   */
  static pathArgs(args) {
    const positionals = UniqHandler._parseFlags(args);
    if (positionals === null) return null;
    if (positionals.length > 1) return null; // 2nd positional = output file (write)
    return positionals;
  }
}

/**
 * `cut` — select columns / fields from each line. A read-only line filter.
 *
 * Unlike {@link UniqHandler}, cut has no output-file positional: every
 * positional is an INPUT file (`cut OPTION... [FILE]...`), so at top level they
 * must all be in-project, and in sink position there must be none (input comes
 * from the pipe). Value-taking flags (`-b/-c/-f LIST`, `-d DELIM`,
 * `--output-delimiter=STR`) carry only data, never a path or program, so their
 * values are accepted as-is — only the positional file args are path-checked.
 */
class CutHandler extends CommandHandler {
  static commandName = 'cut';

  /** Long flags that take no value. */
  static BOOL_LONG = new Set(['--complement', '--only-delimited', '--zero-terminated']);

  /** Long flags taking a value, either `--key=val` or `--key val`. */
  static VALUE_LONG = new Set([
    '--bytes', '--characters', '--delimiter', '--fields', '--output-delimiter'
  ]);

  /** Short cluster letters that take no value (`-n` is a no-op kept for compat). */
  static BOOL_SHORT = 'snz';

  /** Short flags taking a value (glued `-f1-2` / `-d/` or separate `-f 1-2`). */
  static VALUE_SHORT = new Set(['b', 'c', 'd', 'f']);

  /**
   * Walk the flag prefix; return the positional (file) args, or null on any
   * unrecognised flag or a value flag missing its value.
   * @param {string[]} args args
   * @returns {string[] | null} positionals, or null on reject
   */
  static _parseFlags(args) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;

      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (CutHandler.BOOL_LONG.has(flag)) { i++; continue; }
        if (CutHandler.VALUE_LONG.has(flag)) {
          if (eq === -1) {
            if (i + 1 >= args.length) return null;
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        return null;
      }

      const cluster = a.slice(1);
      let consumedNext = false;
      let j = 0;
      while (j < cluster.length) {
        const ch = checkedAt(cluster, j);
        if (CutHandler.VALUE_SHORT.has(ch)) {
          // Value is the rest of the cluster (`-f1-2`, `-d/`) or the next arg.
          if (cluster.slice(j + 1).length === 0) {
            if (i + 1 >= args.length) return null;
            consumedNext = true;
          }
          j = cluster.length;
          break;
        }
        if (!CutHandler.BOOL_SHORT.includes(ch)) return null;
        j++;
      }
      i += consumedNext ? 2 : 1;
    }
    return args.slice(i);
  }

  /**
   * Top-level: positionals are INPUT files; all must be in-project.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const positionals = CutHandler._parseFlags(args);
    if (positionals === null) return false;
    for (const p of positionals) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * Sink: input from the pipe; no file positionals.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const positionals = CutHandler._parseFlags(args);
    if (positionals === null) return false;
    return positionals.length === 0;
  }

  /**
   * @param {string[]} args args
   * @returns {string[] | null} positional (input) file paths, or null on reject
   */
  static pathArgs(args) {
    return CutHandler._parseFlags(args);
  }
}

/**
 * `tr` — translate/delete/squeeze characters. The simplest filter of all: it
 * reads ONLY from stdin and writes ONLY to stdout — it never names, opens, or
 * writes a file. Its positionals are SET1 [SET2], pure character-set data (e.g.
 * `'\n' ' '`, `'a-z' 'A-Z'`), never filesystem paths.
 *
 * Because tr touches no files, top-level and sink safety are identical: validate
 * the flag prefix (reject anything unknown, conservatively) and accept any
 * positional sets. None of tr's flags take a value or write.
 */
class TrHandler extends CommandHandler {
  static commandName = 'tr';

  /** Long flags, all valueless and non-writing. */
  static BOOL_LONG = new Set([
    '--complement', '--delete', '--squeeze-repeats', '--truncate-set1'
  ]);

  /** Short cluster letters, all valueless and non-writing. */
  static BOOL_SHORT = 'cCdst';

  /**
   * Validate the flag prefix. tr has no value-taking flags, so the only job is
   * to reject an unrecognised flag; everything after the first non-flag (or
   * `--`) is a positional SET, which is pure data.
   * @param {string[]} args args
   * @returns {boolean} true if every flag is recognised
   */
  static _flagsOk(args) {
    for (let i = 0; i < args.length; i++) {
      const a = checkedAt(args, i);
      if (a === '--') return true;
      if (!a.startsWith('-') || a === '-') return true;

      if (a.startsWith('--')) {
        if (!TrHandler.BOOL_LONG.has(a)) return false;
        continue;
      }
      for (const ch of a.slice(1)) {
        if (!TrHandler.BOOL_SHORT.includes(ch)) return false;
      }
    }
    return true;
  }

  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) { return TrHandler._flagsOk(args); }

  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) { return TrHandler._flagsOk(args); }
}

class CatHandler extends CommandHandler {
  // `cat` of arbitrary files is a leak risk for `.env`, `.git/config`, etc.
  // As a top-level command each file operand must be an in-project path. Bare
  // `cat` (no operand) is a pure stdin→stdout copy that touches no file, so it
  // is read-only and safe — this is the writer form `cat > <permitted> <<EOF`
  // reduces to once the heredoc body and the (separately gated) output redirect
  // are stripped. As a sink the input comes from the pipe, so we accept no args.
  static commandName = 'cat';
  /**
   * cat takes no value flags — every non-flag arg is a file path (`-` is stdin).
   * Any other flag (`-n`, `-A`, …) marks the shape unsafe (null). Zero args is a
   * distinct case (bare stdin→stdout) handled by the callers, not here.
   * @param {string[]} args args
   * @returns {string[] | null} file path args, or null on an unsafe flag / no args
   */
  static pathArgs(args) {
    if (args.length === 0) return null;
    for (const a of args) {
      if (a.startsWith('-') && a !== '-') return null;
    }
    return args;
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    // Bare `cat` reads stdin and writes stdout — no path operand, nothing to
    // leak. It is read-only and safe on its own, and is what a permitted-target
    // writer (`cat > file`, `cat >> file`, heredoc/stdin in) reduces to after
    // the output redirect is stripped by isStrippableRedirectTarget.
    if (args.length === 0) return true;
    const paths = CatHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }
  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) { return args.length === 0; }
}

/**
 * `tee [-a] [-i] [-p] [FILE...]` — copy stdin to stdout and to each FILE.
 *
 * Unlike the read-only file handlers, tee's operands are WRITE destinations, so
 * it is gated exactly like an output redirect (see {@link
 * isStrippableRedirectTarget}): safe only when file-writing is enabled for the
 * conversation AND every FILE resolves inside the allowed roots. This is the
 * pipe-sink twin of `cmd > <permitted>` — `make 2>&1 | tee build.log` writes
 * only where the LLM is already permitted to write. Bare `tee` (no FILE) writes
 * to stdout alone: a read-only stdin→stdout passthrough, safe on its own and as
 * a sink regardless of write permission.
 *
 * Only the boolean short flags `-a` (append), `-i` (ignore SIGINT), `-p`, their
 * `--append` / `--ignore-interrupts` long forms, and a `--` terminator are
 * recognised; any value-taking or unknown flag (e.g. `--output-error=MODE`)
 * marks the shape unsafe so nothing slips past as a filename.
 */
class TeeHandler extends CommandHandler {
  static commandName = 'tee';
  /**
   * Return tee's file operands (its write targets), or null on an unrecognised
   * flag. Every operand is a path; there are no positional non-path args.
   * @param {string[]} args args
   * @returns {string[] | null} file operands, or null on an unsafe flag
   */
  static pathArgs(args) {
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '-') {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (a === '--append' || a === '--ignore-interrupts') { i++; continue; }
      if (!/^-[aip]+$/.test(a)) return null;
      i++;
    }
    return args.slice(i);
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx | RedirectCfg} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = TeeHandler.pathArgs(args);
    if (paths === null) return false;
    // Bare tee: stdin → stdout only, no file written. Read-only.
    if (paths.length === 0) return true;
    // Writing to files: gated on write-permission, and every target in-project
    // — the same policy the `>`/`>>` redirect strip enforces.
    if (!ctx || !ctx.writeEnabled) return false;
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots || [], ctx.home || '', ctx.platform || '')) return false;
    }
    return true;
  }
  /**
   * As a pipe sink (`… | tee FILE`) tee still writes FILE, so the same
   * write-permission + in-project gating applies. `cfg` carries that policy.
   * @param {string[]} args args
   * @param {RedirectCfg} [cfg] redirect policy
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args, cfg) { return TeeHandler.isSafe(args, cfg || {}); }
}

/**
 * `grep` — read-only pattern matching. Reject anything that writes (none of
 * grep's flags write by default, but we still whitelist conservatively):
 *   - `-f FILE` (pattern from file) — value is a path; require in-project.
 *   - `--include`, `--exclude`, `-A`, `-B`, `-C` take a value.
 *   - All other flags must come from a short-letter whitelist.
 *
 * As a top-level command, requires at least one in-project path (or `-r` /
 * `-R` recursive starting at an in-project path). As a sink, just needs a
 * pattern.
 */
class GrepHandler extends CommandHandler {
  static commandName = 'grep';

  /** Short flags safe in any cluster (`-iE`, `-rn`, etc.). */
  static SHORT_FLAGS = 'EFGPHhIilLnoqRrsvwxaczZ';

  /** Long flags with no value. */
  static LONG_FLAGS_NOVAL = new Set([
    '--basic-regexp', '--extended-regexp', '--fixed-strings', '--perl-regexp',
    '--ignore-case', '--no-ignore-case', '--invert-match', '--word-regexp',
    '--line-regexp', '--count', '--files-with-matches', '--files-without-match',
    '--no-filename', '--with-filename', '--line-number', '--only-matching',
    '--quiet', '--silent', '--recursive', '--dereference-recursive',
    '--no-messages', '--null-data', '--null', '--text', '--binary-files',
    '--line-buffered', '--color', '--colour', '--no-color', '--no-colour',
    '--initial-tab', '--byte-offset'
  ]);

  /** Long flags that take a value (either `--key=val` or `--key val`). */
  static LONG_FLAGS_VALUED = new Set([
    '--after-context', '--before-context', '--context',
    '--max-count', '--regexp', '--file',
    '--include', '--exclude', '--exclude-from', '--exclude-dir', '--include-dir',
    '--label', '--devices', '--directories', '--group-separator'
  ]);

  /**
   * Walk grep args and split into (consumed-up-to index, remaining positionals).
   * Returns null on any unknown / unsafe flag.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {string[] | null} positional args after flag-parsing, or null on reject
   */
  static _parseFlags(args, ctx) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (!a.startsWith('-') || a === '-' || a === '--') {
        if (a === '--') i++;
        break;
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (GrepHandler.LONG_FLAGS_NOVAL.has(flag)) { i++; continue; }
        if (GrepHandler.LONG_FLAGS_VALUED.has(flag)) {
          if (eq === -1) {
            if (i + 1 >= args.length) return null;
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        return null;
      }
      // Short cluster, possibly with attached numeric value (e.g. -A3).
      const cluster = a.slice(1);
      // `-A`, `-B`, `-C`, `-m`, `-e`, `-f`, `-d` (--directories), `-D`
      // (--devices) may take a value (attached or next arg).
      const valFlags = 'ABCmefdD';
      let consumed = false;
      for (let k = 0; k < cluster.length; k++) {
        const ch = checkedAt(cluster, k);
        if (!GrepHandler.SHORT_FLAGS.includes(ch) && !valFlags.includes(ch)) return null;
        if (valFlags.includes(ch)) {
          // Value is either the rest of the cluster or the next arg.
          const rest = cluster.slice(k + 1);
          if (rest.length > 0) {
            if (ch === 'f' && !isPathInsideAllowedRoots(rest, ctx.allowedRoots, ctx.home, ctx.platform)) return null;
          } else {
            if (i + 1 >= args.length) return null;
            const val = checkedAt(args, i + 1);
            if (ch === 'f' && !isPathInsideAllowedRoots(val, ctx.allowedRoots, ctx.home, ctx.platform)) return null;
            i++;
          }
          consumed = true;
          break;
        }
      }
      i++;
      if (consumed) continue;
    }
    return args.slice(i);
  }

  /**
   * Top-level: `grep [flags] PATTERN [path-in-project ...]`. Pattern is
   * positional[0] unless supplied via `-e`/`-f`. We require at least one
   * in-project path, OR a recursive flag (`-r` / `-R` / `--recursive`).
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const isRecursive = args.some(a => a === '-r' || a === '-R' || a === '--recursive' || a === '--dereference-recursive' || (a.startsWith('-') && !a.startsWith('--') && /[rR]/.test(a)));
    const positionals = GrepHandler._parseFlags(args, ctx);
    if (positionals === null) return false;
    // A single path-looking positional is almost always a mistaken/file-intended
    // grep invocation (`grep /tmp/foo`). Treat it as a path obstacle for approval
    // rather than letting a broad `grep *` pattern bless it.
    if (positionals.length === 1 && (checkedAt(positionals, 0).startsWith('/') || checkedAt(positionals, 0).startsWith('~/'))) {
      return isPathInsideAllowedRoots(checkedAt(positionals, 0), ctx.allowedRoots, ctx.home, ctx.platform);
    }
    // Drop the pattern (first positional) if present.
    const paths = positionals.slice(1);
    if (paths.length === 0) {
      // No paths supplied. Only safe if recursive (defaults to cwd, which
      // we treat as project) and a pattern was given.
      if (positionals.length === 0) return false;
      return isRecursive;
    }
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * Sink: `... | grep [flags] PATTERN`. No input paths needed; still reject
   * `-f FILE` (pattern loaded from a file). A positional grep pattern may itself
   * start with `-` (for example `grep -E "--- FAIL|^ok"`); in sink position
   * that is still read-only, so an unrecognised dash-leading token is treated as
   * the pattern rather than as a fatal option parse error.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    let i = 0;
    let sawPattern = false;

    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;

      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (flag === '--file') return false;
        if (GrepHandler.LONG_FLAGS_NOVAL.has(flag)) { i++; continue; }
        if (GrepHandler.LONG_FLAGS_VALUED.has(flag)) {
          if (eq === -1) {
            if (i + 1 >= args.length) return false;
            i += 2;
          } else {
            i++;
          }
          if (flag === '--regexp') sawPattern = true;
          continue;
        }
        break; // dash-leading pattern, not a recognised option
      }

      const cluster = a.slice(1);
      const valFlags = 'ABCmefdD';
      let consumed = false;
      let invalid = false;
      for (let k = 0; k < cluster.length; k++) {
        const ch = checkedAt(cluster, k);
        if (ch === 'f') return false;
        if (!GrepHandler.SHORT_FLAGS.includes(ch) && !valFlags.includes(ch)) { invalid = true; break; }
        if (valFlags.includes(ch)) {
          if (cluster.slice(k + 1).length === 0) {
            if (i + 1 >= args.length) return false;
            i++;
          }
          if (ch === 'e') sawPattern = true;
          consumed = true;
          break;
        }
      }
      if (invalid) break; // dash-leading pattern, not a recognised option cluster
      i++;
      if (consumed) continue;
    }

    const positionals = args.slice(i);
    if (sawPattern) return positionals.length === 0;
    return positionals.length === 1;
  }

  /**
   * grep emits file PATHS only under `-l` / `-L`
   * (`--files-with-matches` / `--files-without-match`); without them it prints
   * matching lines (content), which are not paths. When listing files, isSafe
   * has already confirmed every searched location is in-project (explicit path
   * args in-project, or recursive over the project cwd), so the emitted paths
   * are in-project too.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {'inProjectPath' | null} output-path domain
   */
  static outputPathDomain(args, ctx) {
    const listsFiles = args.some(a =>
      a === '--files-with-matches' || a === '--files-without-match' ||
			(a.startsWith('-') && !a.startsWith('--') && a.length > 1 && /[lL]/.test(a.slice(1))));
    if (!listsFiles) return null;
    return GrepHandler.isSafe(args, ctx) ? 'inProjectPath' : null;
  }

  /**
   * grep's path arguments are its search paths (positionals after the pattern).
   * The flag prefix (including `-f FILE`) must parse cleanly first — a flag-level
   * reject is not a path grant. The recursive / no-path form has no search-path
   * argument, so it yields `[]` (not a path obstacle).
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {string[] | null} search paths, or null on an unsafe flag
   */
  static pathArgs(args, ctx) {
    const positionals = GrepHandler._parseFlags(args, ctx);
    if (positionals === null) return null;
    if (positionals.length === 1 && (checkedAt(positionals, 0).startsWith('/') || checkedAt(positionals, 0).startsWith('~/'))) {
      return [checkedAt(positionals, 0)];
    }
    return positionals.slice(1); // drop the pattern
  }
}

class FileHandler extends CommandHandler {
  static commandName = 'file';
  /**
   * Every non-flag arg is a path to inspect; any flag marks the shape unsafe.
   * @param {string[]} args args
   * @returns {string[] | null} path args, or null on an unsafe flag / no args
   */
  static pathArgs(args) {
    if (args.length === 0) return null;
    for (const a of args) {
      if (a.startsWith('-') && a !== '-') return null;
    }
    return args;
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = FileHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }
}

class StatHandler extends CommandHandler {
  static commandName = 'stat';
  /**
   * Walk stat's flag prefix (`-f`/`-c FMT`, `--printf`/`--format`, and the
   * boolean `-LftxsZ` cluster), then return the trailing positional file paths,
   * or null on an unrecognised flag, a missing value, or no paths.
   * @param {string[]} args args
   * @returns {string[] | null} path args, or null on reject
   */
  static pathArgs(args) {
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '-') {
      const a = checkedAt(args, i);
      // `-f FMT` (BSD) / `-c FMT` (GNU) take a format string.
      if (a === '-f' || a === '-c') {
        if (i + 1 >= args.length) return null;
        i += 2;
        continue;
      }
      if (a.startsWith('--printf=') || a.startsWith('--format=')) { i++; continue; }
      if (a === '--printf' || a === '--format') {
        if (i + 1 >= args.length) return null;
        i += 2;
        continue;
      }
      if (!/^-[LftxsZ]+$/.test(a)) return null;
      i++;
    }
    const paths = args.slice(i);
    if (paths.length === 0) return null;
    return paths;
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = StatHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }
}

/**
 * `test` / `[` — POSIX conditional-expression evaluator.
 *
 * A pure predicate: it evaluates an expression and yields only an exit code. It
 * never writes and never spawns a subprocess (command substitution / backticks
 * already bail at tokenize time, so an operand can only be a literal). The one
 * residual concern is disclosure: a file-test operator (`-f`, `-x`, …) reveals
 * via its exit code whether a path exists or is readable. To stay consistent
 * with the read-only file handlers (`ls`, `cat`, `stat`, `file`), every path
 * operand must lie inside the allowed roots — so `test` can't be used as a
 * 1-bit oracle to probe `~/.ssh` or `/etc`.
 *
 * Deliberately conservative grammar — the primary expression forms only (no
 * `-a`/`-o` conjunction, no parenthesised groups), with an optional leading `!`:
 *   - 0 args                 → false (inert)
 *   - `STRING`               → string-non-empty test (no FS)
 *   - `-n`/`-z STRING`       → string-length test (no FS)
 *   - `<file-op> PATH`       → `-e -f -d -r -w -x -s …`; PATH must be in-project
 *   - `A = B` / `A != B`     → string comparison (no FS)
 *   - `A <int-op> B`         → `-eq … -ge`; both operands integers
 *   - `A <file-op2> B`       → `-nt -ot -ef`; both operands in-project paths
 *
 * The `[` form is the same grammar with a required trailing `]` (see
 * {@link BracketHandler}).
 */
class TestHandler extends CommandHandler {
  static commandName = 'test';

  /** Unary operators whose operand is a filesystem path (must be in-project). */
  static FILE_UNARY = new Set([
    '-e', '-f', '-d', '-r', '-w', '-x', '-s', '-L', '-h',
    '-b', '-c', '-p', '-S', '-g', '-u', '-k', '-O', '-G', '-N'
  ]);
  /** Unary operators whose operand is a plain string (no FS access). */
  static STRING_UNARY = new Set(['-n', '-z']);
  /** Binary operators comparing two filesystem paths (both must be in-project). */
  static FILE_BINARY = new Set(['-nt', '-ot', '-ef']);
  /** Binary operators comparing two integers. */
  static INT_BINARY = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
  /** Binary operators comparing two strings (no FS access). */
  static STR_BINARY = new Set(['=', '!=']);

  /**
   * Reduce raw args to the bare expression: `test` passes them through; `[`
   * overrides to require and drop a trailing `]`. Returns null on a malformed
   * bracket form.
   * @param {string[]} args args
   * @returns {string[] | null} expression words, or null if malformed
   */
  static expr(args) { return args; }

  /**
   * The expression with its bracket wrapper and a single leading `!` removed.
   * @param {string[]} args args
   * @returns {string[] | null} core expression words, or null if malformed
   */
  static _primary(args) {
    const e = this.expr(args);
    if (e === null) return null;
    return e[0] === '!' ? e.slice(1) : e;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const expr = this._primary(args);
    if (expr === null) return false;
    // 0 args (false) / 1 arg (string-non-empty) touch no filesystem.
    if (expr.length <= 1) return true;
    if (expr.length === 2) {
      const op = checkedAt(expr, 0);
      const operand = checkedAt(expr, 1);
      if (this.STRING_UNARY.has(op)) return true;
      if (this.FILE_UNARY.has(op)) return isPathInsideAllowedRoots(operand, ctx.allowedRoots, ctx.home, ctx.platform);
      return false;
    }
    if (expr.length === 3) {
      const a = checkedAt(expr, 0);
      const op = checkedAt(expr, 1);
      const b = checkedAt(expr, 2);
      if (this.STR_BINARY.has(op)) return true;
      if (this.INT_BINARY.has(op)) return /^-?\d+$/.test(a) && /^-?\d+$/.test(b);
      if (this.FILE_BINARY.has(op)) {
        return isPathInsideAllowedRoots(a, ctx.allowedRoots, ctx.home, ctx.platform) &&
          isPathInsideAllowedRoots(b, ctx.allowedRoots, ctx.home, ctx.platform);
      }
      return false;
    }
    return false;
  }

  /**
   * The path operands of file-test operators, so an out-of-root path yields a
   * folder-grant remedy (like `stat`/`file`) rather than a `test *` wildcard.
   * @param {string[]} args args
   * @returns {string[] | null} path operands, [] when none, or null if malformed
   */
  static pathArgs(args) {
    const expr = this._primary(args);
    if (expr === null) return null;
    if (expr.length === 2 && this.FILE_UNARY.has(checkedAt(expr, 0))) return [checkedAt(expr, 1)];
    if (expr.length === 3 && this.FILE_BINARY.has(checkedAt(expr, 1))) return [checkedAt(expr, 0), checkedAt(expr, 2)];
    return [];
  }
}

/**
 * `[ … ]` — the bracket spelling of {@link TestHandler}. Identical grammar with
 * a mandatory closing `]`.
 */
class BracketHandler extends TestHandler {
  static commandName = '[';
  /**
   * @param {string[]} args args
   * @returns {string[] | null} expression words without the `]`, or null if absent
   */
  static expr(args) {
    if (args.length === 0 || args[args.length - 1] !== ']') return null;
    return args.slice(0, -1);
  }
}

/**
 * `find` predicate-tree validator.
 *
 * Allows read-only traversal; rejects every action that runs a subprocess or
 * mutates the filesystem (`-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`,
 * `-fprint`, `-fprintf`, `-fls`). Predicates that take a value consume the
 * next token. Values containing `$`/backticks already bail at tokenize time.
 */
class FindHandler extends CommandHandler {
  static commandName = 'find';

  static FORBIDDEN = new Set([
    '-exec', '-execdir', '-ok', '-okdir',
    '-delete',
    '-fprint', '-fprintf', '-fls', '-fprint0'
  ]);

  /** Predicates that take exactly one following value argument. */
  static VALUE_PREDICATES = new Set([
    '-name', '-iname', '-lname', '-ilname',
    '-path', '-ipath', '-wholename', '-iwholename',
    '-regex', '-iregex', '-regextype',
    '-type', '-xtype',
    '-maxdepth', '-mindepth',
    '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin',
    '-newer', '-anewer', '-cnewer',
    '-user', '-group', '-uid', '-gid',
    '-perm', '-inum', '-links',
    '-context'
  ]);

  /** Standalone predicates / flags. */
  static FLAG_PREDICATES = new Set([
    '-print', '-print0', '-ls', '-prune', '-quit',
    '-empty', '-nouser', '-nogroup',
    '-readable', '-writable', '-executable',
    '-true', '-false',
    '-depth', '-follow', '-mount', '-xdev', '-noleaf',
    '-ignore_readdir_race', '-noignore_readdir_race'
  ]);

  /**
   * Boolean / grouping operators. Grouping parens must be quoted or
   * backslash-escaped on the command line (a bare `(` is subshell syntax the
   * tokenizer treats as a control operator), but either way they arrive here
   * as word tokens with the text `(` / `)`.
   */
  static BOOL_OPS = new Set([
    '-and', '-a', '-or', '-o', '-not', '!', '(', ')', ','
  ]);

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    if (args.length === 0) return false;

    // Leading global options: -H / -L / -P, plus -D X / -O N (rare).
    let i = 0;
    while (i < args.length && /^-[HLP]$/.test(checkedAt(args, i))) i++;
    if (i < args.length && (checkedAt(args, i) === '-D' || checkedAt(args, i) === '-O')) {
      if (i + 1 >= args.length) return false;
      i += 2;
    }

    // Starting-point paths (zero or more). All must be in-project.
    while (i < args.length && !checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '!' && checkedAt(args, i) !== '(') {
      if (!isPathInsideAllowedRoots(checkedAt(args, i), ctx.allowedRoots, ctx.home, ctx.platform)) return false;
      i++;
    }

    // Predicate tree.
    while (i < args.length) {
      const tok = checkedAt(args, i);

      if (FindHandler.FORBIDDEN.has(tok)) return false;
      // Defensive: refuse any `-fprint*` / `-fls` variant we missed.
      if (tok.startsWith('-fprint') || tok === '-fls') return false;

      if (FindHandler.BOOL_OPS.has(tok)) { i++; continue; }
      if (FindHandler.FLAG_PREDICATES.has(tok)) { i++; continue; }
      if (FindHandler.VALUE_PREDICATES.has(tok)) {
        if (i + 1 >= args.length) return false;
        i += 2;
        continue;
      }
      return false;
    }
    return true;
  }

  /**
   * find prints its matched PATHS by default, and isSafe has confirmed the
   * starting-point paths are in-project — so the output is in-project paths.
   * `-ls` switches to `ls -l`-style detail (not clean paths), so it's excluded
   * from path-domain use. (`-printf` / `-fprint*` are already rejected by
   * isSafe, so no custom format can reach here.)
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {'inProjectPath' | null} output-path domain
   */
  static outputPathDomain(args, ctx) {
    if (args.some(a => a === '-ls')) return null;
    return FindHandler.isSafe(args, ctx) ? 'inProjectPath' : null;
  }

  /**
   * find's path arguments are its starting-point paths (parsed exactly as
   * isSafe parses them, before the predicate tree). segmentRemedies re-runs the
   * full safety check with these granted, so a forbidden predicate elsewhere
   * (`-exec`, `-delete`) still suppresses the grant.
   * @param {string[]} args args
   * @returns {string[] | null} starting-point paths, or null if unparseable
   */
  static pathArgs(args) {
    if (args.length === 0) return null;
    let i = 0;
    while (i < args.length && /^-[HLP]$/.test(checkedAt(args, i))) i++;
    if (i < args.length && (checkedAt(args, i) === '-D' || checkedAt(args, i) === '-O')) {
      if (i + 1 >= args.length) return null;
      i += 2;
    }
    /** @type {string[]} */
    const paths = [];
    while (i < args.length && !checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '!' && checkedAt(args, i) !== '(') {
      paths.push(checkedAt(args, i));
      i++;
    }
    return paths;
  }
}

/**
 * `sed` — stream editor restricted to print/extract operations.
 *
 * Allowed flags: `-n` (quiet), `-E` / `-r` (extended regex), `-s` (separate
 * files), `-l N` (line-wrap length). Rejected: `-i` (in-place edit, both GNU
 * and BSD forms), `-f` (script from file — leak risk).
 *
 * Scripts (positional arg or `-e ARG`) must be "print/extract only" per
 * {@link isSafeSedScript}: address + a single safe command from
 * `p/d/n/N/=/l/q/Q/h/H/g/G/x/y/s`. Any sed command that writes a file or
 * runs a shell command (`w`, `W`, `r`, `R`, `e`) is rejected.
 *
 * Trailing arguments must be in-project paths; reading stdin (no path arg)
 * is also allowed.
 */
class SedHandler extends CommandHandler {
  static commandName = 'sed';

  /** Top-level flags that take no value. */
  static BOOL_FLAGS = new Set(['-n', '-E', '-r', '-s', '--posix']);

  /**
   * Split top-level args into scripts + trailing file paths, validating the
   * flag grammar (reject `-i` in-place, `-f` script-from-file, unknown flags,
   * value flags missing their value). Returns null on any reject. Does NOT
   * validate the scripts' safety — that's {@link isSafe}'s job; pathArgs only
   * needs the file paths.
   * @param {string[]} args args
   * @returns {{scripts: string[], paths: string[]} | null} parsed parts, or null
   */
  static _parse(args) {
    /** @type {string[]} */
    const scripts = [];
    let i = 0;
    let sawScript = false;

    // Parse flags + scripts in any order until first positional path.
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!a.startsWith('-')) {
        // First bare arg: treat as the script if we haven't seen one
        // yet via `-e`, else as a file path.
        if (!sawScript) {
          scripts.push(a);
          sawScript = true;
          i++;
          continue;
        }
        break;
      }
      if (SedHandler.BOOL_FLAGS.has(a)) { i++; continue; }
      if (a === '-e' || a === '--expression') {
        if (i + 1 >= args.length) return null;
        scripts.push(checkedAt(args, i + 1));
        sawScript = true;
        i += 2;
        continue;
      }
      if (a === '-l') {
        if (i + 1 >= args.length || !/^\d+$/.test(checkedAt(args, i + 1))) return null;
        i += 2;
        continue;
      }
      // Reject -i (in-place), -f (script-from-file), anything else.
      return null;
    }

    if (!sawScript) return null;
    return { scripts, paths: args.slice(i) };
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const parsed = SedHandler._parse(args);
    if (parsed === null) return false;
    for (const s of parsed.scripts) {
      if (!isSafeSedScript(s)) return false;
    }
    // Remaining positionals are file paths — must be in-project.
    for (const p of parsed.paths) {
      if (!isPathInsideAllowedRoots(p, ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * The trailing file-path positionals. The flag/script grammar must parse
   * cleanly first; segmentRemedies re-verifies script safety with the grant.
   * @param {string[]} args args
   * @returns {string[] | null} file paths, or null on reject
   */
  static pathArgs(args) {
    const parsed = SedHandler._parse(args);
    return parsed === null ? null : parsed.paths;
  }

  /**
   * Sink form: `... | sed [flags] SCRIPT`. Stdin supplies the input, so we
   * don't need file path args (and reject them if present — there's no
   * legitimate sink usage that names a file). Flag/script parsing mirrors
   * the top-level form; `-i` and `-f` are still rejected.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    /** @type {string[]} */
    const scripts = [];
    let i = 0;
    let sawScript = false;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!a.startsWith('-')) {
        if (!sawScript) {
          scripts.push(a);
          sawScript = true;
          i++;
          continue;
        }
        return false; // no file args in sink form
      }
      if (SedHandler.BOOL_FLAGS.has(a)) { i++; continue; }
      if (a === '-e' || a === '--expression') {
        if (i + 1 >= args.length) return false;
        scripts.push(checkedAt(args, i + 1));
        sawScript = true;
        i += 2;
        continue;
      }
      if (a === '-l') {
        if (i + 1 >= args.length || !/^\d+$/.test(checkedAt(args, i + 1))) return false;
        i += 2;
        continue;
      }
      return false;
    }
    if (!sawScript) return false;
    if (i !== args.length) return false;
    for (const s of scripts) {
      if (!isSafeSedScript(s)) return false;
    }
    return true;
  }
}

/**
 * Validate a sed script for print/extract-only safety.
 *
 * Single-pass scanner. The safety boundary is purely "no command can write to
 * the filesystem or shell out" — i.e. no `w`, `W`, `r`, `R`, `e` command, and
 * no `w` flag on `s///` / `y///`. Everything else (addresses, label/branch
 * targets, text-arg commands like `a/i/c`, malformed-but-non-destructive
 * syntax) is treated as opaque: if sed errors on it at runtime that's fine,
 * the script still couldn't have written anything.
 *
 * The scanner skips over delimited regions (regex addresses, `s///` /
 * `y///` bodies, label names, branch targets) so their contents can't be
 * mistaken for command letters. After that, finding a top-level `w/W/r/R/e`
 * rejects the script.
 * @param {string} script script body
 * @returns {boolean} true if the script is safe
 */
function isSafeSedScript(script) {
  const s = script;
  if (!s || !s.trim()) return false;
  let i = 0;
  let sawCmd = false; // require at least one real command

  while (i < s.length) {
    const ch = checkedAt(s, i);

    // Whitespace / separators / negation / blocks — skip.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' ||
			ch === '!' || ch === '{' || ch === '}') {
      i++;
      continue;
    }

    // Comment to end of line.
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }

    // `/regex/` address.
    if (ch === '/') {
      i++;
      while (i < s.length && s[i] !== '/') {
        if (s[i] === '\\' && i + 1 < s.length) { i += 2; continue; }
        i++;
      }
      if (i >= s.length) return false;
      i++;
      continue;
    }

    // `\Xregex X` alt-delimiter address.
    if (ch === '\\' && i + 1 < s.length) {
      const d = s[i + 1];
      i += 2;
      while (i < s.length && s[i] !== d) {
        if (s[i] === '\\' && i + 1 < s.length) { i += 2; continue; }
        i++;
      }
      if (i >= s.length) return false;
      i++;
      continue;
    }

    // `$`-expansions: `${…}`, `$((…))`, `$NAME`. These resolve to opaque
    // values before sed runs — the tokenizer already accepted them as
    // safe value substitutions and rejected command substitution — so
    // skip the whole expansion. A bare `$` not starting an expansion is
    // sed's last-line address.
    if (ch === '$') {
      const nx = s[i + 1];
      if (nx === '{') {
        const close = s.indexOf('}', i + 2);
        if (close === -1) return false;
        i = close + 1;
        continue;
      }
      if (nx === '(' && s[i + 2] === '(') {
        let depth = 0;
        let k = i + 1;
        for (; k < s.length; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0) return false;
        i = k + 1;
        continue;
      }
      if (nx && /[A-Za-z0-9_]/.test(nx)) {
        i += 2;
        while (i < s.length && /[A-Za-z0-9_]/.test(checkedAt(s, i))) i++;
        continue;
      }
      i++; // bare `$` — last-line address
      continue;
    }

    // Address atoms: digits, `,`, GNU `~` / `+` step forms.
    if ((ch >= '0' && ch <= '9') || ch === ',' ||
			ch === '~' || ch === '+') {
      i++;
      continue;
    }

    // Forbidden commands — anything that touches the FS or shells out.
    if (ch === 'w' || ch === 'W' || ch === 'r' || ch === 'R' || ch === 'e') {
      return false;
    }

    // `s` / `y` with delimited body.
    if (ch === 's' || ch === 'y') {
      const delim = checkedAt(s, i + 1);
      if (!delim || delim === ' ' || delim === '\t' || delim === '\n' ||
				delim === ';' || delim === '\\') return false;
      let j = i + 2;
      let fields = 0;
      while (j < s.length && fields < 2) {
        if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
        if (s[j] === delim) { fields++; j++; continue; }
        j++;
      }
      if (fields < 2) return false;
      let flags = '';
      while (j < s.length && s[j] !== ' ' && s[j] !== '\t' &&
				s[j] !== '\n' && s[j] !== ';' && s[j] !== '}') {
        flags += s[j++];
      }
      if (ch === 's') {
        if (!/^[gpimMI0-9]*$/.test(flags)) return false;
      } else if (flags !== '') {
        return false;
      }
      i = j;
      sawCmd = true;
      continue;
    }

    // `:label` definition.
    if (ch === ':') {
      i++;
      while (i < s.length && /[A-Za-z0-9_]/.test(checkedAt(s, i))) i++;
      sawCmd = true;
      continue;
    }

    // Branch commands with optional label arg.
    if (ch === 'b' || ch === 't' || ch === 'T') {
      i++;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      while (i < s.length && /[A-Za-z0-9_]/.test(checkedAt(s, i))) i++;
      sawCmd = true;
      continue;
    }

    // Text-arg commands: `a`/`i`/`c` consume to end of line.
    if (ch === 'a' || ch === 'i' || ch === 'c') {
      i++;
      while (i < s.length && s[i] !== '\n') i++;
      sawCmd = true;
      continue;
    }

    // Simple commands with no arguments.
    if (ch === 'p' || ch === 'd' || ch === 'n' || ch === 'N' ||
			ch === '=' || ch === 'l' || ch === 'q' || ch === 'Q' ||
			ch === 'h' || ch === 'H' || ch === 'g' || ch === 'G' ||
			ch === 'x' || ch === 'P' || ch === 'D' || ch === 'F' ||
			ch === 'z') {
      i++;
      sawCmd = true;
      continue;
    }

    // Unrecognised character at this position — reject conservatively.
    return false;
  }
  return sawCmd;
}

/**
 * `awk` — pattern-action scripting language. Restricted to read-only scripts:
 * the script body must contain no I/O builtins (`system`, `getline`, `exec`,
 * `ENVIRON`) and no redirection operators (`>`, `>>`, or `|` other than the
 * logical `||`). String literals (`"…"`) and regex literals (`/…/`) are
 * stripped before the forbidden-token scan so a `>` or `|` *inside* a string
 * or regex doesn't trip the check. Flags: `-F sep` (field separator), `-v
 * name=value` (variable). `-f scriptfile` is rejected — same leak-risk
 * reasoning as `sed -f`. Trailing args are in-project file paths.
 */
class AwkHandler extends CommandHandler {
  static commandName = 'awk';

  /**
   * Parse leading flags and return `{scriptIdx, restStart}` or null on reject.
   * @param {string[]} args args
   * @returns {{scriptIdx: number, restStart: number} | null} parsed positions, or null on reject
   */
  static _parseFlags(args) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (a === '-F' || a === '-v') {
        if (i + 1 >= args.length) return null;
        if (a === '-v' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(checkedAt(args, i + 1))) return null;
        i += 2;
        continue;
      }
      if (a === '-f' || a === '--file') return null;
      if (a.startsWith('-F') && a.length > 2) { i++; continue; }
      if (a.startsWith('-v') && a.length > 2) {
        if (!/^-v[A-Za-z_][A-Za-z0-9_]*=/.test(a)) return null;
        i++;
        continue;
      }
      if (a.startsWith('-')) return null;
      return { scriptIdx: i, restStart: i + 1 };
    }
    return null;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const parsed = AwkHandler._parseFlags(args);
    if (!parsed) return false;
    if (!isSafeAwkScript(checkedAt(args, parsed.scriptIdx))) return false;
    for (let j = parsed.restStart; j < args.length; j++) {
      if (!isPathInsideAllowedRoots(checkedAt(args, j), ctx.allowedRoots, ctx.home, ctx.platform)) return false;
    }
    return true;
  }

  /**
   * Sink form: stdin supplies the input, so no trailing path args allowed.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const parsed = AwkHandler._parseFlags(args);
    if (!parsed) return false;
    if (parsed.restStart !== args.length) return false;
    return isSafeAwkScript(checkedAt(args, parsed.scriptIdx));
  }
}

/**
 * Validate an awk script body. Strips `"…"` strings (with `\"` escapes), `/…/`
 * regex literals, and `# … \n` comments — then scans the residue for tokens
 * that imply I/O or subprocess execution:
 *   - identifiers: `system`, `getline`, `exec`, `ENVIRON`
 *   - operators: `>` (and `>>`) other than the comparison `>=`, and `|` other
 *     than the logical `||`.
 *
 * Comparison operators (`<`, `<=`, `>=`), logical (`&&`, `||`), and numeric
 * arithmetic are all preserved. The whitelist is conservative — a script that
 * relies on bare `>` as numeric greater-than has to be rewritten to use `<`,
 * or the user can save it as a pattern. The trade is intentional.
 * @param {string} script script body
 * @returns {boolean} safe
 */
function isSafeAwkScript(script) {
  if (typeof script !== 'string' || script.length === 0) return false;
  let stripped = '';
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    if (ch === '"') {
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === '\\' && i + 1 < script.length) { i += 2; continue; }
        i++;
      }
      if (i < script.length) i++;
      stripped += '""';
      continue;
    }
    if (ch === '/') {
      i++;
      while (i < script.length && script[i] !== '/') {
        if (script[i] === '\\' && i + 1 < script.length) { i += 2; continue; }
        i++;
      }
      if (i < script.length) i++;
      stripped += '//';
      continue;
    }
    if (ch === '#') {
      while (i < script.length && script[i] !== '\n') i++;
      continue;
    }
    stripped += ch;
    i++;
  }
  if (/\b(?:system|getline|exec|ENVIRON)\b/.test(stripped)) return false;
  // `>` allowed only as `>=`; reject `>` and `>>` and any other `>`.
  if (/>(?!=)/.test(stripped)) return false;
  // `|` allowed only as `||`; reject single `|`.
  if (/(?<!\|)\|(?!\|)/.test(stripped)) return false;
  return true;
}

/**
 * `git` — read-only subcommands only.
 *
 * Top-level git options consumed first: `-C <in-project-path>`, `--no-pager`,
 * `--git-dir=<in-project>`. Rejects `-c name=value` (could disable safety
 * with e.g. `core.hooksPath`), `--exec-path=`, `--namespace=`, and unknown
 * top-level options.
 *
 * After options, the subcommand must be in {@link READ_ONLY_SUBCOMMANDS}.
 * For each subcommand, remaining args are validated per
 * {@link SAFE_FLAGS_BY_SUB}: an arg starting with `-` must match the
 * subcommand's flag whitelist; positionals must be a ref-shaped token or an
 * in-project path.
 */
class GitHandler extends CommandHandler {
  static commandName = 'git';

  static READ_ONLY_SUBCOMMANDS = new Set([
    'diff', 'log', 'show', 'status', 'branch', 'tag', 'rev-parse',
    'ls-files', 'ls-tree', 'cat-file', 'blame', 'describe',
    'shortlog', 'name-rev', 'reflog', 'whatchanged', 'grep', 'help',
    'version', 'config',
    'stash', 'remote', 'for-each-ref', 'rev-list',
    'submodule', 'worktree', 'merge-base', 'check-ignore',
    'count-objects', 'symbolic-ref'
  ]);

  /**
   * Per-subcommand whitelists for flags starting with `-`.
   * @type {Record<string, RegExp>}
   */
  static SAFE_FLAGS_BY_SUB = {
    diff: /^(?:--(?:name-only|name-status|stat|numstat|shortstat|summary|cached|staged|color(?:=[A-Za-z]+)?|no-color|patch|no-patch|unified=\d+|raw|word-diff(?:=[A-Za-z]+)?|ignore-all-space|ignore-space-change|ignore-space-at-eol|ignore-blank-lines|check|find-renames(?:=\d+%?)?|find-copies(?:=\d+%?)?|minimal|histogram|patience|no-prefix|src-prefix=[A-Za-z0-9_./-]+|dst-prefix=[A-Za-z0-9_./-]+|diff-filter=[A-Za-z*]+|exit-code|quiet|relative(?:=[A-Za-z0-9_./-]+)?|dirstat(?:=[A-Za-z0-9,=]+)?|text|full-index|ignore-submodules(?:=[a-z]+)?|submodule(?:=[a-z]+)?)|-U\d+|-w|-b|-W|-R|-M|-C|-r|-p|-s|-a|-q)$/,
    log: /^(?:--(?:oneline|graph|all|name-only|name-status|stat|numstat|shortstat|patch|no-patch|color(?:=[A-Za-z]+)?|no-color|format=[%A-Za-z0-9_:\- ]+|pretty(?:=[A-Za-z0-9_:%\- ]+)?|author=[A-Za-z0-9_@.\- ]+|since=[A-Za-z0-9_.\- :]+|until=[A-Za-z0-9_.\- :]+|after=[A-Za-z0-9_.\- :]+|before=[A-Za-z0-9_.\- :]+|grep=[A-Za-z0-9_.\- :]+|max-count=\d+|reverse|merges|no-merges|first-parent|follow|abbrev-commit|date=[A-Za-z0-9-]+|topo-order|date-order|decorate(?:=[A-Za-z]+)?|pickaxe-regex|pickaxe-all|diff-filter=[A-Za-z*]+|regexp-ignore-case|left-right|boundary|cherry-mark|cherry-pick|left-only|right-only|tags(?:=[A-Za-z0-9_*.-]+)?|branches(?:=[A-Za-z0-9_*.-]+)?|remotes(?:=[A-Za-z0-9_*.-]+)?|glob=[A-Za-z0-9_*./^-]+|ancestry-path|full-history|all-match|invert-grep|no-walk(?:=[a-z]+)?|walk-reflogs|simplify-by-decoration|simplify-merges|full-diff|diff-merges=[a-z-]+)|-n\d+|-p|-\d+|-[SG].+|-i)$/,
    show: /^(?:--(?:stat|name-only|name-status|color(?:=[A-Za-z]+)?|no-color|format=[%A-Za-z0-9_:\- ]+|pretty(?:=[A-Za-z0-9_:%\- ]+)?|abbrev-commit|patch|no-patch|raw|diff-filter=[A-Za-z*]+|unified=\d+|ignore-all-space|ignore-space-change)|-s|-p|-w|-b|-U\d+)$/,
    status: /^(?:--(?:short|porcelain(?:=[Av12]+)?|branch|long|untracked-files(?:=[a-z]+)?|ignored(?:=[a-z]+)?|column(?:=[A-Za-z]+)?|no-column|ahead-behind|no-ahead-behind)|-s|-b|-u(?:[a-z]+)?)$/,
    branch: /^(?:--(?:list|all|remotes|verbose|merged|no-merged|contains|no-contains|sort=[A-Za-z0-9_:-]+|color(?:=[A-Za-z]+)?|no-color|show-current|format=[%A-Za-z0-9_:\- ()]+)|-a|-r|-v|-vv|-l)$/,
    tag: /^(?:--(?:list|sort=[A-Za-z0-9_:-]+|contains|no-contains|merged|no-merged|color(?:=[A-Za-z]+)?|no-color|format=[%A-Za-z0-9_:\- ()]+)|-l|-n\d*)$/,
    'rev-parse': /^--[A-Za-z0-9][A-Za-z0-9=-]*$/,
    'ls-files': /^(?:--(?:cached|deleted|modified|others|ignored|stage|unmerged|directory|no-empty-directory|full-name|exclude-standard)|-c|-d|-m|-o|-i|-s|-u)$/,
    'ls-tree': /^(?:--(?:full-name|full-tree|name-only|name-status|abbrev(?:=\d+)?|long|object-only)|-r|-d|-l|-t|-z)$/,
    'cat-file': /^(?:--(?:batch(?:=[A-Za-z0-9_%\- ]+)?|batch-check(?:=[A-Za-z0-9_%\- ]+)?|allow-unknown-type)|-t|-s|-e|-p)$/,
    blame: /^(?:--(?:porcelain|incremental|line-porcelain|score-debug|root|date=[A-Za-z0-9-]+|color-lines|color-by-age|abbrev=\d+)|-L\d*(?:,\d+)?|-w|-f|-n|-s|-e|-p|-l|-t|-M|-C)$/,
    describe: /^(?:--(?:all|tags|contains|abbrev=\d+|candidates=\d+|exact-match|debug|long|match=[A-Za-z0-9_*.-]+|exclude=[A-Za-z0-9_*.-]+|always|first-parent|broken|dirty(?:=[A-Za-z0-9_-]+)?))$/,
    shortlog: /^(?:--(?:numbered|summary|email|format=[%A-Za-z0-9_:\- ]+|group=[A-Za-z]+)|-n|-s|-e)$/,
    'name-rev': /^(?:--(?:tags|refs=[A-Za-z0-9_*/-]+|all|stdin|name-only|no-undefined|always))$/,
    reflog: /^(?:--(?:all|date=[A-Za-z0-9-]+)|-n\d+)$/,
    whatchanged: /^(?:-p|--stat|--name-only|--name-status)$/,
    grep: /^(?:--(?:cached|untracked|no-index|recurse-submodules|fixed-strings|extended-regexp|basic-regexp|perl-regexp|invert-match|ignore-case|word-regexp|line-number|files-with-matches|count|color(?:=[A-Za-z]+)?|no-color|context=\d+|after-context=\d+|before-context=\d+)|-c|-i|-w|-n|-l|-L|-v|-E|-F|-G|-P|-A\d+|-B\d+|-C\d+)$/,
    help: /^.*$/,
    version: /^--build-options$/,
    // `git config --get NAME` only; --set / --unset / --add / --replace-all etc forbidden.
    config: /^--(?:get|get-all|get-regexp|list|name-only|show-origin|show-scope|local|global|system|worktree|file=.+|includes|no-includes|type=[A-Za-z]+)$/,
    // Purely read-only subcommands with their own flag whitelists.
    // (branch/tag/reflog/stash/remote/submodule/worktree/symbolic-ref are handled
    // specially above and never reach the generic flagRe path.)
    'for-each-ref': /^(?:--format=[%A-Za-z0-9_():.,/ -]+|--sort=[A-Za-z0-9_:,+-]+|--count=\d+|--(?:python|perl|tcl|shell|omit-empty|ignore-case))$/,
    'rev-list': /^(?:--(?:max-count=\d+|skip=\d+|since=[A-Za-z0-9_.\- :]+|until=[A-Za-z0-9_.\- :]+|after=[A-Za-z0-9_.\- :]+|before=[A-Za-z0-9_.\- :]+|all|branches(?:=[A-Za-z0-9_*.-]+)?|tags(?:=[A-Za-z0-9_*.-]+)?|remotes(?:=[A-Za-z0-9_*.-]+)?|glob=[A-Za-z0-9_*./^-]+|stdin|topo-order|date-order|reverse|ancestry-path|first-parent|merges|no-merges|min-parents=\d+|max-parents=\d+|count|abbrev(?:=\d+)?|oneline|header|parents|children|timestamps|left-right|boundary|cherry-mark|cherry-pick|left-only|right-only)|-n\d+|-\d+)$/,
    'merge-base': /^(?:--(?:all|octopus|independent|fork-point|is-ancestor))$/,
    'check-ignore': /^(?:--(?:verbose|non-matching|stdin|no-index|quiet)|-v|-n|-q|-z)$/,
    'count-objects': /^(?:--(?:verbose|human-readable)|-v|-H)$/
  };

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    let i = 0;
    // Top-level options before the subcommand.
    while (i < args.length && checkedAt(args, i).startsWith('-')) {
      const a = checkedAt(args, i);
      if (a === '--no-pager' || a === '--paginate' || a === '--no-replace-objects' || a === '--bare') { i++; continue; }
      if (a === '-C') {
        if (i + 1 >= args.length) return false;
        if (!isPathInsideAllowedRoots(checkedAt(args, i + 1), ctx.allowedRoots, ctx.home, ctx.platform)) return false;
        i += 2;
        continue;
      }
      if (a.startsWith('--git-dir=')) {
        if (!isPathInsideAllowedRoots(a.slice('--git-dir='.length), ctx.allowedRoots, ctx.home, ctx.platform)) return false;
        i++;
        continue;
      }
      if (a.startsWith('--work-tree=')) {
        if (!isPathInsideAllowedRoots(a.slice('--work-tree='.length), ctx.allowedRoots, ctx.home, ctx.platform)) return false;
        i++;
        continue;
      }
      // `-c name=value` could disable safety (e.g. core.hooksPath); reject.
      return false;
    }

    if (i >= args.length) return false;
    const sub = checkedAt(args, i++);
    if (!GitHandler.READ_ONLY_SUBCOMMANDS.has(sub)) return false;

    // `config` must be a read-only invocation. Reject any positional that
    // looks like a value (the writes are `git config NAME VALUE`).
    if (sub === 'config') {
      let sawGet = false;
      for (let j = i; j < args.length; j++) {
        const a = checkedAt(args, j);
        if (a.startsWith('-')) {
          if (!/** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB.config).test(a)) return false;
          if (/^--(get|get-all|get-regexp|list)/.test(a)) sawGet = true;
          continue;
        }
        // Bare positional: only allowed as the NAME for --get/--get-all/--get-regexp.
        if (!sawGet) return false;
      }
      return true;
    }

    // `branch` / `tag`: a bare positional without a consuming-flag context
    // would be a new branch or tag name (a write operation). Positionals are
    // only permitted as:
    //   - the ref value consumed by --contains/--no-contains/--merged/--no-merged
    //   - a glob pattern after --list/-l (filters the listing, never creates)
    if (sub === 'branch' || sub === 'tag') {
      const flagRe = /** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB[sub]);
      const REF_CONSUMING = new Set(['--contains', '--no-contains', '--merged', '--no-merged']);
      let wantRef = false;
      let listMode = false;
      for (let j = i; j < args.length; j++) {
        const a = checkedAt(args, j);
        if (a === '--') return false; // positionals after -- are branch/tag names
        if (a.startsWith('-')) {
          if (!flagRe.test(a)) return false;
          if (REF_CONSUMING.has(a)) { wantRef = true; continue; }
          if (a === '--list' || a === '-l') { listMode = true; continue; }
          continue;
        }
        if (wantRef) {
          if (!GitHandler.isSafePositional(a, ctx)) return false;
          wantRef = false;
          continue;
        }
        if (listMode) {
          // Glob pattern for --list (e.g. 'v1.*'): filters the listing, not a write.
          listMode = false;
          continue;
        }
        // No consuming-flag context: this positional is a new branch/tag name (write op).
        return false;
      }
      return true;
    }

    // `reflog`: the show/walk form is read-only; expire/delete/drop are destructive.
    if (sub === 'reflog') {
      const flagRe = /** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB.reflog);
      const DESTRUCTIVE_REFLOG = new Set(['expire', 'delete', 'drop']);
      let j = i;
      while (j < args.length && checkedAt(args, j).startsWith('-')) {
        if (!flagRe.test(checkedAt(args, j))) return false;
        j++;
      }
      if (j < args.length) {
        const first = checkedAt(args, j);
        if (DESTRUCTIVE_REFLOG.has(first)) return false;
        if (first === 'show') j++;
        for (let k = j; k < args.length; k++) {
          const a = checkedAt(args, k);
          if (a.startsWith('-')) {
            if (!flagRe.test(a)) return false;
          } else {
            if (!GitHandler.isSafePositional(a, ctx)) return false;
          }
        }
      }
      return true;
    }

    // `stash`: only 'list' and 'show' are read-only. Bare 'git stash' is
    // equivalent to 'stash push' and stashes working-tree changes (write op).
    if (sub === 'stash') {
      if (i >= args.length) return false;
      const stashSub = checkedAt(args, i++);
      if (stashSub === 'list') {
        for (let j = i; j < args.length; j++) {
          if (!/** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB.log).test(checkedAt(args, j))) return false;
        }
        return true;
      }
      if (stashSub === 'show') {
        const showFlags = /^(?:--(?:stat|numstat|shortstat|name-only|name-status|patch|no-patch|unified=\d+|diff-filter=[A-Za-z*]+|raw|color(?:=[A-Za-z]+)?|no-color)|-p|-U\d+|-s|-u|-w|-b)$/;
        for (let j = i; j < args.length; j++) {
          const a = checkedAt(args, j);
          if (a.startsWith('-')) {
            if (!showFlags.test(a)) return false;
          } else {
            if (!GitHandler.isSafePositional(a, ctx)) return false;
          }
        }
        return true;
      }
      return false; // push/pop/apply/drop/clear/branch → all write ops
    }

    // `remote`: only listing forms and two read queries are safe.
    if (sub === 'remote') {
      let j = i;
      if (j < args.length && (checkedAt(args, j) === '-v' || checkedAt(args, j) === '--verbose')) j++;
      if (j >= args.length) return true; // bare list or -v list
      const remoteSub = checkedAt(args, j++);
      if (remoteSub !== 'show' && remoteSub !== 'get-url') return false;
      for (let k = j; k < args.length; k++) {
        const a = checkedAt(args, k);
        if (a.startsWith('-')) return false;
        // Remote names are simple identifiers (no shell-special chars).
        if (!/^[A-Za-z0-9_.-]+$/.test(a)) return false;
      }
      return true;
    }

    // `submodule`: only 'status' and 'summary' are read-only.
    if (sub === 'submodule') {
      const smFlags = /^(?:--quiet|--recursive|-q)$/;
      let j = i;
      while (j < args.length && checkedAt(args, j).startsWith('-')) {
        if (!smFlags.test(checkedAt(args, j))) return false;
        j++;
      }
      if (j >= args.length) return false;
      const smSub = args[j++];
      if (smSub !== 'status' && smSub !== 'summary') return false;
      const smBodyFlags = /^(?:--recursive|--cached|--files|--summary-limit=\d+)$/;
      for (let k = j; k < args.length; k++) {
        const a = checkedAt(args, k);
        if (a.startsWith('-')) {
          if (!smBodyFlags.test(a)) return false;
        } else {
          if (!GitHandler.isSafePositional(a, ctx)) return false;
        }
      }
      return true;
    }

    // `worktree`: only 'list' is read-only.
    if (sub === 'worktree') {
      if (i >= args.length) return false;
      if (checkedAt(args, i++) !== 'list') return false;
      for (let j = i; j < args.length; j++) {
        if (!/^(?:--porcelain|-v|--verbose|-z)$/.test(checkedAt(args, j))) return false;
      }
      return true;
    }

    // `symbolic-ref`: the single-positional form reads a ref. Two positionals
    // is the write (set) form; --delete/-d is an explicit delete.
    if (sub === 'symbolic-ref') {
      const sfFlags = /^(?:--short|--quiet|-q)$/;
      let positionals = 0;
      for (let j = i; j < args.length; j++) {
        const a = checkedAt(args, j);
        if (a.startsWith('-')) {
          if (!sfFlags.test(a)) return false;
          continue;
        }
        if (++positionals > 1) return false; // two positionals = write form
      }
      return positionals === 1;
    }

    const flagRe = /** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB[sub]);
    if (!flagRe) return false;

    // Short flags that take a separate numeric value for select subcommands
    // (e.g. `git log -n 10`, `git diff -U 5`). Conservatively numeric so a
    // path can never be consumed as the value.
    const numericValueFlags = GitHandler.NUMERIC_VALUE_FLAGS_BY_SUB[sub] || null;

    let positionalsStart = false;
    for (let j = i; j < args.length; j++) {
      const a = checkedAt(args, j);
      if (a === '--') { positionalsStart = true; continue; }
      if (a.startsWith('-') && !positionalsStart) {
        if (numericValueFlags && numericValueFlags.has(a)) {
          if (j + 1 >= args.length || !/^\d+$/.test(checkedAt(args, j + 1))) return false;
          j++;
          continue;
        }
        if (!flagRe.test(a)) return false;
        continue;
      }
      if (!GitHandler.isSafePositional(a, ctx)) return false;
    }
    return true;
  }

  /**
   * git generalises in two tiers: subcommand-scoped (`git push *`) then
   * command-scoped (`git *`). The subcommand is the first token that isn't a
   * top-level option; if we can't find one, only the command-scoped tier is
   * offered.
   * @param {string[]} words segment words (`git` first)
   * @returns {string[]} generalisation patterns, narrowest→broadest
   */
  static suggestPatterns(words) {
    /** @type {string[]} */
    const out = [];
    let i = 1;
    // Skip a leading `-C <path>` pair and any other top-level options so the
    // subcommand is the first bare word we land on.
    while (i < words.length && checkedAt(words, i).startsWith('-')) {
      if (checkedAt(words, i) === '-C' && i + 1 < words.length) i += 2;
      else i++;
    }
    const sub = words[i];
    if (sub && !sub.startsWith('-')) out.push(`git ${sub} *`);
    out.push('git *');
    return out;
  }

  /**
   * Of the read-only subcommands, only `git ls-files` emits a list of
   * in-project repository paths; the others print content or metadata. isSafe
   * has already confirmed the invocation is read-only and in-project.
   * @param {string[]} args args (subcommand included)
   * @param {ApprovalCtx} ctx ctx
   * @returns {'inProjectPath' | null} output-path domain
   */
  static outputPathDomain(args, ctx) {
    if (!GitHandler.isSafe(args, ctx)) return null;
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-')) {
      if (checkedAt(args, i) === '-C' && i + 1 < args.length) i += 2;
      else i++;
    }
    return checkedAt(args, i) === 'ls-files' ? 'inProjectPath' : null;
  }

  /** @type {Record<string, Set<string>>} */
  static NUMERIC_VALUE_FLAGS_BY_SUB = {
    log: new Set(['-n']),
    diff: new Set(['-U']),
    blame: new Set(['-L'])
  };

  /**
   * Ref-shaped tokens: `HEAD`, `main`, `v1.2.3`, `origin/main`, `abc123^`,
   * `stash@{0}`, `HEAD@{1}` (reflog selectors).
   */
  static REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}:-]*$/;

  /**
   * @param {string} arg arg
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe positional
   */
  static isSafePositional(arg, ctx) {
    // Ref ranges: `A..B`, `A...B`. Either side may be empty.
    const rangeMatch = arg.match(/^(.*?)(\.{2,3})(.*)$/);
    if (rangeMatch && (rangeMatch[1] || rangeMatch[3])) {
      const [, left, , right] = rangeMatch;
      if (left && !GitHandler.REF_RE.test(left)) return GitHandler.isPathPositional(arg, ctx);
      if (right && !GitHandler.REF_RE.test(right)) return GitHandler.isPathPositional(arg, ctx);
      return true;
    }
    if (GitHandler.REF_RE.test(arg)) return true;
    return GitHandler.isPathPositional(arg, ctx);
  }

  /**
   * @param {string} arg arg
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} in-project path
   */
  static isPathPositional(arg, ctx) {
    return isPathInsideAllowedRoots(arg, ctx.allowedRoots, ctx.home, ctx.platform);
  }
}

/**
 * `xargs <safe-command> [pre-args...]` — runs a read-only command on tokens
 * read from stdin. The stdin tokens become trailing positional args of the
 * sub-command, so we cannot path-validate them; instead we restrict the
 * sub-command to a fixed allowlist of read-only handlers and validate every
 * pre-arg through that handler's own `isSafe` (with a sentinel root that
 * tolerates the trailing stdin args). The expected pipeline shape is
 * `<safe-producer> | xargs <safe-reader>`, e.g. `find … | xargs grep -l …`.
 *
 * xargs's own flags are restricted to read-only quoting/parallelism options:
 * `-0`, `--null`, `-r`, `--no-run-if-empty`, `-t`, `-P N`, `-n N`, `-L N`,
 * `-I STR`, `-d C`. Reject `-a FILE` (alt input), `-s` (size), `-E` and
 * everything else.
 */
class XargsHandler extends CommandHandler {
  static commandName = 'xargs';

  /** Sub-commands xargs may invoke. Must be read-only and in the registry. */
  static SAFE_SUBCOMMANDS = new Set(['grep', 'head', 'tail', 'wc', 'cat', 'file', 'stat', 'sed', 'ls', 'du', 'echo', 'printf']);

  /** xargs flags that take no value. */
  static BOOL_FLAGS = new Set(['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive']);

  /** xargs flags that take exactly one value. Value is restricted per flag. */
  static VALUE_FLAGS = new Set(['-n', '-L', '-P', '-I', '-d']);

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (XargsHandler.BOOL_FLAGS.has(a)) { i++; continue; }
      if (XargsHandler.VALUE_FLAGS.has(a)) {
        if (i + 1 >= args.length) return false;
        const v = checkedAt(args, i + 1);
        if (a === '-n' || a === '-L' || a === '-P') {
          if (!/^\d+$/.test(v)) return false;
        } else if (a === '-I') {
          if (!/^[A-Za-z_{}][A-Za-z0-9_{}]*$/.test(v)) return false;
        } else if (a === '-d') {
          if (v.length !== 1 && v !== '\\0' && v !== '\\n' && v !== '\\t') return false;
        }
        i += 2;
        continue;
      }
      // Anything else (including `-a FILE`, `-s N`, `-E STR`, unknown options) is rejected.
      if (a.startsWith('-')) return false;
      break;
    }

    if (i >= args.length) return false;
    const sub = checkedAt(args, i);
    if (!XargsHandler.SAFE_SUBCOMMANDS.has(sub)) return false;
    const subHandler = COMMAND_HANDLERS.get(sub);
    if (!subHandler) return false;

    // Validate the sub-command's pre-args. stdin-supplied args at runtime
    // are read-only filenames from the upstream segment (which we
    // validated independently), so we don't need to model them here —
    // but we must not let an injected `-f FILE` or out-of-project pre-arg
    // slip through. Use the sub-handler's own isSafe with the project ctx.
    const preArgs = args.slice(i + 1);
    return subHandler.isSafe(preArgs, ctx);
  }

  /**
   * xargs in sink position has the same rules.
   * @param {string[]} args args
   * @param {RedirectCfg} [cfg] redirect policy, forwarded to the sub-handler
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args, cfg) {
    // Approximate: when called as a sink we have no ctx for path checks.
    // Reject path-shaped pre-args by requiring every pre-arg either start
    // with `-` (matching the sub-handler's whitelist) or be a quoted
    // pattern with no `/`. The sub-handler's full validation runs at
    // top-level isSafe; here we accept the common pipeline shapes.
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-')) {
      if (XargsHandler.BOOL_FLAGS.has(checkedAt(args, i))) { i++; continue; }
      if (XargsHandler.VALUE_FLAGS.has(checkedAt(args, i))) {
        if (i + 1 >= args.length) return false;
        i += 2;
        continue;
      }
      return false;
    }
    if (i >= args.length) return false;
    const sub = checkedAt(args, i);
    if (!XargsHandler.SAFE_SUBCOMMANDS.has(sub)) return false;
    const subHandler = COMMAND_HANDLERS.get(sub);
    if (!subHandler) return false;
    // Delegate to the sub-handler's own sink check so `-f FILE` etc. are
    // still rejected. Forward cfg so a writing sub-sink (`tee`) can scope its
    // file operands against the allowed roots.
    return subHandler.isSafeAsSink(args.slice(i + 1), cfg);
  }
}

/** Registry — add a class and an entry here to support a new command. */
const COMMAND_HANDLERS = /** @type {Map<string, typeof CommandHandler>} */ (new Map([
  [PwdHandler.commandName, PwdHandler],
  [WhoamiHandler.commandName, WhoamiHandler],
  [IdHandler.commandName, IdHandler],
  [DateHandler.commandName, DateHandler],
  [TrueHandler.commandName, TrueHandler],
  [FalseHandler.commandName, FalseHandler],
  [ColonHandler.commandName, ColonHandler],
  [HostnameHandler.commandName, HostnameHandler],
  [UptimeHandler.commandName, UptimeHandler],
  [SleepHandler.commandName, SleepHandler],
  [UnameHandler.commandName, UnameHandler],
  [EchoHandler.commandName, EchoHandler],
  [PrintfHandler.commandName, PrintfHandler],
  [WhichHandler.commandName, WhichHandler],
  [TypeHandler.commandName, TypeHandler],
  [CommandBuiltinHandler.commandName, CommandBuiltinHandler],
  [CdHandler.commandName, CdHandler],
  [LsHandler.commandName, LsHandler],
  [DuHandler.commandName, DuHandler],
  [TailHandler.commandName, TailHandler],
  [HeadHandler.commandName, HeadHandler],
  [WcHandler.commandName, WcHandler],
  [SortHandler.commandName, SortHandler],
  [UniqHandler.commandName, UniqHandler],
  [CutHandler.commandName, CutHandler],
  [TrHandler.commandName, TrHandler],
  [CatHandler.commandName, CatHandler],
  [TeeHandler.commandName, TeeHandler],
  [FileHandler.commandName, FileHandler],
  [StatHandler.commandName, StatHandler],
  [TestHandler.commandName, TestHandler],
  [BracketHandler.commandName, BracketHandler],
  [FindHandler.commandName, FindHandler],
  [GrepHandler.commandName, GrepHandler],
  [SedHandler.commandName, SedHandler],
  [GitHandler.commandName, GitHandler],
  [AwkHandler.commandName, AwkHandler],
  [XargsHandler.commandName, XargsHandler]
]));

// ============================================================================
// Sink stripping (read-only tails)
// ============================================================================

/**
 * @typedef {{allowedRoots?: string[], writeEnabled?: boolean, home?: string, platform?: string}} RedirectCfg
 */

/**
 * Is a write/append redirect to `target` (`> target`, `>> target`, `2> target`)
 * safe to strip from a command for the purposes of static analysis?
 *
 * A redirect names an output *destination*; stripping it only removes where
 * output goes, never what the command does (the command words are still
 * validated independently). It is safe to strip when:
 *   - `target` is `/dev/null` — output is discarded; always inert; or
 *   - file-writing is enabled for this conversation (`writeEnabled`) AND
 *     `target` resolves inside an allowed path. This mirrors the write-file
 *     plugin (which grants writes when its permission is on) but is additionally
 *     path-scoped: a bash redirect may only write where the LLM is already
 *     allowed to write files.
 * @param {string} target the redirect target word
 * @param {RedirectCfg} [cfg] redirect policy
 * @returns {boolean} true if the redirect can be stripped
 */
function isStrippableRedirectTarget(target, cfg = {}) {
  if (target === '/dev/null') return true;
  return Boolean(cfg.writeEnabled) && isPathInsideAllowedRoots(target, cfg.allowedRoots || [], cfg.home || '', cfg.platform || '');
}

/**
 * Is the token sequence `<cmd> <args...>` a safe end-of-pipeline sink?
 *
 * Delegates to {@link CommandHandler.isSafeAsSink} on the handler registered
 * for `<cmd>`. The base class defaults `isSafeAsSink` to false, so any
 * handler that wants to participate must explicitly opt in by overriding.
 * A sink stage may carry its own safe redirects (`… 2>/dev/null`, `… >>log`
 * when writing is permitted); those are stripped first so a stage like
 * `xargs grep -l X 2>/dev/null` is still recognised as a clean sink.
 * @param {ShellToken[]} tokens tokens of the would-be sink pipeline tail
 * @param {RedirectCfg} [cfg] redirect policy (for stripping the stage's own redirects)
 * @returns {boolean} true if the tail is a safe sink
 */
function isSafeSinkTail(tokens, cfg = {}) {
  if (tokens.length === 0) return false;
  tokens = stripInlineSafeRedirects(tokens, cfg);
  if (tokens.length === 0) return false;
  if (tokens.some(t => t.type === 'op')) return false;
  // A sink stage is stripped-and-discarded from the pipeline, so it must not
  // carry anything we can't statically vouch for. Reject the stage (leaving the
  // pipe unstripped, which fails the segment) if any token holds a command
  // substitution — `producer | grep $(curl evil)` would otherwise strip the
  // sink and approve only the producer, never vetting the substitution — or an
  // unquoted expansion, which can word-split a value into an extra argument
  // (e.g. `… | grep $x` where `$x` becomes `PATTERN /etc/passwd`, turning a
  // read-only filter into an out-of-project file read).
  if (tokens.some(t => t.type === 'word'
			&& (/** @type {WordToken} */ (t).subst || /** @type {WordToken} */ (t).unquotedVar))) return false;
  const head = /** @type {WordToken} */ (tokens[0]);
  const handler = COMMAND_HANDLERS.get(head.text);
  if (!handler) return false;
  const args = /** @type {WordToken[]} */ (tokens.slice(1)).map(t => t.text);
  return handler.isSafeAsSink(args, cfg);
}

/**
 * Strip read-only output sinks from the tail of the token stream until no
 * more can be removed. Sinks: `2>&1`, `> <strippable>`, `2> <strippable>`,
 * `>> <strippable>`, `| <safe-sink>`, where `<strippable>` is `/dev/null` or,
 * when write permission is on, a target inside an allowed path (see
 * {@link isStrippableRedirectTarget}).
 *
 * Write redirects to a target that is neither `/dev/null` nor an allowed
 * write destination are deliberately not stripped — they remain as op tokens
 * and the segment will be rejected.
 * @param {ShellToken[]} tokens tokens to strip from
 * @param {RedirectCfg} [cfg] redirect policy
 * @returns {ShellToken[]} stripped tokens
 */
function stripTrailingSafeSinks(tokens, cfg = {}) {
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    const last = checkedAt(tokens, tokens.length - 1);

    if (last.type === 'op' && last.text === '2>&1') {
      tokens = tokens.slice(0, -1);
      changed = true;
      continue;
    }

    if (tokens.length >= 2) {
      const op = checkedAt(tokens, tokens.length - 2);
      const word = checkedAt(tokens, tokens.length - 1);
      if (op.type === 'op'
					&& (op.text === '>' || op.text === '2>' || op.text === '>>')
					&& word.type === 'word'
					&& isStrippableRedirectTarget(word.text, cfg)) {
        tokens = tokens.slice(0, -2);
        changed = true;
        continue;
      }
    }

    let pipeIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (checkedAt(tokens, i).type === 'op' && checkedAt(tokens, i).text === '|') { pipeIdx = i; break; }
    }
    if (pipeIdx !== -1 && isSafeSinkTail(tokens.slice(pipeIdx + 1), cfg)) {
      tokens = tokens.slice(0, pipeIdx);
      changed = true;
      continue;
    }
  }
  return tokens;
}

// ============================================================================
// Leading `cd <path> <sep>` stripping
// ============================================================================

/**
 * Strip a leading `cd <in-project-path> <sep>` — where `<sep>` is any top-level
 * command separator (`&&`, `||`, or `;`, the last also covering an unquoted
 * newline, which tokenises as `;`) — so the rest of the command is judged on its
 * own. All three separators are treated identically: a leading `cd <in-root>;`
 * (or newline-joined) `cd` is no less safe than the `&&` form, since the analysis
 * is directory-agnostic and every segment is validated independently. Only `&&`
 * used to be stripped here, which spuriously rejected `cd X; make` while
 * approving `cd X && make`.
 *
 * Returns `null` when a leading `cd` IS present but is not a cleanly-strippable
 * `cd <in-root> <sep>` — a bare `cd` (→ $HOME), `cd -`, or an out-of-root target.
 * `null` means "refuse", and each caller acts on it: the approval path rejects
 * (an out-of-project `cd` must never auto-approve) and the suggestion path
 * returns no suggestions (so it never nudges the user toward a sandbox-weakening
 * `cd *` grant that would auto-approve `cd` to anywhere). A non-`cd` leading
 * token — or a `cd` too short to carry a separator — returns the tokens
 * unchanged for normal segmentation, where {@link CdHandler} validates a lone
 * `cd <path>` segment in any position.
 * @param {ShellToken[]} tokens tokens with a possible leading `cd X <sep>`
 * @param {ApprovalCtx} ctx approval context
 * @returns {ShellToken[] | null} tokens with a clean leading `cd X <sep>` removed, unchanged when there is no leading `cd`, or null to refuse
 */
function stripLeadingSafeCd(tokens, ctx) {
  if (tokens.length < 3) return tokens;
  const t0 = checkedAt(tokens, 0);
  if (t0.type !== 'word' || t0.text !== 'cd') return tokens;
  const t1 = checkedAt(tokens, 1);
  const t2 = checkedAt(tokens, 2);
  if (t1.type !== 'word') return null;
  if (t2.type !== 'op' || !TOP_LEVEL_SPLIT_OPS.has(t2.text)) return null;
  if (!isPathInsideAllowedRoots(t1.text, ctx.allowedRoots, ctx.home, ctx.platform)) return null;
  return tokens.slice(3);
}

// ============================================================================
// Segmentation
// ============================================================================

/**
 * Split tokens at top-level operators in `splitOps`. Empty leading/trailing
 * segments are returned as empty arrays so callers can reject them.
 *
 * Group-aware: a separator INSIDE a subshell `( … )` or brace `{ …; }` group
 * does not split, so a whole group stays in one segment and the segment walker
 * can validate its interior recursively. Depth is tracked across `(`/`)` op
 * tokens and `{`/`}` word tokens.
 * @param {ShellToken[]} tokens tokens
 * @param {Set<string>} splitOps operators to split on
 * @returns {ShellToken[][]} segments
 */
function splitOnOps(tokens, splitOps) {
  /** @type {ShellToken[][]} */
  const out = [];
  let cur = /** @type {ShellToken[]} */ ([]);
  let depth = 0;
  for (const t of tokens) {
    if (groupOpenerText(t)) depth++;
    else if (groupCloserText(t) && depth > 0) depth--;

    if (depth === 0 && t.type === 'op' && splitOps.has(t.text)) {
      out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  out.push(cur);
  return out;
}

/**
 * Group-open token classifier: subshell `(` (op) or brace `{` (reserved word).
 * @param {ShellToken} t token
 * @returns {string|null} the opener char (`(` or `{`), or null if not an opener
 */
function groupOpenerText(t) {
  if (t.type === 'op' && t.text === '(') return '(';
  if (t.type === 'word' && t.text === '{') return '{';
  return null;
}

/**
 * Group-close token classifier: subshell `)` (op) or brace `}` (reserved word).
 * @param {ShellToken} t token
 * @returns {string|null} the closer char (`)` or `}`), or null if not a closer
 */
function groupCloserText(t) {
  if (t.type === 'op' && t.text === ')') return ')';
  if (t.type === 'word' && t.text === '}') return '}';
  return null;
}

/**
 * Given a segment whose first token opens a group, return the group's interior
 * token list — or `null` if it isn't a single balanced group occupying the
 * whole segment. The matching closer must be the LAST token (callers strip safe
 * trailing redirects/sinks first) and must be the right kind (`(`→`)`, `{`→`}`),
 * so a mismatched or trailing-junk group is rejected.
 * @param {ShellToken[]} tokens segment tokens (first token is a group opener)
 * @returns {ShellToken[] | null} interior tokens, or null
 */
function extractGroupInterior(tokens) {
  if (tokens.length === 0) return null;
  const opener = groupOpenerText(checkedAt(tokens, 0));
  if (!opener) return null;
  const wantCloser = opener === '(' ? ')' : '}';
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (groupOpenerText(checkedAt(tokens, i))) depth++;
    else if (groupCloserText(checkedAt(tokens, i))) {
      depth--;
      if (depth === 0) {
        if (i !== tokens.length - 1) return null; // trailing junk
        if (groupCloserText(checkedAt(tokens, i)) !== wantCloser) return null;
        return tokens.slice(1, i);
      }
    }
  }
  return null; // unbalanced
}

// ============================================================================
// Windows shape-check
// ============================================================================

/**
 * @param {ShellToken[]} tokens tokens
 * @returns {boolean} true if the tokens look POSIX-shaped on Windows
 */
function isWindowsPosixShaped(tokens) {
  for (const t of tokens) {
    if (t.type === 'op' && t.text === '&') return false;
    if (t.type === 'word') {
      if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(t.raw)) return false;
      if (/\\[A-Za-z0-9.\-_]/.test(t.raw) && !/^["'].*["']$/.test(t.raw)) return false;
    }
  }
  const firstWord = tokens.find(t => t.type === 'word');
  if (firstWord && WINDOWS_NATIVE_TOKENS.has(firstWord.text.toLowerCase())) return false;
  return true;
}

// ============================================================================
// Inline-redirect stripping (side-effect-free)
// ============================================================================

/**
 * Strip side-effect-free redirects from anywhere in the token stream:
 *   - `2>&1`                  — merge stderr into stdout
 *   - `> <strippable>`        — redirect stdout to /dev/null or an allowed path
 *   - `>> <strippable>`       — same, append
 *   - `2> <strippable>`       — redirect stderr to /dev/null or an allowed path
 *
 * `2>&1` never touches user-visible state. A `> FILE` redirect's only effect is
 * *where* output lands; it is stripped when the destination is inert
 * (`/dev/null`) or an allowed write target (see
 * {@link isStrippableRedirectTarget}). The command words themselves are still
 * validated separately, so stripping a redirect can never approve a command
 * that would otherwise be rejected — only relocate its output. Returns a new
 * token array.
 * @param {ShellToken[]} tokens tokens
 * @param {RedirectCfg} [cfg] redirect policy
 * @returns {ShellToken[]} tokens with safe redirects removed
 */
function stripInlineSafeRedirects(tokens, cfg = {}) {
  /** @type {ShellToken[]} */
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = checkedAt(tokens, i);
    if (t.type === 'op' && t.text === '2>&1') continue;
    if (t.type === 'op' && (t.text === '>' || t.text === '>>' || t.text === '2>')) {
      const next = checkedAt(tokens, i + 1);
      if (next && next.type === 'word' && isStrippableRedirectTarget(next.text, cfg)) {
        i++;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

// ============================================================================
// Segment validation
// ============================================================================

/**
 * @param {ShellToken[]} segTokens segment tokens
 * @returns {string} reconstructed segment text (raw)
 */
function reconstructSegment(segTokens) {
  let out = '';
  for (let i = 0; i < segTokens.length; i++) {
    const t = checkedAt(segTokens, i);
    const raw = t.type === 'word' ? t.raw : t.text;
    if (i > 0) out += ' ';
    out += raw;
  }
  return out;
}

/**
 * Env vars whose values can redirect or hijack command execution. Setting any
 * of these as an inline prefix (`VAR=value cmd ...`) is rejected — the cost of
 * being wrong is total: an attacker controls which binary actually runs.
 *
 * - `PATH` / `BASH_ENV` / `ENV` / `SHELLOPTS` — change command resolution.
 * - `LD_*` / `DYLD_*` — inject shared libraries at load time.
 * - `IFS` — change word-splitting of subsequent expansions.
 * - `NODE_OPTIONS` / `PYTHONSTARTUP` / `PERL5OPT` / `RUBYOPT` — interpreter-
 *   level code injection via flags or init files.
 * - `BASH_FUNC_*` — function-export smuggling (shellshock-shaped).
 * - `GLOBIGNORE` — alter pathname expansion semantics.
 */
const DANGEROUS_ENV_VAR_NAMES = new Set([
  'PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'IFS', 'NODE_OPTIONS',
  'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT', 'GLOBIGNORE'
]);

/** Prefixes for env vars treated as dangerous (loader / function export). */
const DANGEROUS_ENV_VAR_PREFIXES = ['LD_', 'DYLD_', 'BASH_FUNC_'];

/**
 * Peel leading `NAME=value` env assignments off the segment. POSIX allows any
 * number of these before the command word. Returns null if any assignment
 * names a {@link DANGEROUS_ENV_VAR_NAMES} variable (or matches a dangerous
 * prefix) — the analyser refuses to reason about commands whose loader /
 * interpreter behaviour is being rewritten.
 * @param {ShellToken[]} segTokens segment tokens
 * @returns {ShellToken[] | null} tokens with env prefix stripped, or null if unsafe
 */
function stripEnvPrefix(segTokens) {
  let i = 0;
  while (i < segTokens.length) {
    const t = checkedAt(segTokens, i);
    if (t.type !== 'word') break;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t.text);
    if (!m) break;
    const name = checkedAt(m, 1);
    if (DANGEROUS_ENV_VAR_NAMES.has(name)) return null;
    if (DANGEROUS_ENV_VAR_PREFIXES.some(p => name.startsWith(p))) return null;
    // `NAME=$(cmd) realcmd …` — an env-prefix value built from command
    // substitution. The substitution would run with the segment; we can't
    // vouch for it here (the pure-assignment path in validateSegmentSequence
    // is the only place a `NAME=$(…)` producer is vetted). Reject.
    if (/** @type {WordToken} */ (t).subst) return null;
    i++;
  }
  return i === 0 ? segTokens : segTokens.slice(i);
}

/**
 * If `text` is exactly a whole variable reference — `$NAME` or `${NAME}` with
 * nothing else — return NAME; else null. A partial reference (`pre$NAME`,
 * `$NAME.bak`) returns null: only a token that is ENTIRELY one variable can be
 * resolved to a single known value.
 * @param {string} text token text
 * @returns {string | null} the variable name, or null
 */
function wholeVarName(text) {
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
  if (braced) return checkedAt(braced, 1);
  const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  return bare ? checkedAt(bare, 1) : null;
}

/**
 * Resolve an argument token to a concrete string using recorded provenance.
 * A whole-token `$NAME`/`${NAME}` with known provenance resolves to its literal
 * value, or — for an in-project-path producer — to a representative allowed
 * root (so the handler's in-project path check passes). Everything else (plain
 * text, unknown vars, partial references) returns the token's text unchanged.
 * @param {ShellToken} t token
 * @param {ApprovalCtx} ctx approval context
 * @returns {string} resolved argument text
 */
function resolveVarArg(t, ctx) {
  if (t.type !== 'word') return t.text;
  const name = wholeVarName(t.text);
  if (!name || !ctx.vars) return t.text;
  const prov = ctx.vars.get(name);
  if (!prov) return t.text;
  if (prov.kind === 'literal') return prov.value;
  if (prov.kind === 'inProjectPath' && Array.isArray(ctx.allowedRoots) && ctx.allowedRoots.length > 0) {
    return checkedAt(ctx.allowedRoots, 0);
  }
  return t.text;
}

/**
 * @param {ShellToken[]} segTokens segment tokens
 * @param {ApprovalCtx} ctx context
 * @returns {boolean} true if the segment is safe
 */
function isSegmentSafe(segTokens, ctx) {
  segTokens = stripInlineSafeRedirects(segTokens, ctx);
  segTokens = stripTrailingSafeSinks(segTokens, ctx);
  if (segTokens.length === 0) return false;
  const afterEnv = stripEnvPrefix(segTokens);
  if (afterEnv === null) return false;
  segTokens = afterEnv;
  if (segTokens.length === 0) return false;
  // Any leftover operator means the segment did something we didn't
  // understand (an unknown redirect, a pipe to something we don't trust,
  // a backgrounding `&`, ...). Reject.
  if (segTokens.some(t => t.type === 'op')) return false;

  // A command substitution `$(…)` survives here as a SUBST_SENTINEL in some
  // token's text plus a `subst` field. The ONLY position we vet a
  // substitution is the pure-assignment producer (`NAME=$(…)`), handled in
  // validateSegmentSequence before this function is ever reached. Any subst
  // reaching isSegmentSafe is therefore in an unvetted position — an argument
  // (`grep $(curl evil)`), the command head (`$(echo rm) -rf`), or an
  // env-prefix value — and must be rejected. Variable resolution of a *whole*
  // `$NAME` token (no subst field) is handled separately below.
  if (segTokens.some(t => t.type === 'word' && /** @type {WordToken} */ (t).subst)) return false;

  const head = /** @type {WordToken} */ (segTokens[0]);
  if (head.type !== 'word') return false;
  // An unquoted variable expansion in an ARGUMENT (`cmd $x`, `cmd a$x/b`) can
  // word-split and glob-expand at runtime into additional words or flags. The
  // builtin handlers below make fine-grained, value-specific decisions (which
  // paths are in-project, which flags are read-only), so a runtime value they
  // cannot see could subvert them — a handler must never approve a segment that
  // carries an unresolved unquoted expansion in its arguments. Such a segment
  // can still be approved by an explicit user glob pattern (below): a `<cmd> *`
  // grant is a deliberate blanket trust of that command, and word-splitting
  // stays within its arguments — it cannot change the literal command head or
  // inject a shell operator (both fixed at parse time, before expansion), so
  // matching the literal command text is sound. A double-quoted expansion
  // (`"$x"`) does not word-split and is NOT marked, so it still resolves through
  // the handler via recorded provenance.
  const hasUnquotedVarArg = segTokens.slice(1).some(
    t => t.type === 'word' && /** @type {WordToken} */ (t).unquotedVar);
  const handler = COMMAND_HANDLERS.get(head.text);
  if (handler && !hasUnquotedVarArg) {
    // Resolve whole-token variable references (`"$f"` → text `$f`, `"${f}"` →
    // `${f}`) in the ARGUMENTS against recorded provenance: a literal var
    // becomes its captured value; an in-project-path var becomes a
    // representative allowed root (so the handler's in-project path check
    // passes). The head is never resolved — a variable can't become the
    // command name. Unknown vars and partial references (`pre$f`) keep their
    // `$`-bearing text and are rejected by the handler's own path checks.
    const args = /** @type {WordToken[]} */ (segTokens.slice(1)).map(t => resolveVarArg(t, ctx));
    if (handler.isSafe(args, ctx)) return true;
    if (typeof handler.outOfRootPaths === 'function') {
      const outOfRoot = handler.outOfRootPaths(args, ctx);
      /** @type {string[]} */
      const roots = [];
      for (const p of outOfRoot) {
        const root = canonicalRoot(p, ctx.home);
        if (root) roots.push(root);
      }
      if (outOfRoot.length > 0 && roots.length === outOfRoot.length) {
        const augmented = { ...ctx, allowedRoots: [...(ctx.allowedRoots || []), ...roots] };
        if (handler.isSafe(args, augmented)) return false;
      }
    }
  }

  const cmdStr = reconstructSegment(segTokens);
  for (const p of ctx.patterns || []) {
    if (matchesGlob(p, cmdStr)) return true;
  }
  return false;
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Decide whether `command` is safe to auto-approve.
 * @param {string} command command string
 * @param {object} [opts] options
 * @param {string} [opts.platform] 'darwin', 'linux', or 'windows' (default 'darwin')
 * @param {string[]} [opts.allowedRoots] filesystem roots the LLM may read under (default [])
 * @param {string} [opts.home] backend user-home dir for resolving `~/...` (default '')
 * @param {string[]} [opts.patterns] user-configured enabled glob patterns (default [])
 * @param {boolean} [opts.writeEnabled] file-writing permission is on for this conversation (default false)
 * @returns {boolean} true to auto-approve
 */
export function isCommandAutoApproved(command, opts = {}) {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return false;

  const platform = opts.platform || 'darwin';
  const allowedRoots = opts.allowedRoots || [];
  const patterns = opts.patterns || [];
  const writeEnabled = Boolean(opts.writeEnabled);
  const home = opts.home || '';

  if (platform === 'windows' && !isWindowsPosixShaped(tokens)) return false;

  const ctx = { platform, home, allowedRoots, patterns, writeEnabled, vars: new Map() };

  let working = stripTrailingSafeSinks(tokens, ctx);
  const afterCd = stripLeadingSafeCd(working, ctx);
  if (afterCd === null) return false;
  working = afterCd;
  if (working.length === 0) return false;

  const segments = splitOnOps(working, TOP_LEVEL_SPLIT_OPS);
  return validateSegmentSequence(segments, ctx);
}

/**
 * Upper bound on the length of a glob pattern we will *suggest*. Past this a
 * pattern is almost always the verbatim text of one long command — too
 * specific to ever match a future command, so offering it as "don't ask again"
 * is noise. The exact-segment tier is the only tier that can exceed this (the
 * `<cmd> *` / `git <sub> *` generalisations are always short), so the cap
 * simply drops the over-long exact tier and keeps the useful wildcard tiers.
 * It does not restrict what a user can save explicitly — only what we propose.
 */
export const MAX_SUGGESTED_PATTERN_LENGTH = 150;

/**
 * @typedef {object} SegmentRemedy
 * @property {string[]} globs glob patterns narrowest→broadest that cover the
 *   segment via the analyser's pattern fallback: the exact text, then handler
 *   generalisations / `<cmd> *` — EXCEPT the wildcard generalisations are
 *   withheld when an out-of-root path is the segment's sole obstacle (a wildcard
 *   would drop the in-root-path restriction that was violated), leaving exact only.
 * @property {string[]} paths absolute folders to grant (add to the allowed-paths
 *   list) that, by themselves, make the segment safe — empty when the segment is
 *   not rejected purely because of out-of-root path arguments.
 */

/**
 * Normalise a rejected segment exactly as {@link isSegmentSafe} does, then
 * derive the remedies that would make it pass: glob patterns (always) and, when
 * the segment is rejected purely because path arguments sit outside the allowed
 * roots, the folders to grant instead.
 *
 * The path-grant remedy is verified, not assumed: the head handler nominates
 * candidate out-of-root paths, they're resolved to absolute roots, and the
 * segment is re-checked with those roots added — only a segment that then
 * passes yields a grant. So a command rejected for any *other* reason (a
 * forbidden `find -exec`, an unparseable flag) gets globs only.
 *
 * Returns `null` when no remedy could ever cover the segment — a leftover
 * operator token (e.g. a non-`/dev/null` write redirect), a dangerous env
 * prefix, or an empty segment. The analyser rejects those before the glob
 * fallback runs, so no suggestion is honest.
 * @param {ShellToken[]} seg segment tokens
 * @param {Set<string>} interpreters heads that must never be wildcarded
 * @param {ApprovalCtx} cfg approval context (allowedRoots + writeEnabled + home)
 * @returns {SegmentRemedy | null} remedies, or null if uncoverable
 */
function segmentRemedies(seg, interpreters, cfg) {
  seg = stripInlineSafeRedirects(seg, cfg);
  seg = stripTrailingSafeSinks(seg, cfg);
  if (seg.length === 0) return null;
  const afterEnv = stripEnvPrefix(seg);
  if (afterEnv === null) return null;
  seg = afterEnv;
  if (seg.length === 0) return null;
  // A remedy can only cover a segment with no leftover operator tokens;
  // isSegmentSafe bails on those before ever consulting the pattern list.
  if (seg.some(t => t.type === 'op')) return null;

  const head = /** @type {WordToken} */ (checkedAt(seg, 0));
  if (head.type !== 'word') return null;

  const globs = [reconstructSegment(seg)];
  const handler = COMMAND_HANDLERS.get(head.text);

  // Path-grant remedy + sole-obstacle detection. Ask the handler which path
  // arguments are out-of-root, then grant exactly those (the raw paths) and
  // re-check: if the segment becomes safe, an out-of-root path is its SOLE
  // obstacle. That decides two things:
  //   - `paths`: when every such path ALSO canonicalises to a grantable root,
  //     offer a folder grant (the targeted fix). A non-grantable path (`/`, a
  //     bare top-level, the home dir) or a mix leaves paths empty, so the caller
  //     falls back to the exact-segment glob.
  //   - `pathIsSoleObstacle`: when true, the `<cmd> *` wildcard tier is withheld
  //     below — generalising the command would drop the very in-root-path
  //     restriction that was violated (and for a handler with its own safety
  //     grammar, e.g. find's -delete/-exec, a `find *` rule would blanket-approve
  //     the forms it forbids). The exact segment is still offered.
  // Anything else (a non-path obstacle — a forbidden predicate, an unparseable
  // flag) leaves both untouched, so the caller offers the usual glob tiers.
  /** @type {string[]} */
  let paths = [];
  let pathIsSoleObstacle = false;
  if (handler && typeof handler.outOfRootPaths === 'function') {
    const args = /** @type {WordToken[]} */ (seg.slice(1)).map(t => t.text);
    const candidates = handler.outOfRootPaths(args, cfg) || [];
    if (candidates.length > 0) {
      const probe = { ...cfg, allowedRoots: [...(cfg.allowedRoots || []), ...candidates] };
      if (isSegmentSafe(seg, probe)) {
        pathIsSoleObstacle = true;
        const roots = /** @type {string[]} */ (candidates.map(p => canonicalRoot(p, cfg.home)).filter(Boolean));
        if (roots.length === candidates.length) paths = roots;
      }
    }
  }

  // Interpreters (bash, python, node, …) are too dangerous to wildcard — a
  // `bash *` rule would auto-approve arbitrary scripts. Offer the exact form
  // only, matching ExecuteContextItem.extractDefaultPattern's policy.
  if (interpreters.has(head.text)) return { globs, paths };

  // Out-of-root path is the sole obstacle: a `<cmd> *` wildcard is dishonest
  // (it drops the path restriction that was violated), so offer the exact
  // segment only — plus the folder grant above when one is grantable.
  if (pathIsSoleObstacle) return { globs, paths };

  const words = /** @type {WordToken[]} */ (seg).map(t => t.text);
  const generalisations = handler && typeof handler.suggestPatterns === 'function'
    ? handler.suggestPatterns(words)
    : [`${head.text} *`];
  for (const g of generalisations) {
    if (!globs.includes(g)) globs.push(g);
  }
  return { globs, paths };
}

/**
 * Suggest the minimal auto-approval remedies that would let `command`
 * auto-approve, as an ordered list of escalating-breadth choices.
 *
 * Reuses the {@link isCommandAutoApproved} decomposition: strips safe sinks and
 * a leading in-project `cd`, splits on top-level `&&`/`||`/`;`, and for each
 * segment the analyser would still reject derives its remedies (see
 * {@link segmentRemedies}). Two kinds of suggestion come out:
 *   - a single **path grant** (`{allowedPaths}`) — offered first, and only when
 *     EVERY rejected segment is rejected purely because path arguments fall
 *     outside the allowed roots. Granting those folders keeps the command-shape
 *     restriction while letting the command read where it needs to — the right
 *     answer for `grep -r … ~/elsewhere` / `find ~/elsewhere …`, far better than
 *     a `grep *` wildcard.
 *   - **glob patterns** (`{patterns}`) — escalating breadth, one pattern per
 *     rejected segment combined per tier, as before.
 *
 * Returns `[]` (caller should fall back to an exact whole-command rule) when:
 *   - the command already auto-approves — nothing to suggest;
 *   - it can't be statically decomposed into clean segments — command
 *     substitution, control flow, a `cd` that escapes the allowed roots, a
 *     dangerous env prefix, or a segment with a leftover operator.
 * @param {string} command command string
 * @param {object} [opts] options
 * @param {string} [opts.platform] 'darwin', 'linux', or 'windows' (default 'darwin')
 * @param {string[]} [opts.allowedRoots] filesystem roots the LLM may read under (default [])
 * @param {string} [opts.home] backend user-home dir for resolving `~/...` (default '')
 * @param {string[]} [opts.patterns] already-enabled glob patterns (default [])
 * @param {Set<string>|string[]} [opts.interpreters] heads that must never be wildcarded (default none)
 * @param {boolean} [opts.writeEnabled] file-writing permission is on for this conversation (default false)
 * @returns {Array<{patterns?: string[], allowedPaths?: string[]}>} escalating suggestions, narrowest first
 */
export function suggestApprovalPatterns(command, opts = {}) {
  if (!command || typeof command !== 'string') return [];
  const trimmed = command.trim();
  if (!trimmed) return [];

  const platform = opts.platform || 'darwin';
  const allowedRoots = opts.allowedRoots || [];
  const patterns = opts.patterns || [];
  const writeEnabled = Boolean(opts.writeEnabled);
  const home = opts.home || '';
  const interpreters = opts.interpreters instanceof Set
    ? opts.interpreters
    : new Set(opts.interpreters || []);

  // Already approved → nothing to suggest.
  if (isCommandAutoApproved(trimmed, { platform, home, allowedRoots, patterns, writeEnabled })) return [];

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return [];
  if (platform === 'windows' && !isWindowsPosixShaped(tokens)) return [];
  // A command substitution has no honest minimal glob — its raw text carries a
  // SUBST_SENTINEL placeholder, and a variable it feeds resolves only at
  // analysis time. Bail so the caller falls back to an exact whole-command rule.
  if (tokens.some(t => t.type === 'word' && /** @type {WordToken} */ (t).subst)) return [];

  const ctx = { platform, home, allowedRoots, patterns, writeEnabled, vars: new Map() };

  let working = stripTrailingSafeSinks(tokens, ctx);
  const afterCd = stripLeadingSafeCd(working, ctx);
  if (afterCd === null) return [];
  working = afterCd;
  if (working.length === 0) return [];

  const segments = splitOnOps(working, TOP_LEVEL_SPLIT_OPS);

  /** @type {SegmentRemedy[]} one remedy per rejected segment */
  const perSegment = [];
  for (const seg of segments) {
    // Empty segment (comment/blank line around a synthesized `;`): no command,
    // so no remedy to suggest — skip it rather than bailing to a whole-command
    // rule, so a leading/trailing comment doesn't coarsen the suggestion.
    if (seg.length === 0) continue;
    // Control flow and grouped commands are too complex to suggest
    // minimal patterns for; bail (caller falls back to an exact rule).
    const head = checkedAt(seg, 0);
    if (groupOpenerText(head)) return [];
    if (head.type === 'word'
				&& (FLOW_OPENERS.has(/** @type {WordToken} */ (head).text)
					|| FLOW_BODY_INTRODUCERS.has(/** @type {WordToken} */ (head).text))) {
      return [];
    }
    if (isSegmentSafe(seg, ctx)) continue;
    const rem = segmentRemedies(seg, interpreters, ctx);
    if (!rem) return [];
    perSegment.push(rem);
  }
  if (perSegment.length === 0) return [];

  /** @type {Array<{patterns?: string[], allowedPaths?: string[]}>} */
  const suggestions = [];

  // Path-grant suggestion (narrowest, most targeted): only when EVERY rejected
  // segment is fixable purely by granting out-of-root folders, so one grant
  // makes the whole command pass while keeping its command-shape restriction.
  // Union the folders across segments, deduped, preserving first-seen order.
  if (perSegment.every(r => r.paths.length > 0)) {
    /** @type {string[]} */
    const allowedPaths = [];
    const within = new Set();
    for (const r of perSegment) {
      for (const p of r.paths) {
        if (!within.has(p)) { within.add(p); allowedPaths.push(p); }
      }
    }
    if (isCommandAutoApproved(trimmed, { platform, home, allowedRoots: [...allowedRoots, ...allowedPaths], patterns, writeEnabled })) {
      suggestions.push({ allowedPaths });
    }
  }

  // Glob-pattern suggestions: combine across segments into escalating tiers. At
  // tier t each segment contributes its tier-t glob (clamped to its broadest),
  // deduped within the suggestion; identical suggestions collapse.
  const perSegmentTiers = perSegment.map(r => r.globs);
  const maxTiers = Math.max(...perSegmentTiers.map(t => t.length));
  const seen = new Set();
  for (let t = 0; t < maxTiers; t++) {
    /** @type {string[]} */
    const combined = [];
    const within = new Set();
    for (const tiers of perSegmentTiers) {
      const p = checkedAt(tiers, Math.min(t, tiers.length - 1));
      if (!within.has(p)) { within.add(p); combined.push(p); }
    }
    // Skip a tier whose any pattern is too long to be a useful suggestion
    // (the verbatim exact-command tier). Broader tiers survive; a segment
    // whose every tier is over-long — e.g. a long interpreter command with
    // no wildcard generalisation — drops out entirely, leaving [].
    if (combined.some(p => p.length > MAX_SUGGESTED_PATTERN_LENGTH)) continue;
    const key = combined.join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isCommandAutoApproved(trimmed, { platform, home, allowedRoots, patterns: [...patterns, ...combined], writeEnabled })) continue;
    suggestions.push({ patterns: combined });
  }
  return suggestions;
}

/**
 * If `seg` is a single pure assignment word — `NAME=value` or `NAME=$(cmd)`
 * with nothing else in the segment — return its name and token. A segment like
 * `NAME=value cmd …` (assignment followed by a command) is NOT a pure
 * assignment: it's an env-prefixed command handled by {@link stripEnvPrefix}.
 * @param {ShellToken[]} seg segment tokens
 * @returns {{name: string, token: WordToken} | null} parsed assignment, or null
 */
function parsePureAssignment(seg) {
  if (seg.length !== 1) return null;
  const t = checkedAt(seg, 0);
  if (t.type !== 'word') return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t.text);
  if (!m) return null;
  return { name: checkedAt(m, 1), token: /** @type {WordToken} */ (t) };
}

/**
 * Determine the output-path domain of a command-substitution producer — the
 * inner command of a `NAME=$(inner)` assignment. Returns `'inProjectPath'` only
 * when BOTH hold:
 *   1. `inner` auto-approves on its own as a read-only, in-project command; and
 *   2. it decomposes to a single producing segment whose head handler declares
 *      (via {@link CommandHandler.outputPathDomain}) that its stdout is a list
 *      of in-project filesystem paths (`grep -l`, `git ls-files`, `find`).
 * Otherwise null — the substitution's output provenance is unknown, so the
 * variable it feeds must not satisfy a path argument. Pipelines / multi-segment
 * inners are conservatively rejected (we can't point at one producer).
 * @param {string} inner inner command text of the substitution
 * @param {ApprovalCtx} ctx approval context
 * @returns {'inProjectPath' | null} output domain, or null if unknown
 */
function substOutputDomain(inner, ctx) {
  const innerOpts = {
    platform: ctx.platform, home: ctx.home, allowedRoots: ctx.allowedRoots,
    patterns: ctx.patterns, writeEnabled: ctx.writeEnabled
  };
  if (!isCommandAutoApproved(inner, innerOpts)) return null;

  const tokens = tokenize(inner);
  if (!tokens || tokens.length === 0) return null;
  let working = stripTrailingSafeSinks(tokens, ctx);
  const afterCd = stripLeadingSafeCd(working, ctx);
  if (afterCd === null) return null;
  working = afterCd;
  const segs = splitOnOps(working, TOP_LEVEL_SPLIT_OPS).filter(s => s.length > 0);
  if (segs.length !== 1) return null; // single producer only

  let seg = stripInlineSafeRedirects(checkedAt(segs, 0), ctx);
  seg = stripTrailingSafeSinks(seg, ctx);
  const afterEnv = stripEnvPrefix(seg);
  if (afterEnv === null) return null;
  seg = afterEnv;
  if (seg.length === 0 || seg.some(t => t.type === 'op')) return null;

  const head = checkedAt(seg, 0);
  if (head.type !== 'word') return null;
  const handler = COMMAND_HANDLERS.get(/** @type {WordToken} */ (head).text);
  if (!handler || typeof handler.outputPathDomain !== 'function') return null;
  const args = /** @type {WordToken[]} */ (seg.slice(1)).map(t => t.text);
  return handler.outputPathDomain(args, ctx);
}

/**
 * Validate a single pure assignment (`NAME=value` / `NAME=$(cmd)`) and record
 * its provenance in `ctx.vars`. Rejects dangerous variable names (same policy
 * as {@link stripEnvPrefix}); for a substitution value, requires a single
 * whole-value `$(…)` whose producer has a known in-project output domain.
 * @param {{name: string, token: WordToken}} assign parsed assignment
 * @param {ApprovalCtx} ctx approval context
 * @returns {boolean} true if the assignment is safe and was recorded
 */
function recordAssignment(assign, ctx) {
  const { name, token } = assign;
  if (DANGEROUS_ENV_VAR_NAMES.has(name)) return false;
  if (DANGEROUS_ENV_VAR_PREFIXES.some(p => name.startsWith(p))) return false;
  const value = token.text.slice(name.length + 1);
  if (token.subst) {
    // Must be exactly `NAME=$(cmd)`: the value is the sentinel alone (no
    // literal text fused around it like `NAME=pre$(cmd)post`, whose result
    // we can't characterise) and exactly one substitution.
    if (value !== SUBST_SENTINEL || token.subst.length !== 1) return false;
    const domain = substOutputDomain(checkedAt(token.subst, 0), ctx);
    if (!domain) return false;
    if (!ctx.vars) ctx.vars = new Map();
    ctx.vars.set(name, { kind: domain });
    return true;
  }
  // Literal value (no substitution; the subst guard guarantees no sentinel).
  if (!ctx.vars) ctx.vars = new Map();
  ctx.vars.set(name, { kind: 'literal', value });
  return true;
}

/** Keywords that open a control-flow block ending in `done` or `fi`. */
const FLOW_OPENERS = new Set(['for', 'while', 'until', 'if']);

/** Body-introducer keywords stripped from the head of a body segment. */
const FLOW_BODY_INTRODUCERS = new Set(['do', 'then', 'else']);

/**
 * Walk a sequence of `;`/`&&`/`||`-separated segments with control-flow
 * awareness. Recognises POSIX `for VAR in WORDS; do …; done`, `while CMD; do
 * …; done`, `until CMD; do …; done`, and `if CMD; then …; [elif CMD; then …;]
 * [else …;] fi` blocks; the body is itself validated as a segment sequence
 * (so loops nest). Body segments may have a leading `do`/`then`/`else`
 * keyword which is peeled before validation.
 *
 * Any segment that doesn't open a block is validated as a normal command via
 * {@link isSegmentSafe}.
 * @param {ShellToken[][]} segments segments to validate
 * @param {{platform: string, allowedRoots: string[], patterns: string[]}} ctx context
 * @returns {boolean} true if every segment (and every body of every block) is safe
 */
function validateSegmentSequence(segments, ctx) {
  let i = 0;
  while (i < segments.length) {
    let seg = checkedAt(segments, i);
    // An empty segment carries no command to run — it is the residue of a
    // comment line or blank line around a synthesized `;` separator (or a
    // degenerate `;;` / `; ;`). Nothing to validate; skip it. It can never be
    // unsafe, so skipping (rather than rejecting) is security-neutral.
    if (seg.length === 0) { i++; continue; }

    // Peel leading body-introducer keyword (`do`, `then`, `else`) so the
    // segment that follows e.g. `do` can be validated as a normal command.
    if (checkedAt(seg, 0).type === 'word' && FLOW_BODY_INTRODUCERS.has(/** @type {WordToken} */ (checkedAt(seg, 0)).text)) {
      seg = seg.slice(1);
      if (seg.length === 0) { i++; continue; }
    }

    // Pure assignment (`NAME=value` / `NAME=$(cmd)`). Validate it and record
    // its provenance in ctx.vars so later segments can resolve `"$NAME"`.
    // This is the ONLY place a command substitution is vetted; isSegmentSafe
    // rejects subst everywhere else.
    const assign = parsePureAssignment(seg);
    if (assign) {
      if (!recordAssignment(assign, ctx)) return false;
      i++;
      continue;
    }

    // Grouped command: subshell `( … )` or brace `{ …; }`. Grouping confers
    // no new capability, so the group is safe iff its contents are. Strip
    // any safe trailing redirects/sinks (`( … ) >/dev/null`, `{ …; } 2>&1`),
    // then require the segment to be exactly one balanced group and validate
    // its interior as its own command sequence.
    if (groupOpenerText(checkedAt(seg, 0))) {
      let g = stripInlineSafeRedirects(seg, ctx);
      g = stripTrailingSafeSinks(g, ctx);
      const inner = extractGroupInterior(g);
      if (inner === null) return false;
      const innerSegs = splitOnOps(inner, TOP_LEVEL_SPLIT_OPS).filter(s => s.length > 0);
      if (innerSegs.length === 0) return false;
      if (!validateSegmentSequence(innerSegs, ctx)) return false;
      i++;
      continue;
    }

    const head = checkedAt(seg, 0);
    if (head.type === 'word' && FLOW_OPENERS.has(/** @type {WordToken} */ (head).text)) {
      const opener = /** @type {WordToken} */ (head).text;
      const terminator = opener === 'if' ? 'fi' : 'done';

      // Validate the opener's header.
      if (opener === 'for') {
        if (!validateForHeader(seg.slice(1))) return false;
      } else {
        // `while`/`until`/`if` take a command as the condition.
        const cond = seg.slice(1);
        if (cond.length === 0 || !isSegmentSafe(cond, ctx)) return false;
      }

      // Collect body segments up to the matching terminator. Track depth
      // across nested openers so an inner `done` doesn't close us.
      let depth = 1;
      let j = i + 1;
      /** @type {ShellToken[][]} */
      const body = [];
      while (j < segments.length && depth > 0) {
        const s = checkedAt(segments, j);
        // Look through any leading body-introducer to find the real
        // head when counting depth.
        let probe = s;
        if (probe.length > 0 && checkedAt(probe, 0).type === 'word' &&
					FLOW_BODY_INTRODUCERS.has(/** @type {WordToken} */ (checkedAt(probe, 0)).text)) {
          probe = probe.slice(1);
        }
        if (probe.length > 0 && checkedAt(probe, 0).type === 'word') {
          const t = /** @type {WordToken} */ (checkedAt(probe, 0)).text;
          if (FLOW_OPENERS.has(t)) depth++;
          else if (t === terminator || t === 'fi' || t === 'done') {
            // Any block terminator decrements; only ours closes.
            if (t === terminator) {
              depth--;
              if (depth === 0) break;
            } else {
              depth--;
            }
          }
        }
        body.push(s);
        j++;
      }
      if (depth !== 0) return false;
      if (!validateSegmentSequence(body, ctx)) return false;
      i = j + 1;
      continue;
    }

    if (!isSegmentSafe(seg, ctx)) return false;
    i++;
  }
  return true;
}

/**
 * Validate the header of a `for` loop: `VAR in WORD WORD …`. `VAR` must be a
 * POSIX shell identifier; the word list may be empty (`for x in; do …; done`
 * is degenerate but harmless). Each list element must be a plain word — no
 * operators, no command substitutions (which the tokenizer would already
 * have rejected).
 * @param {ShellToken[]} toks header tokens after the `for` keyword
 * @returns {boolean} true if the header is safe
 */
function validateForHeader(toks) {
  if (toks.length < 2) return false;
  if (checkedAt(toks, 0).type !== 'word' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(/** @type {WordToken} */ (checkedAt(toks, 0)).text)) return false;
  if (checkedAt(toks, 1).type !== 'word' || /** @type {WordToken} */ (checkedAt(toks, 1)).text !== 'in') return false;
  for (let k = 2; k < toks.length; k++) {
    if (checkedAt(toks, k).type !== 'word') return false;
  }
  return true;
}
