//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Skills marketplace service — the client for the discover/install endpoints in
 * skills_registry.go. Sibling to skills.js (which stays read-only discovery of
 * already-installed skills). All catalog filtering is client-side over the cached
 * catalog, so this module only fetches the whole catalog (and forces refreshes),
 * fetches one entry for preview, installs, and uninstalls.
 *
 *   GET    /api/skills/catalog[?refresh=1]        → { entries, sources }
 *   GET    /api/skills/catalog/entry?source=&path= → { entry, body, files }
 *   POST   /api/skills/install                     → { installedPath, name, ... }
 *   DELETE /api/skills/{scope}/{source}/{name}     → uninstall
 *   GET    /api/skills/registries                  → source status
 *   POST   /api/skills/registries { url }          → add custom source
 *   DELETE /api/skills/registries/{id}             → remove custom source
 *
 * Every entry field is remote, attacker-controllable data — callers escape it in
 * the DOM and render bodies only through renderMarkdown(..., { escapeXml:true }).
 * @module services/skills-registry
 */

/**
 * @typedef {object} CatalogInstalled
 * @property {'user'|'project'} scope - Provenance scope of the install.
 * @property {'juggler'|'agents'} source - Root source of the install.
 * @property {string} path - Absolute installed directory
 * @property {boolean} upToDate - False when an update is available (dirSha differs)
 */

/**
 * @typedef {object} CatalogEntry
 * @property {string} id - "<source>:<path>"
 * @property {string} source - Source id
 * @property {string} path - Remote skill directory (the identity within a source)
 * @property {string} name - Slugified suggested install name
 * @property {boolean} slugged - True when name differs from the remote basename
 * @property {string[]} category - Path segments between skillsRoot and the skill dir
 * @property {string} description - Effective description from frontmatter.
 * @property {string} [license] - License name if declared.
 * @property {boolean} hasScripts - Whether the skill ships a scripts/ dir.
 * @property {boolean} hasHooks - Whether the skill ships a hooks/ dir.
 * @property {number} fileCount - Number of files in the skill dir.
 * @property {number} totalSize - Aggregate byte size (tree-reported).
 * @property {string} sourceUrl - Human 'View on GitHub' URL.
 * @property {string} ref - Configured ref (branch/tag/sha).
 * @property {string} commit - Resolved commit the catalog is pinned to.
 * @property {string} dirSha - The skill dir's tree sha (update signal).
 * @property {CatalogInstalled|null} installed - Local install info, or null.
 * @property {string} [error] - Error message, if any.
 */

/**
 * @typedef {object} CatalogSourceStatus
 * @property {string} id - Source id.
 * @property {string} label - Human-facing source name.
 * @property {string} repo - 'owner/name'.
 * @property {'official'|'community'|'custom'} trust - Trust tier.
 * @property {string} [fetchedAt] - Last fetch time (RFC3339), if cached.
 * @property {boolean} stale - Whether the cache is past its TTL.
 * @property {boolean} [truncated] - Whether the git tree was truncated.
 * @property {number} entryCount - Number of skills discovered.
 * @property {string} [error] - Error message, if any.
 */

/**
 * @typedef {object} CatalogResponse
 * @property {CatalogEntry[]} entries - Every source's entries merged.
 * @property {CatalogSourceStatus[]} sources - Per-source fetch status.
 */

/** @type {CatalogResponse|null} */
let cachedCatalog = null;

/**
 * Fetch the merged catalog across all sources. Cached in-memory after the first
 * call; pass `force` to bypass the memory cache, and `refresh` to make the
 * backend re-fetch from the registries (network) rather than serve its disk cache.
 * @param {{ force?: boolean, refresh?: boolean }} [opts]
 * @returns {Promise<CatalogResponse>} The merged catalog and per-source status.
 */
export async function fetchCatalog({ force = false, refresh = false } = {}) {
  if (cachedCatalog && !force && !refresh) {
    return cachedCatalog;
  }
  const url = refresh ? '/api/skills/catalog?refresh=1' : '/api/skills/catalog';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load skill catalog: ${res.status}`);
  }
  const data = await res.json();
  cachedCatalog = {
    entries: Array.isArray(data.entries) ? data.entries : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
  };
  return cachedCatalog;
}

/** Drop the in-memory catalog cache (e.g. after add/remove source or install). */
export function resetCatalogCache() {
  cachedCatalog = null;
}

/**
 * Fetch one entry's SKILL.md body and file manifest for the preview drawer.
 * @param {string} source - Source id
 * @param {string} path - Remote skill directory
 * @returns {Promise<{ entry: CatalogEntry, body: string, files: Array<{path:string,size:number,runs:boolean}> }>} The entry, its SKILL.md body, and file manifest.
 */
export async function fetchCatalogEntry(source, path) {
  const url = `/api/skills/catalog/entry?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load skill preview: ${await errorText(res)}`);
  }
  return res.json();
}

/**
 * Install a skill into a local root. Resolves to the backend result on success;
 * on a name collision the backend returns 409 — this surfaces it as a typed
 * error the caller can branch on (`err.collision === true`).
 * @param {object} req
 * @param {string} req.source - Source id
 * @param {string} req.path - Remote skill directory
 * @param {string} req.targetName - Confirmed, valid install name
 * @param {'user'|'project'} req.scope
 * @param {'juggler'|'agents'} req.target - Root source
 * @param {'install'|'overwrite'} [req.mode]
 * @returns {Promise<{ installedPath: string, name: string, scope: string, source: string }>} The installed location.
 */
export async function installSkill(req) {
  const res = await fetch('/api/skills/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'install', ...req }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || 'A skill with that name already exists');
    /** @type {any} */ (err).collision = true;
    /** @type {any} */ (err).existing = body.existing;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Install failed: ${await errorText(res)}`);
  }
  resetCatalogCache();
  return res.json();
}

/**
 * Uninstall a skill from a managed root (works on any skill there, not only
 * marketplace installs).
 * @param {'user'|'project'} scope
 * @param {'juggler'|'agents'} source
 * @param {string} name
 * @returns {Promise<void>} Resolves once removed.
 */
export async function uninstallSkill(scope, source, name) {
  const url = `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(source)}/${encodeURIComponent(name)}`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Uninstall failed: ${await errorText(res)}`);
  }
  resetCatalogCache();
}

/**
 * Add a custom source from a github.com URL or "owner/repo".
 * @param {string} url
 * @param {string} [label]
 * @returns {Promise<CatalogSourceStatus>} The added source status.
 */
export async function addSource(url, label) {
  const res = await fetch('/api/skills/registries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, label }),
  });
  if (!res.ok) {
    throw new Error(`Could not add source: ${await errorText(res)}`);
  }
  resetCatalogCache();
  return res.json();
}

/**
 * Fetch the seed sources a fresh install starts with, so the add-source menu can
 * offer to restore any that were removed.
 * @returns {Promise<Array<{id:string,label:string,repo:string,trust:string}>>} The default sources.
 */
export async function fetchDefaultSources() {
  const res = await fetch('/api/skills/registries/defaults');
  if (!res.ok) {
    throw new Error(`Could not load default sources: ${await errorText(res)}`);
  }
  return res.json();
}

/**
 * Restore a default source by its seed id, re-adding the exact curated definition
 * (label, trust) rather than a generic custom source.
 * @param {string} id
 * @returns {Promise<{id:string,label:string,repo:string,trust:string}>} The restored source.
 */
export async function restoreDefaultSource(id) {
  const res = await fetch(`/api/skills/registries/defaults/${encodeURIComponent(id)}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Could not add source: ${await errorText(res)}`);
  }
  resetCatalogCache();
  return res.json();
}

/**
 * Remove a source by id. All sources are equal — seeded defaults are removable
 * too, and the removal persists (a removed seed is not re-added).
 * @param {string} id
 * @returns {Promise<void>} Resolves once removed.
 */
export async function removeSource(id) {
  const res = await fetch(`/api/skills/registries/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Could not remove source: ${await errorText(res)}`);
  }
  resetCatalogCache();
}

/**
 * Extract a human error string from a non-OK response's JSON envelope.
 * @param {Response} res
 * @returns {Promise<string>} A human-readable error message.
 */
async function errorText(res) {
  try {
    const body = await res.json();
    if (body && body.error) return body.error;
  } catch {
    // non-JSON body — fall through
  }
  return res.statusText || `HTTP ${res.status}`;
}
