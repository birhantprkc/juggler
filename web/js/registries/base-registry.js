//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { resolveAssetUrl, importModuleUrl } from '../utils/asset-url.js';

/**
 * Extract the served URL from a capability descriptor. Tolerates a bare path
 * string for callers/tests that predate the `{path, extensionId}` descriptor.
 * @param {import('../services/extensions.js').CapabilityRef|string} descriptor
 * @returns {string} The served URL of the module
 */
function descriptorPath(descriptor) {
  return typeof descriptor === 'string' ? descriptor : descriptor.path;
}

/**
 * @typedef {object} LoadedEntry
 * @property {string} id - Capability id from the class MANIFEST
 * @property {*} ItemClass - The loaded class
 * @property {string} modulePath - Served URL the class was loaded from
 * @property {string|null} extensionId - id of the owning extension
 * @property {number} index - Position in the precedence-ordered descriptor list
 */

/**
 * BaseRegistry - Abstract base class for registry systems
 *
 * Provides common functionality for loading, validating, and managing
 * classes that use the manifest pattern (context items, actions, tools, etc.)
 * @abstract
 * @template T
 */
class BaseRegistry {
  /**
   * Create a new registry
   * @param {string} name - Registry name for logging
   * @param {string[]} requiredManifestFields - Required fields in manifest
   */
  constructor(name, requiredManifestFields = ['id', 'name', 'version', 'description']) {
    if (new.target === BaseRegistry) {
      throw new Error('BaseRegistry is abstract and cannot be instantiated directly');
    }

    /**
     * Registry name for logging
     * @type {string}
     * @protected
     */
    this.name = name;

    /**
     * Map of item ID to item class
     * @type {Map<string, T>}
     * @protected
     */
    this.items = new Map();

    /**
     * Map of item ID to module path
     * @type {Map<string, string>}
     * @protected
     */
    this.modulePaths = new Map();

    /**
     * Map of item ID to the id of the extension that provided it (null when the
     * capability has no owning extension). Used for grouping, precedence, and
     * the catalog UI.
     * @type {Map<string, string|null>}
     * @protected
     */
    this.itemExtensions = new Map();

    /**
     * Required manifest fields
     * @type {string[]}
     * @protected
     */
    this.requiredManifestFields = requiredManifestFields;

    /**
     * Whether the registry has been initialized
     * @type {boolean}
     * @protected
     */
    this.initialized = false;

    /**
     * Module paths that failed to load during init (path -> error message)
     * @type {Map<string, string>}
     * @protected
     */
    this._failedModules = new Map();

    /**
     * Items that are loaded but disabled via config (id -> class)
     * @type {Map<string, T>}
     * @protected
     */
    this._disabledItems = new Map();
  }

  /**
   * Get module paths to load
   *
   * Subclasses must implement this to return capability descriptors. Each is
   * `{path, extensionId}` — the served URL of the module and the id of the
   * extension that owns it (null when the capability has no owning extension).
   * The capability ID is extracted from each class's MANIFEST.id property.
   * May be async to support fetching extension paths from the backend.
   * @abstract
   * @returns {import('../services/extensions.js').CapabilityRef[]|Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors to load
   * @protected
   */
  getModulePaths() {
    throw new Error('Subclass must implement getModulePaths()');
  }

  /**
   * Validate a class
   *
   * Can be overridden by subclasses for additional validation
   * @param {T} ItemClass - Class to validate
   * @throws {Error} If class is invalid
   * @protected
   */
  validateClass(ItemClass) {
    if (typeof ItemClass !== 'function') {
      throw new Error(`${this.name} item must be a class`);
    }

    const ItemClassWithManifest = /** @type {any} */ (ItemClass);
    if (!ItemClassWithManifest.MANIFEST) {
      throw new Error(`${this.name} class must have a static MANIFEST property`);
    }

    for (const field of this.requiredManifestFields) {
      if (!ItemClassWithManifest.MANIFEST[field]) {
        throw new Error(`${this.name} manifest missing required field: ${field}`);
      }
    }
  }

  /**
   * Initialize the registry by loading all items
   * @async
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) {
      return;
    }

    // getModulePaths() may be async (it fetches the extension catalog). The
    // returned descriptors are ordered by precedence (low→high).
    const descriptors = await this.getModulePaths();

    // Pass 1 — import + validate every module concurrently, with graceful
    // degradation. Loading is order-independent; collisions are resolved
    // deterministically afterward so a parallel race can't pick the winner.
    const settled = await Promise.allSettled(
      descriptors.map(descriptor => this._importDescriptor(descriptor))
    );

    this._failedModules.clear();
    /** @type {LoadedEntry[]} */
    const loaded = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        loaded.push({ ...result.value, index });
      } else {
        const descriptor = /** @type {import('../services/extensions.js').CapabilityRef} */ (descriptors[index]);
        const failedPath = descriptorPath(descriptor);
        const errorMsg = result.reason?.message || String(result.reason);
        this._failedModules.set(failedPath, errorMsg);
        console.error(
          `[${this.name}] Failed to load plugin ${failedPath}:`,
          result.reason
        );
      }
    });

    // Pass 2 — resolve loaded entries into this.items by precedence.
    this._resolveLoaded(loaded);

    if (this._failedModules.size > 0) {
      console.warn(`[${this.name}] ${this._failedModules.size} plugin(s) failed to load`);
    }

    // Apply disabled plugin filtering
    await this._applyDisabledFilter();

    this.initialized = true;
  }

  /**
   * Resolve loaded entries into the registry, settling duplicate capability ids
   * by precedence (descriptor order). The lowest-precedence entry holds the id;
   * any other entry claiming the same id is a surfaced load error and is
   * ignored — never a silent last-write-wins.
   * @param {LoadedEntry[]} loaded - Successfully imported entries
   * @private
   */
  _resolveLoaded(loaded) {
    /** @type {Map<string, LoadedEntry[]>} */
    const groups = new Map();
    for (const entry of loaded) {
      const group = groups.get(entry.id);
      if (group) group.push(entry);
      else groups.set(entry.id, [entry]);
    }

    for (const [id, group] of groups) {
      group.sort((a, b) => a.index - b.index);
      const winner = /** @type {LoadedEntry} */ (group[0]); // lowest-precedence holder wins
      for (let i = 1; i < group.length; i++) {
        const candidate = /** @type {LoadedEntry} */ (group[i]); // bounded by i < group.length
        this._failedModules.set(candidate.modulePath,
          `duplicate capability id "${id}" already provided by "${winner.extensionId}"`);
        console.error(
          `[${this.name}] Duplicate capability id "${id}" from ${candidate.modulePath} ` +
          `(extension "${candidate.extensionId}") collides with "${winner.extensionId}"; ignoring`
        );
      }
      this.items.set(id, winner.ItemClass);
      this.modulePaths.set(id, winner.modulePath);
      this.itemExtensions.set(id, winner.extensionId);
    }
  }

  /**
   * Fetch disabled plugin IDs from config and move them to _disabledItems
   * @private
   * @returns {Promise<void>}
   */
  async _applyDisabledFilter() {
    try {
      const response = await fetch('/api/config/plugins');
      if (!response.ok) return;

      const { disabled } = await response.json();
      if (!Array.isArray(disabled) || disabled.length === 0) return;

      const disabledSet = new Set(disabled);
      this._disabledItems.clear();

      // A capability is disabled when either its own id OR the id of the
      // extension that provides it appears in the disabled set — so the catalog
      // can disable a whole extension by listing its extension id, without
      // enumerating every capability it bundles.
      for (const [id, ItemClass] of this.items) {
        const extId = this.itemExtensions.get(id);
        if (disabledSet.has(id) || (extId && disabledSet.has(extId))) {
          this._disabledItems.set(id, ItemClass);
        }
      }

      for (const id of this._disabledItems.keys()) {
        this.items.delete(id);
        console.info(`[${this.name}] Plugin "${id}" is disabled via config`);
      }
    } catch {
      // Config endpoint may not exist yet — silently skip
    }
  }

  /**
   * Import and validate a single capability module. Returns a LoadedEntry; does
   * NOT register it (collision resolution happens later in _resolveLoaded).
   * @async
   * @param {import('../services/extensions.js').CapabilityRef|string} descriptor - Capability descriptor (or bare path)
   * @returns {Promise<{id: string, ItemClass: *, modulePath: string, extensionId: string|null}>} Loaded entry
   * @throws {Error} If module cannot be loaded or is invalid
   * @private
   */
  async _importDescriptor(descriptor) {
    const modulePath = descriptorPath(descriptor);
    const extensionId = typeof descriptor === 'string' ? null : (descriptor.extensionId ?? null);
    try {
      // Prefix embedded builtin paths with the versioned asset prefix for cache
      // busting; disk-served plugin/extension paths are left untouched.
      const resolvedPath = resolveAssetUrl(modulePath);
      const module = await importModuleUrl(resolvedPath);

      if (!module.default) {
        throw new Error(`${this.name} module ${modulePath} does not have a default export`);
      }

      const ItemClass = module.default;

      // Validate class (this also ensures MANIFEST exists)
      this.validateClass(ItemClass);

      // Get ID from class's MANIFEST
      const ItemClassWithManifest = /** @type {any} */ (ItemClass);
      const id = ItemClassWithManifest.MANIFEST.id;

      if (!id) {
        throw new Error(`${this.name} class in ${modulePath} has no MANIFEST.id`);
      }

      return { id, ItemClass, modulePath, extensionId };
    } catch (error) {
      console.error(`[${this.name}] Failed to load ${this.name.toLowerCase()} from ${modulePath}:`, error);
      throw error;
    }
  }

  /**
   * Get an item class by ID
   * @param {string} id - Item ID
   * @returns {T|undefined} Item class or undefined if not found
   */
  get(id) {
    return this.items.get(id);
  }

  /**
   * Get an item class by ID, including items disabled via config. A disabled
   * capability is still loaded and retains its class (MANIFEST, tool
   * definitions, recommendations) — it is merely filtered out of `this.items`.
   * The catalog uses this so a disabled item's properties stay fully visible.
   * @param {string} id - Item ID
   * @returns {T|undefined} Item class (enabled or disabled), or undefined
   */
  getIncludingDisabled(id) {
    return this.items.get(id) ?? this._disabledItems.get(id);
  }

  /**
   * Check if an item exists
   * @param {string} id - Item ID
   * @returns {boolean} True if item exists
   */
  has(id) {
    return this.items.has(id);
  }

  /**
   * Get all registered item IDs
   * @returns {string[]} Array of item IDs
   */
  getIds() {
    return Array.from(this.items.keys());
  }

  /**
   * Get all registered items as array of {id, class} objects
   * @returns {Array<{id: string, class: T}>} Array of items
   */
  getAll() {
    return Array.from(this.items.entries()).map(([id, ItemClass]) => ({
      id,
      class: ItemClass
    }));
  }

  /**
   * Get all manifests
   * @returns {Array<{id: string, manifest: object, modulePath: string, extensionId: string|null}>} Array of manifests
   */
  getManifests() {
    return this.getAll().map(({ id, class: ItemClass }) => {
      const ItemClassWithManifest = /** @type {any} */ (ItemClass);
      return {
        id,
        manifest: ItemClassWithManifest.MANIFEST,
        modulePath: this.modulePaths.get(id) || '',
        extensionId: this.itemExtensions.get(id) ?? null
      };
    });
  }

  /**
   * Check if registry is initialized
   * @returns {boolean} True if initialized
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Reset the registry so it can be re-initialized (e.g., for plugin hot reload).
   * Clears all loaded items, module paths, failed modules, and disabled items.
   */
  reset() {
    this.initialized = false;
    this.items.clear();
    this.modulePaths.clear();
    this.itemExtensions.clear();
    this._failedModules.clear();
    this._disabledItems.clear();
  }

  /**
   * Get list of modules that failed to load
   * @returns {Array<{path: string, error: string}>} Array of failed modules with error messages
   */
  getFailedModules() {
    return Array.from(this._failedModules.entries()).map(([path, error]) => ({ path, error }));
  }

  /**
   * Check if a module path failed to load
   * @param {string} modulePath - Module path to check
   * @returns {boolean} True if the module failed to load
   */
  hasFailedModule(modulePath) {
    return this._failedModules.has(modulePath);
  }

  /**
   * Get all disabled items (loaded but excluded via config)
   * @returns {Array<{id: string, class: T}>} Array of disabled items
   */
  getDisabledItems() {
    return Array.from(this._disabledItems.entries()).map(([id, ItemClass]) => ({
      id,
      class: ItemClass
    }));
  }

  /**
   * Get manifests for every loaded capability — both the enabled ones and the
   * ones excluded via config — each tagged with a `disabled` flag and its owning
   * extension id. This is the single source the extensions catalog uses to show
   * a complete, attributed inventory (a disabled capability is still loaded and
   * has a manifest; it is merely filtered out of `this.items`).
   * @returns {Array<{id: string, manifest: object, modulePath: string, extensionId: string|null, disabled: boolean}>} Enabled and disabled capability entries
   */
  getCatalogManifests() {
    const enabled = this.getManifests().map(m => ({ ...m, disabled: false }));
    const disabled = Array.from(this._disabledItems.entries()).map(([id, ItemClass]) => ({
      id,
      manifest: /** @type {any} */ (ItemClass).MANIFEST,
      modulePath: this.modulePaths.get(id) || '',
      extensionId: this.itemExtensions.get(id) ?? null,
      disabled: true
    }));
    return [...enabled, ...disabled];
  }
}

export default BaseRegistry;
