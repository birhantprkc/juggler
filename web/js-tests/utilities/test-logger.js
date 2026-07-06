//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/* eslint-disable no-console, no-restricted-syntax */
/**
 * Test Logger - Simple logging system with verbosity levels
 * This file is the logger implementation itself, so it must use console.log directly.
 * @module test-logger
 */

/**
 * @typedef {'quiet'|'normal'|'verbose'} LogLevel
 */

/**
 * Extend window with test-specific properties
 * @typedef {Window & typeof globalThis & {
 *   quietMode?: boolean
 * }} TestWindow
 */

/**
 * Logger class for test output with verbosity control
 * @class
 */
class TestLogger {
  constructor() {
    /** @type {LogLevel} @private */
    this._level = 'normal';
  }

  /**
   * Set logging level
   * @param {LogLevel} level - Logging level
   */
  setLevel(level) {
    this._level = level;
  }

  /**
   * Get current logging level
   * @returns {LogLevel} The current logging level
   */
  getLevel() {
    return this._level;
  }

  /**
   * Format arguments into a single string for logging
   * @param {...any} args - Arguments to format
   * @returns {string} Formatted string
   * @private
   */
  _format(...args) {
    return args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  }

  /**
   * Log at ESSENTIAL level - always shown (test progress, results, errors)
   * These messages are prefixed with [ESSENTIAL] for Go-side filtering
   * @param {...any} args - Arguments to log
   */
  essential(...args) {
    // Format as single string so chromedp captures it as one message
    console.log('[ESSENTIAL] ' + this._format(...args));
  }

  /**
   * Log at INFO level - shown in normal/verbose mode
   * These messages are prefixed with [INFO] for Go-side filtering
   * @param {...any} args - Arguments to log
   */
  info(...args) {
    // Format as single string so chromedp captures it as one message
    console.log('[INFO] ' + this._format(...args));
  }

  /**
   * Log at DEBUG level - shown only in verbose mode
   * These messages are prefixed with [DEBUG] for Go-side filtering
   * @param {...any} args - Arguments to log
   */
  debug(...args) {
    // Format as single string so chromedp captures it as one message
    console.log('[DEBUG] ' + this._format(...args));
  }

  /**
   * Log LLM request/response blocks - shown only in verbose mode
   * These messages are prefixed with [LLM] for Go-side filtering
   * @param {...any} args - Arguments to log
   */
  llm(...args) {
    // Format as single string so chromedp captures it as one message
    console.log('[LLM] ' + this._format(...args));
  }

  /**
   * Log errors - always shown
   * @param {...any} args - Arguments to log
   */
  error(...args) {
    // Format as single string so chromedp captures it as one message
    console.error('[ESSENTIAL] ' + this._format(...args));
  }

  /**
   * Log warnings - always shown
   * @param {...any} args - Arguments to log
   */
  warn(...args) {
    // Format as single string so chromedp captures it as one message
    console.warn('[ESSENTIAL] ' + this._format(...args));
  }
}

// Create singleton instance
const logger = new TestLogger();

// Initialize from URL parameter or window.quietMode
const urlParams = new URLSearchParams(window.location.search);
const testWindow = /** @type {TestWindow} */ (/** @type {any} */ (window));
if (urlParams.get('quiet') === 'true' || testWindow.quietMode) {
  logger.setLevel('quiet');
} else if (urlParams.get('verbose') === 'true') {
  logger.setLevel('verbose');
}

export default logger;
