//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Node.js-compatible path module for POSIX paths.
 * Pure string operations — no backend calls required.
 * @module path
 */

const sep = '/';
const delimiter = ':';

/**
 * Join path segments, normalising separators and resolving `.` / `..`.
 * @param {...string} segments - Path segments to join
 * @returns {string} Joined and normalised path
 */
function join(...segments) {
  const joined = segments.filter(Boolean).join(sep);
  return normalise(joined);
}

/**
 * Resolve a sequence of paths to an absolute path.
 * Processes right-to-left until an absolute path is formed.
 * @param {...string} segments - Path segments to resolve
 * @returns {string} Resolved absolute path
 */
function resolve(...segments) {
  let resolved = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (!seg) continue;
    resolved = resolved ? seg + sep + resolved : seg;
    if (seg.startsWith(sep)) break;
  }
  if (!resolved.startsWith(sep)) {
    resolved = sep + resolved;
  }
  return normalise(resolved);
}

/**
 * Return the directory portion of a path.
 * @param {string} p - File path
 * @returns {string} Directory portion of the path
 */
function dirname(p) {
  if (!p) return '.';
  const idx = p.lastIndexOf(sep);
  if (idx === -1) return '.';
  if (idx === 0) return sep;
  return p.slice(0, idx);
}

/**
 * Return the last component of a path, optionally stripping a suffix.
 * @param {string} p - File path
 * @param {string} [ext] - Extension to strip (e.g. '.js')
 * @returns {string} Last component of the path
 */
function basename(p, ext) {
  if (!p) return '';
  let base = p;
  if (base.endsWith(sep)) base = base.slice(0, -1);
  const idx = base.lastIndexOf(sep);
  if (idx !== -1) base = base.slice(idx + 1);
  if (ext && base.endsWith(ext)) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

/**
 * Return the extension of a path (including the leading dot).
 * @param {string} p - File path
 * @returns {string} Extension including leading dot, or empty string
 */
function extname(p) {
  const base = basename(p);
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return base.slice(dotIdx);
}

/**
 * Compute the relative path from `from` to `to`.
 * @param {string} from - Source path
 * @param {string} to - Destination path
 * @returns {string} Relative path from source to destination
 */
function relative(from, to) {
  const fromParts = normalise(from).split(sep).filter(Boolean);
  const toParts = normalise(to).split(sep).filter(Boolean);

  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }

  const ups = fromParts.length - common;
  const remainder = toParts.slice(common);
  const parts = [];
  for (let i = 0; i < ups; i++) parts.push('..');
  parts.push(...remainder);
  return parts.join(sep) || '.';
}

/**
 * Returns true if the path is absolute (starts with /).
 * @param {string} p - File path
 * @returns {boolean} True if the path is absolute
 */
function isAbsolute(p) {
  return typeof p === 'string' && p.startsWith(sep);
}

/**
 * Normalise a path: resolve `.`, `..`, collapse duplicate separators.
 * @param {string} p - File path
 * @returns {string} Normalised path
 */
function normalise(p) {
  if (!p) return '.';
  const isAbs = p.startsWith(sep);
  const parts = p.split(sep);
  const resolved = [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else if (!isAbs) {
        resolved.push('..');
      }
    } else {
      resolved.push(part);
    }
  }

  let result = resolved.join(sep);
  if (isAbs) result = sep + result;
  return result || (isAbs ? sep : '.');
}

export default { sep, delimiter, join, resolve, dirname, basename, extname, relative, isAbsolute, normalise, normalize: normalise };
