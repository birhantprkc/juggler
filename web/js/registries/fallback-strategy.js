//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import StrategyType from 'juggler/strategy-type';

/**
 * FallbackStrategy - framework-owned last-resort strategy.
 *
 * Juggler is a hackable, plugin-based app: every strategy (including 'default')
 * ships in the `@juggler/core` extension and can be disabled via config. When a
 * conversation needs a strategy but none is registered — because the core
 * extension is disabled — the registry would otherwise have nothing to
 * instantiate and session load would throw, bricking the whole app (including
 * the Extensions settings the user needs to re-enable plugins).
 *
 * This strategy is NOT a plugin and is never placed in the registry's item map,
 * so it cannot be disabled. It is constructed directly by
 * {@link StrategyRegistry#createStrategy} as the final fallback, purely so the
 * registry always has something to instantiate and session load never throws.
 *
 * It is deliberately INERT: it defines no behaviour of its own. With no strategy
 * there is nothing to drive a turn, so the app refuses to start one at the
 * action site (`Conversation.sendMessage`, gated on `hasAnyStrategy()`) and
 * tells the user to enable a strategy in the Extensions settings. This class
 * exists only so the registry always has something to instantiate, keeping the
 * app alive and those settings reachable.
 * @augments {StrategyType}
 */
export default class FallbackStrategy extends StrategyType {
  /**
   * Strategy manifest. Mirrors the shape every strategy declares; the id is
   * never registered, so it cannot collide with a plugin's capability id.
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'fallback',
    name: 'No Strategy',
    version: '1.0.0',
    description: 'Built-in placeholder used when no strategy plugin is enabled. It only keeps the app alive and the Extensions settings reachable so a strategy can be re-enabled.',
    author: 'Juggler',
  };
}
