//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { escapeHtml } from '../../sdk/lib/html.js';

/** Usage snapshots older than this are stale. */
export const USAGE_STALE_MS = 5 * 60 * 1000;

/**
 * Human-friendly "resets in …" string from an ISO reset timestamp.
 * @param {string|undefined} resetsAt
 * @returns {string} e.g. "Resets in 3h 12m", or '' when unknown.
 */
export function formatResetIn(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Resets now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `Resets in ${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Resets in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `Resets in ${days}d ${hours % 24}h`;
}

/**
 * Title-case a plan label ("pro" → "Pro").
 * @param {string} plan
 * @returns {string} Title-cased plan label.
 */
export function formatPlan(plan) {
  if (!plan) return '';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * Whether a usage snapshot is older than {@link USAGE_STALE_MS}.
 * A missing or invalid timestamp is treated as fresh.
 * @param {import('../services/usage-stats-cache.js').UsageStats} usage
 * @returns {boolean} True when the snapshot is older than the stale window.
 */
export function isUsageStale(usage) {
  if (!usage || !usage.updatedAt) return false;
  const age = Date.now() - new Date(usage.updatedAt).getTime();
  return age >= USAGE_STALE_MS;
}

/**
 * Render one usage signal. A stat with a percentage renders as a labelled meter;
 * one without (for example, a raw balance) renders its absolute value instead.
 * @param {import('../services/usage-stats-cache.js').UsageStat} stat
 * @returns {string} HTML for one `.usage-stat` row.
 */
export function renderUsageRow(stat) {
  const reset = formatResetIn(stat.resetsAt);
  const resetRow = reset ? `<div class="usage-stat-reset">${escapeHtml(reset)}</div>` : '';
  const detail = stat.detail ? escapeHtml(stat.detail) : '';

  const hasPct = stat.usedPercent !== null && stat.usedPercent !== undefined
    && Number.isFinite(Number(stat.usedPercent));
  if (!hasPct) {
    return `
            <div class="usage-stat usage-stat-value">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${detail || '—'}</span>
                </div>
                ${resetRow}
            </div>`;
  }

  const pct = Math.max(0, Math.min(100, Number(stat.usedPercent) || 0));
  const level = pct > 80 ? 'usage-high' : (pct > 60 ? 'usage-medium' : '');
  let timeMarker = '';
  const windowSecs = Number(stat.windowSecs) || 0;
  if (stat.resetsAt && windowSecs > 0) {
    const msRemaining = new Date(stat.resetsAt).getTime() - Date.now();
    const msElapsed = windowSecs * 1000 - msRemaining;
    const timePct = Math.max(0, Math.min(100, msElapsed / (windowSecs * 1000) * 100));
    timeMarker = `<div class="usage-stat-time-marker" style="left:${timePct.toFixed(1)}%" aria-hidden="true"></div>`;
  }

  return `
            <div class="usage-stat">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${Math.round(pct)}%</span>
                </div>
                <div class="usage-stat-bar-wrap">
                    <div class="usage-stat-bar">
                        <div class="usage-stat-fill ${level}" style="width: ${pct}%;"></div>
                    </div>
                    ${timeMarker}
                </div>
                ${detail ? `<div class="usage-stat-detail">${detail}</div>` : ''}
                ${resetRow}
            </div>`;
}
