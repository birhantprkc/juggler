//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Formatting utilities for displaying numbers in human-readable format
 */

/**
 * Format a number with SI suffixes (k, M, B, T)
 * @param {number} num - Number to format
 * @param {number} [decimals=1] - Number of decimal places
 * @returns {string} - Formatted number (e.g., "1.2k", "3.4M")
 */
export function formatNumber(num, decimals = 1) {
  if (num === 0) return '0';
  if (num < 1000) return num.toString();

  const units = ['', 'k', 'M', 'B', 'T'];
  const tier = Math.floor(Math.log10(Math.abs(num)) / 3);
  const unit = units[tier] || units[units.length - 1];
  const scaled = num / Math.pow(1000, tier);

  // Show decimals only if needed
  const formatted = scaled.toFixed(decimals);
  // Remove trailing zeros and the decimal point if they're now redundant — but
  // ONLY when a decimal point is present. Stripping unconditionally corrupts
  // round integer results at decimals=0 (e.g. "100" → "1", so 100000 → "1k").
  const trimmed = formatted.includes('.')
    ? formatted.replace(/\.?0+$/, '')
    : formatted;
  return trimmed + unit;
}

/**
 * Format a byte count as a short human-readable size (e.g. "0 B", "9.4 KB",
 * "12 MB", "3.2 GB"). Values below 10 keep one decimal; larger values round.
 * Returns '' for an invalid/negative input so callers can omit the field.
 * @param {number} bytes
 * @returns {string} The formatted size, or '' for invalid input.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/**
 * Short relative "N ago" string from a unix-ms timestamp: "just now",
 * "N min ago", "N hr(s) ago", "N day(s) ago".
 * @param {number} ms - Unix-ms timestamp in the past
 * @returns {string} A short "N min ago"-style string, or '' for a falsy input.
 */
export function formatTimeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 45000) return 'just now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Compact token count for UI labels: 2000+ collapses to "Nk" (floored), below
 * that the exact count with thousands separators. Shared by the footer token
 * pill, thinking-message summaries, and the model selector so token counts read
 * consistently everywhere.
 * @param {number} n - Token count
 * @returns {string} Formatted count, e.g. "272k" or "1,500"
 */
export function formatTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 2000) return Math.floor(v / 1000) + 'k';
  return v.toLocaleString();
}

/**
 * Format a date/time as a compact relative string with a longer
 * tooltip-friendly absolute string. App-wide canonical relative
 * date-time formatter — keep all UI date rendering routed through this
 * so labels stay consistent. Today → "HH:MM:SS"; yesterday →
 * "Yesterday, HH:MM:SS"; otherwise "Mon D, HH:MM:SS".
 * @param {number|string|Date} input - Unix ms, ISO string, or Date
 * @returns {{short: string, full: string}} compact label + full absolute label for tooltips
 */
export function formatRelativeDateTime(input) {
  const date = input instanceof Date
    ? input
    : typeof input === 'number'
      ? new Date(input)
      : new Date(String(input));
  if (isNaN(date.getTime())) {
    const raw = String(input);
    return { short: raw, full: raw };
  }
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isToday = date.toDateString() === now.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const timeStr = date.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const full = date.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  let prefix = '';
  if (isYesterday) {
    prefix = 'Yesterday, ';
  } else if (!isToday) {
    prefix = date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ';
  }
  return { short: prefix + timeStr, full };
}

