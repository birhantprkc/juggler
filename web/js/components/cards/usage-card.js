//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//   ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
// ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The Usage info card — a quiet, live summary of quota windows for the provider
 * configured on the active conversation. It renders cache data immediately and
 * refreshes silently while focused, preserving the existing meter nodes whenever
 * their generated HTML has not changed.
 * @module components/cards/usage-card
 */

import providersCache from '../../services/providers-cache.js';
import usageStatsCache from '../../services/usage-stats-cache.js';
import { escapeHtml } from '../../../sdk/lib/html.js';
import { formatPlan, renderUsageRow } from '../../utils/usage-renderer.js';

const REFRESH_MS = 30_000;

/**
 * Return the configured provider name for the session's active conversation.
 * @param {import('../../model/session.js').default|undefined} session
 * @returns {string} Provider name, or ''.
 */
function activeProvider(session) {
  return session?.getVisibleConversation?.()?.modelConfig?.provider || '';
}

/**
 * The provider's display name from the latest server-pushed provider list.
 * @param {string} providerName
 * @returns {string} Human-friendly provider label.
 */
function providerLabel(providerName) {
  return providersCache.get().find((provider) => provider.name === providerName)?.displayName || providerName;
}

/**
 * The Usage info card provider.
 * @type {import('../info-rail.js').InfoCardProvider}
 */
export const usageCard = {
  id: 'usage',
  eyebrow: 'Usage',
  settingsLabel: 'Usage',
  settingsDescription: 'Show your active model provider’s quota usage in the sidebar.',
  defaultEnabled: true,

  /** @returns {boolean} Always renderable (it reports its own empty state). */
  hasContent() {
    return true;
  },

  /**
   * Paint cached usage immediately and silently refresh while the window is active.
   * @param {HTMLElement} contentEl
   * @param {import('../../model/session.js').default} [session]
   * @returns {() => void} Teardown that stops polling and listeners.
   */
  mount(contentEl, session = undefined) {
    let disposed = false;
    /** @type {string|null} */
    let lastHTML = null;
    let lastProvider = '';

    const focused = () => typeof document === 'undefined' || document.hasFocus();
    const render = () => {
      if (disposed) return;
      const providerName = activeProvider(session);
      const usage = usageStatsCache.get(providerName);
      const stats = usage?.stats || [];
      const hasStats = stats.length > 0;
      const subtitle = providerName
        ? `<div class="info-card__usage-sub">${escapeHtml(providerLabel(providerName))}${usage?.plan ? ` · ${escapeHtml(formatPlan(usage.plan))}` : ''}</div>`
        : '';
      const body = hasStats
        ? stats.map(renderUsageRow).join('')
        : '<p class="info-card__body">No usage data</p>';
      const html = `${subtitle}${body}`;
      if (html !== lastHTML) {
        contentEl.innerHTML = html;
        lastHTML = html;
      }
    };

    const refresh = async () => {
      if (disposed || !focused()) return;
      await usageStatsCache.refresh();
      render();
    };
    const onFocus = () => { refresh(); };
    const onSessionEvent = () => {
      const providerName = activeProvider(session);
      if (providerName !== lastProvider) {
        lastProvider = providerName;
        render();
        refresh();
      }
    };

    lastProvider = activeProvider(session);
    render();
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    const unsubscribe = session?.subscribe?.(onSessionEvent);

    return () => {
      disposed = true;
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  },
};

export default usageCard;
