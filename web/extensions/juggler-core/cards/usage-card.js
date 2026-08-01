//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Usage info card — a quiet, live summary of quota windows for the provider
 * configured on the active conversation. It renders cache data immediately and
 * refreshes silently while focused, preserving the existing meter nodes whenever
 * their generated HTML has not changed.
 *
 * One info-card plugin of the `@juggler/core` extension; the host rail owns the
 * outer card chrome (eyebrow + × close), so this only fills the content region.
 * @module extensions/juggler-core/cards/usage-card
 */

import InfoCardType from 'juggler/info-card-type';
import providersCache from '../../../js/services/providers-cache.js';
import usageStatsCache from '../../../js/services/usage-stats-cache.js';
import { escapeHtml } from '../../../sdk/lib/html.js';
import { formatPlan, renderUsageRow } from '../../../js/utils/usage-renderer.js';

// Re-render/retry tick. Live network fetches are governed by the usage cache's
// own per-provider debounce (aligned to the upstream ~5-minute refresh), so this
// timer only needs to be frequent enough to pick up a fresh snapshot shortly
// after that window clears and to keep the "resets in …" text current — every
// tick before then is a cheap debounced no-op.
const REFRESH_MS = 60_000;

/**
 * Return the configured provider name for the session's active conversation.
 * @param {import('../../../js/model/session.js').default|undefined} session
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
 * The Usage info card.
 */
export default class UsageCard extends InfoCardType {
  /** @type {import('juggler/info-card-type').InfoCardManifest} */
  static MANIFEST = {
    id: 'usage',
    name: 'Usage',
    version: '1.0.0',
    description: 'Show your active model provider’s quota usage in the sidebar.',
    eyebrow: 'Usage',
    priority: 20,
  };

  /** @returns {boolean} Always renderable (it reports its own empty state). */
  hasContent() {
    return true;
  }

  /**
   * Paint cached usage immediately and silently refresh while the window is active.
   * @param {HTMLElement} contentEl
   * @param {import('../../../js/model/session.js').default} [session]
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
      // Only the active conversation's provider is ever shown, so fetch just that
      // one — never poll providers the user isn't looking at.
      const providerName = activeProvider(session);
      if (providerName) await usageStatsCache.refresh(providerName);
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
  }
}
