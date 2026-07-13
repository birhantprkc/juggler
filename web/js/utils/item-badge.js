//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Single source of truth for a conversation item's badge identity — the
 * circular icon (colour + glyph) and the type-name lozenge label.
 *
 * EVERY site that paints the `.message-icon-badge` resolves it here, so the
 * conversation-list tile and the properties-panel header can never drift:
 *  - conversation tiles (tool-action-message / context-item-message /
 *    thread-message / thinking-message) via `iconOptionsForItem`
 *  - the properties-panel header (services/renderers/item-renderers) via
 *    `badgeForItem` (icon options + lozenge label together)
 *
 * The icon glyph/colour comes from each plugin's static `getBadgeOptions()`;
 * the lozenge label comes from the plugin's own `getStatusUI().typeName`
 * (e.g. "Read", "Grep") with a fallback to its static type label — the exact
 * text the tile shows — never the raw tool name.
 * @module item-badge
 */

import { TYPE_ICONS, TYPE_COLORS } from './icon-message-renderer.js';
import contextItemRegistry from '../registries/context-item-registry.js';

const USER_AVATAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="M480-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Z"/></svg>';

/**
 * @typedef {object} BadgeContext
 * @property {any} [conversation] - Current Conversation (for plugin instance construction)
 * @property {any} [messageThread] - Current MessageThread (resolves context-item instances by id)
 * @property {string} [fallbackType] - Item type to assume when the item itself can't report one
 *   (used by attribute-driven tiles like thinking-message that hold no Yjs item)
 */

/**
 * @typedef {object} IconOptions
 * @property {string} color - Colour preset name
 * @property {string} [iconClass] - CSS mask-class icon
 * @property {string} [iconSvg] - Inline SVG icon (fallback when no mask class)
 */

/**
 * Icon options for a context-item plugin instance, from its static badge.
 * @param {any} instance - Context-item plugin instance
 * @returns {IconOptions} Icon options
 */
function contextItemIconOptions(instance) {
  const badge = instance.getBadgeOptions?.() ?? { color: 'slate' };
  const iconSvg = /** @type {any} */ (badge).iconSvg;
  return {
    color: badge.color,
    iconClass: badge.icon || undefined,
    iconSvg: iconSvg || (badge.icon ? undefined : TYPE_ICONS.context),
  };
}

/**
 * Icon options from a plugin CLASS's static getBadgeOptions() — the mask-class
 * icon + colour every plugin-backed item (tool-action, thread) shares. Falls
 * back to an inline SVG only when the plugin declares no mask-class icon.
 * @param {any} PluginClass - Plugin class, or null/undefined
 * @param {string} [fallbackSvg] - Inline SVG used when the plugin has no icon class
 * @returns {IconOptions} Icon options
 */
function classIconOptions(PluginClass, fallbackSvg) {
  const badge = PluginClass?.getBadgeOptions?.() ?? { color: 'slate' };
  return badge.icon
    ? { color: badge.color, iconClass: badge.icon }
    : { color: badge.color, iconSvg: fallbackSvg };
}

/**
 * Whether a value is a context-item plugin instance (vs a Yjs message item).
 * @param {any} item - Candidate
 * @returns {boolean} True if it looks like a context-item instance
 */
function isContextItemInstance(item) {
  return !!item && typeof item.getTitle === 'function';
}

/**
 * Resolve the context-item ActionClass a Yjs item's `toolName` maps to, or null
 * when the item carries no tool name or none is registered. Shared by the icon
 * and type-name paths for both delegated threads and tool-action items.
 * @param {any} item - Yjs message item (tool-action or delegated thread).
 * @returns {typeof import('juggler/context-item').default|null} The class, or null.
 */
function actionClassFor(item) {
  const toolName = item?.get?.('toolName');
  return toolName ? (contextItemRegistry.getByToolName(toolName) ?? null) : null;
}

/**
 * Resolve the circular icon's colour + glyph for a conversation item. Shared by
 * the tiles and the panel so the icon is identical in both.
 * @param {any} item - Yjs message item (has `.get('type')`) or a context-item instance
 * @param {BadgeContext} [ctx] - Resolution context
 * @returns {IconOptions} Icon options ready for createIconBox/createIconBadge
 */
export function iconOptionsForItem(item, ctx = {}) {
  if (isContextItemInstance(item)) return contextItemIconOptions(item);

  const type = item?.get?.('type') ?? ctx.fallbackType;
  switch (type) {
    case 'error': return { color: /** @type {string} */ (TYPE_COLORS.error), iconSvg: TYPE_ICONS.error };
    case 'user': return { color: 'green', iconSvg: USER_AVATAR_SVG };
    case 'thinking': return { color: /** @type {string} */ (TYPE_COLORS.thinking), iconSvg: TYPE_ICONS.thinking };
    case 'assistant': return { color: 'slate', iconSvg: TYPE_ICONS.assistant };
    case 'thread': {
      // A delegated thread carries its delegating tool's name (threads.go stamps
      // `toolName` on the thread Y.Map). Badge it as that tool — the same lookup
      // the tool-action case uses — so e.g. a WebFetch subthread shows the globe
      // icon rather than the generic thread glyph. Undelegated threads have no
      // toolName and keep the plain thread badge.
      const ActionClass = actionClassFor(item);
      if (ActionClass) return classIconOptions(ActionClass, TYPE_ICONS.action);
      return classIconOptions(contextItemRegistry.get('thread'), TYPE_ICONS.context);
    }
    case 'tool-action': {
      return classIconOptions(actionClassFor(item), TYPE_ICONS.action);
    }
    case 'context-item': {
      const inst = ctx.messageThread?.getContextItem?.(item.get('itemId'));
      return inst ? contextItemIconOptions(inst) : { color: 'blue', iconSvg: TYPE_ICONS.context };
    }
    default:
      return { color: 'slate', iconSvg: TYPE_ICONS.assistant };
  }
}

/**
 * Construct a throwaway plugin instance for a getStatusUI() call, mirroring the
 * args the tile passes so the label resolves identically.
 * @param {any} PluginClass - Plugin class
 * @param {BadgeContext} ctx - Resolution context
 * @returns {any} Instance, or null if construction throws
 */
function makeInstance(PluginClass, ctx) {
  try {
    return new PluginClass({
      id: 'item-badge',
      session: ctx.conversation?.session,
      conversation: ctx.conversation,
      messageThread: ctx.messageThread,
    });
  } catch {
    return null;
  }
}

/**
 * The type-name lozenge label, pulled from the plugin's own getStatusUI so it
 * reads exactly like the tile (e.g. "Read", not "readFile"/"Read File").
 * getStatusUI is a pure viewer-side config builder; the call is guarded because
 * a plugin may read result fields we can't reconstruct, falling back to its
 * static type label then the supplied fallback.
 * @param {any} instance - Plugin instance, or null
 * @param {any} PluginClass - Plugin class, or null
 * @param {any[]} statusArgs - Arguments forwarded to getStatusUI
 * @param {string} fallback - Last-resort label
 * @returns {string} The lozenge label
 */
function pluginTypeName(instance, PluginClass, statusArgs, fallback) {
  try {
    const cfg = instance?.getStatusUI?.(...statusArgs);
    if (cfg?.typeName) return cfg.typeName;
  } catch { /* plugin needs richer status than we have; use the static label */ }
  return PluginClass?.getTypeName?.() || PluginClass?.MANIFEST?.name || fallback;
}

/**
 * Reconstruct the (actionStatus, input, context) args a tool-action tile passes
 * to getStatusUI: the completed result when present, else the pending/running
 * shape for an in-flight tool.
 * @param {any} item - Tool-action Yjs item
 * @param {BadgeContext} ctx - Resolution context
 * @returns {any[]} Args array for getStatusUI
 */
function toolActionStatusArgs(item, ctx) {
  const toolName = (item.get('toolName') || '').toLowerCase();
  const rawInput = item.get('toolInput');
  const input = rawInput?.toJSON ? rawInput.toJSON() : (rawInput || {});
  const rawResult = item.get('result');
  const resultPlain = rawResult?.toJSON ? rawResult.toJSON() : (rawResult || null);
  const dd = item.get('displayData');
  const actionStatus = resultPlain
    ? { content: resultPlain.content || '', ...resultPlain }
    : { pending: true, actionId: toolName, displayData: dd?.toJSON ? dd.toJSON() : dd, state: item.get('state') };
  const context = {
    conversation: ctx.conversation,
    messageThread: ctx.messageThread,
    session: ctx.conversation?.session,
    toolUseId: item.get('toolUseId'),
  };
  return [actionStatus, input, context];
}

/**
 * Resolve the type-name lozenge label for a conversation item.
 * @param {any} item - Yjs message item or a context-item instance
 * @param {BadgeContext} [ctx] - Resolution context
 * @returns {string} The lozenge label
 */
export function typeNameForItem(item, ctx = {}) {
  if (isContextItemInstance(item)) {
    const fallback = item.getManifest?.()?.name || item.type || 'Context Item';
    return pluginTypeName(item, item.constructor, [], fallback);
  }

  const type = item?.get?.('type') ?? ctx.fallbackType;
  switch (type) {
    case 'error': return 'Error';
    case 'user': return 'User Message';
    case 'thinking': return 'Thinking';
    case 'assistant': return 'Assistant Message';
    case 'thread': {
      // Delegated threads label as their delegating tool (e.g. "Web Fetch")
      // rather than the generic "Thread"; mirrors the tool-action label path but
      // uses the static type label (no per-call tool result to feed getStatusUI).
      const toolName = item?.get?.('toolName');
      const ActionClass = actionClassFor(item);
      if (ActionClass) return pluginTypeName(null, ActionClass, [], toolName);
      return pluginTypeName(null, contextItemRegistry.get('thread'), [], 'Thread');
    }
    case 'tool-action': {
      const toolName = item.get('toolName');
      const ActionClass = actionClassFor(item);
      const instance = ActionClass ? makeInstance(ActionClass, ctx) : null;
      return pluginTypeName(instance, ActionClass, toolActionStatusArgs(item, ctx), toolName || 'Tool Action');
    }
    case 'context-item': {
      const inst = ctx.messageThread?.getContextItem?.(item.get('itemId'));
      if (inst) {
        const fallback = inst.getManifest?.()?.name || inst.type || 'Context Item';
        return pluginTypeName(inst, inst.constructor, [], fallback);
      }
      return item.get?.('type') || 'Context Item';
    }
    default:
      return 'Message';
  }
}

/**
 * Resolve the full badge — icon options plus the lozenge label — for a
 * conversation item. The panel header builds its `.message-icon-badge` from
 * this; tiles that only need the icon use `iconOptionsForItem` directly.
 * @param {any} item - Yjs message item or a context-item instance
 * @param {BadgeContext} [ctx] - Resolution context
 * @returns {IconOptions & {typeName: string}} Icon options plus lozenge label
 */
export function badgeForItem(item, ctx = {}) {
  return { ...iconOptionsForItem(item, ctx), typeName: typeNameForItem(item, ctx) };
}
