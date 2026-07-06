//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/** @type {AbortController|null} */
let _currentController = null;

/** @type {AbortController|null} */
let _pathController = null;

/**
 * Check which of the given paths exist on disk. Resolves relative paths
 * against the current project working dir; "~" is expanded server-side.
 * @param {string[]} paths - Candidate paths to check
 * @returns {Promise<Set<string>>} The subset of inputs that exist
 */
export async function fetchExistingPaths(paths) {
  if (!paths || paths.length === 0) return new Set();
  try {
    const qs = paths.map(p => `paths=${encodeURIComponent(p)}`).join('&');
    const resp = await fetch(`/api/completions/exists?${qs}`);
    if (!resp.ok) return new Set();
    /** @type {{existing: string[]}} */
    const data = await resp.json();
    return new Set(data.existing || []);
  } catch {
    return new Set();
  }
}

/**
 * Fetch file completions from the server for a given query prefix.
 * Aborts any in-flight request before issuing a new one.
 * Returns [] on error — completions are best-effort.
 * @param {string} query - Typed text after "@"
 * @returns {Promise<Array<string>>} Matching paths (dirs have trailing "/")
 */
export async function fetchFileCompletions(query) {
  if (_currentController) {
    _currentController.abort();
  }
  _currentController = new AbortController();

  try {
    const url = `/api/completions/files?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { signal: _currentController.signal });
    if (!resp.ok) return [];
    /** @type {{results: Array<{path: string}>}} */
    const data = await resp.json();
    return (data.results || []).map(r => r.path);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return [];
    return [];
  } finally {
    _currentController = null;
  }
}

/**
 * Fetch absolute path completions from the server.
 * Unlike fetchFileCompletions, results are NOT restricted to the current project.
 * Aborts any in-flight request before issuing a new one.
 * Returns [] on error, null if the request was superseded by a newer one.
 * @param {string} query - Absolute path prefix (e.g. "/Users/alice/co" or "~/code/")
 * @returns {Promise<Array<string>|null>} Matching paths (dirs have trailing "/"), or null if aborted
 */
export async function fetchPathCompletions(query) {
  if (_pathController) {
    _pathController.abort();
  }
  const controller = new AbortController();
  _pathController = controller;

  try {
    const url = `/api/completions/path?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return [];
    /** @type {{results: Array<{path: string}>}} */
    const data = await resp.json();
    return (data.results || []).map(r => r.path);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return null;
    return [];
  } finally {
    if (_pathController === controller) _pathController = null;
  }
}
