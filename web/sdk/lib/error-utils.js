//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Error Utilities
 *
 * Centralized error handling utilities for consistent error extraction
 * and formatting across plugin execution.
 */

/**
 * @typedef {object} ErrorInfo
 * @property {string} message - Error message
 * @property {string|null} stack - Stack trace (null if not available)
 */

/**
 * Extract a string error message from any value.
 * CRITICAL: Use this instead of String() for ANY value that might be an object.
 * String() on an object produces "[object Object]" which is useless.
 * This function extracts meaningful messages from structured errors.
 * @param {unknown} error - Error value (string, Error, object, or primitive)
 * @returns {string} Human-readable error message
 */
export function extractErrorMessage(error) {
  // Already a string - return as-is
  if (typeof error === 'string') return error;

  // Standard Error object
  if (error instanceof Error) return error.message;

  // Object with message or error property (structured errors from backend)
  if (error && typeof error === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (error);
    // Check common error properties
    if ('message' in obj && typeof obj.message === 'string') return obj.message;
    if ('error' in obj && typeof obj.error === 'string') return obj.error;

    // Last resort: pretty-print object (NOT [object Object])
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return '[Unserializable error object]';
    }
  }

  // Null/undefined
  if (error === null || error === undefined) return 'Unknown error';

  // Primitive (number, boolean, symbol, bigint)
  return String(error);
}

/**
 * Extract a user-facing error message, stripping technical HTTP prefixes.
 * @param {unknown} error - Error value
 * @returns {string} Human-readable error message without "HTTP NNN: " prefix
 */
export function extractUserMessage(error) {
  const msg = extractErrorMessage(error);
  return msg.replace(/^HTTP \d+:\s*/, '');
}

/**
 * Extract error message and stack from any error type
 * @param {unknown} error - Error object or primitive
 * @returns {ErrorInfo} Extracted error info with message and stack
 */
export function extractErrorInfo(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack || null
    };
  }
  return {
    message: extractErrorMessage(error),
    stack: null
  };
}
