//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import FallbackStrategy from './fallback-strategy.js';

/**
 * StrategyRegistry - JavaScript-based strategy registry system
 *
 * Manages strategy loading and lifecycle.
 * Strategies control how the LLM approaches tasks (loop behavior, context assembly,
 * sub-conversation spawning, etc.).
 * @augments {BaseRegistry<typeof import('juggler/strategy-type').default>}
 */
class StrategyRegistry extends BaseRegistry {
  /**
   * Create a new strategy registry
   */
  constructor() {
    super('StrategyRegistry', ['id', 'name', 'version', 'description']);

    /**
     * Whether we have already logged that no strategy is registered, so the
     * degraded-mode notice is emitted once per registry state — not once per
     * MessageThread construction (a conversation walk builds one strategy per
     * thread, which would otherwise flood the console). Cleared on reset().
     * @type {boolean}
     * @private
     */
    this._warnedNoStrategy = false;
  }

  /**
   * Whether any strategy is registered (enabled). When false the app is in the
   * degraded "no strategy" mode: every strategy ships in `@juggler/core` and the
   * user has disabled it (or all strategy plugins). Callers that start an LLM
   * turn use this to refuse and point the user at the Extensions settings rather
   * than silently running the inert fallback.
   * @returns {boolean} True if at least one strategy is registered
   */
  hasAnyStrategy() {
    return this.items.size > 0;
  }

  /**
   * Clear loaded strategies (and the one-shot no-strategy warning latch) so the
   * degraded-mode notice can fire again after a reload that is still empty.
   */
  reset() {
    super.reset();
    this._warnedNoStrategy = false;
  }

  /**
   * Get strategy capability descriptors (implements abstract method)
   *
   * Returns the strategy capabilities of every enabled extension — the
   * `@juggler/core` builtin extension and any user/project extensions. The ID is
   * extracted from each class's MANIFEST.id property.
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('strategy');
  }

  /**
   * Get all strategy manifests for system prompt
   *
   * Returns manifest metadata for all registered strategies.
   * Used to generate the strategy section in the system prompt.
   * @returns {Array<{id: string, manifest: import('juggler/strategy-type').StrategyManifest, extensionId: string|null}>} Array of strategy metadata
   */
  getAllManifests() {
    const manifests = [];

    for (const [id, StrategyClass] of this.items) {
      if (!StrategyClass.MANIFEST) {
        throw new Error(`Strategy ${id} is missing required MANIFEST property`);
      }
      manifests.push({
        id,
        manifest: StrategyClass.MANIFEST,
        extensionId: this.itemExtensions.get(id) ?? null
      });
    }

    return manifests;
  }

  /**
   * Create a strategy instance for a conversation
   *
   * All strategy methods are instance-based to enable per-conversation state.
   * Each conversation owns its own strategy instance.
   * @param {string} id - Strategy ID
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {import('juggler/strategy-type').default} Strategy instance
   */
  createStrategy(id, messageThread) {
    let StrategyClass = this.get(id);

    // A saved session may reference a strategy that was removed/renamed — fall
    // back to 'default' if it is available (and is not what we already asked for).
    if (!StrategyClass && id !== 'default') {
      const fallbackDefault = this.get('default');
      if (fallbackDefault) {
        console.warn(`[StrategyRegistry] Strategy "${id}" not found, falling back to "default"`);
        StrategyClass = fallbackDefault;
      }
    }

    if (!StrategyClass) {
      // No registered strategy at all — every strategy ships in `@juggler/core`
      // and it (or all strategy plugins) has been disabled. Use the framework's
      // built-in fallback (not a plugin, so it can't be disabled) instead of
      // throwing: a missing strategy must degrade gracefully, not brick session
      // load and lock the user out of the Extensions settings they need to
      // re-enable it. The fallback is inert (it never runs an LLM turn) — the
      // user is told to enable a strategy at the point they try to send. Log the
      // degraded mode once per registry state, not once per thread.
      if (!this._warnedNoStrategy) {
        console.warn('[StrategyRegistry] No strategy is registered (all strategy plugins disabled); using the inert built-in fallback. Enable a strategy in the Extensions settings.');
        this._warnedNoStrategy = true;
      }
      StrategyClass = FallbackStrategy;
    }

    return new StrategyClass({ messageThread });
  }
}

// Create and export singleton registry instance
const strategyRegistry = new StrategyRegistry();

export default strategyRegistry;
