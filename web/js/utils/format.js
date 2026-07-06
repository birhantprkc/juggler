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
  // Remove trailing zeros and decimal point if not needed
  return formatted.replace(/\.?0+$/, '') + unit;
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

