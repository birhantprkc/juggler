//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * User-command factory — turns a declarative {@link UserCommandDef} (parsed from
 * a `.juggler/commands/*.md` file) into a runnable {@link CommandType} subclass.
 *
 * A user command is *data*: a prompt template plus a few execution options,
 * interpreted by one generic command class synthesised here. This keeps the
 * whole feature a single built-in behaviour rather than a per-command plugin.
 * @module plugins/user-command-factory
 */

import CommandType from 'juggler/command-type';
import providersCache from '../services/providers-cache.js';

const DEFAULT_ICON = 'icon-slash';

/**
 * Expand a prompt template's placeholders against invocation args.
 *
 * - `$1`..`$9` — positional args (1-based); unfilled expand to empty string.
 * - `$ARGUMENTS` — every arg joined by a single space.
 * - `$$` — a literal `$` (escape); so `$$1` yields the literal text `$1`.
 * - `$10` is `$1` followed by a literal `0` (placeholders are single-digit).
 *
 * Pure function — no IO, no `this`. This is the one place the placeholder syntax
 * is defined; it is unit-tested exhaustively.
 * @param {string} body - The template body
 * @param {string[]} [args] - Invocation arguments (positional)
 * @returns {string} The expanded prompt
 */
export function expandTemplate(body, args = []) {
  const argList = Array.isArray(args) ? args : [];
  return String(body).replace(/\$(\$|ARGUMENTS|[1-9])/g, (_match, token) => {
    if (token === '$') return '$';
    if (token === 'ARGUMENTS') return argList.join(' ');
    return argList[Number(token) - 1] ?? '';
  });
}

/**
 * Humanise a kebab-case command name into a display label
 * ("review-pr" → "Review Pr").
 * @param {string} name - Command name
 * @returns {string} Display label
 */
function humanize(name) {
  return name
    .split('-')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Resolve a bare model id to a concrete `{provider, model}` config by searching
 * the cached provider/model list. Returns null when the id is unknown (the
 * subthread then inherits the parent's model rather than failing).
 * @param {string} modelId - Model id from frontmatter
 * @returns {{provider: string, model: string}|null} Concrete config or null
 */
function resolveModelConfig(modelId) {
  if (!modelId) return null;
  for (const provider of providersCache.get()) {
    for (const m of provider.modelsWithContext || []) {
      if (m.id === modelId) {
        return { provider: provider.name, model: modelId };
      }
    }
  }
  return null;
}

/**
 * Build a {@link CommandType} subclass from a user-command definition. The
 * returned class carries a synthesised MANIFEST (id = the command name) and an
 * `execute` that interprets the definition's run mode.
 * @param {import('../services/user-commands.js').UserCommandDef} def - The definition
 * @returns {typeof CommandType} A command class ready to register
 */
export function makeUserCommandClass(def) {
  const fm = def.frontmatter || {};
  const runMode = fm.run || 'send';

  class UserCommand extends CommandType {
    static MANIFEST = {
      id: def.name,
      name: humanize(def.name),
      version: '1.0.0',
      description: fm.description || '',
      icon: fm.icon || DEFAULT_ICON,
      // Sending a message / opening a thread does not itself race a live turn
      // by snapshotting conversation items, so no cancel-and-settle gate.
      mutatesConversation: false,
      // Markers the slash menu / manager key off for provenance and behaviour.
      userDefined: true,
      scope: def.scope,
      argsHint: fm.argsHint || '',
      runMode,
    };

    /**
     * @param {string[]} args - Invocation arguments
     * @returns {Promise<import('juggler/command-type').CommandResult>} Result
     */
    async execute(args) {
      const text = expandTemplate(def.body || '', args);
      const thread = this.messageThread;
      if (!thread) return { handled: true, error: true, message: 'No active conversation' };

      switch (runMode) {
        case 'draft':
          // Splice the expanded template into the input box for editing before
          // send — declared as a side effect so the command never touches DOM.
          return { handled: true, sideEffects: [{ type: 'setDraft', data: { text } }] };

        case 'subthread': {
          // Fire-and-forget: create the sub-thread, open its column so the user
          // can watch, and return immediately. The result lands in the parent
          // per runInThread semantics. Strategy/model overrides apply to the
          // new thread only.
          const goal = fm.goal || humanize(def.name);
          const modelConfig = resolveModelConfig(fm.model || '');
          const promise = thread.runInThread({
            goal,
            prompt: text,
            strategyId: fm.strategy || '',
            modelConfig,
          });
          // Swallow cancellation/teardown — the parent surfaces the result.
          promise.catch((/** @type {any} */ err) => {
            if (err?.name !== 'AbortError') console.error('[UserCommand] subthread failed:', err);
          });
          return { handled: true };
        }

        case 'send':
        default:
          // Expand → send as a normal user turn on this thread.
          await thread.conversation.sendMessage(text, thread.threadItemId ?? null, thread);
          return { handled: true };
      }
    }
  }

  return UserCommand;
}
