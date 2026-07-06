//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * FormattingHelpers - Utility class for common context item formatting patterns
 *
 * Provides helper methods for context items to format their context text.
 * Plugins can use these to create consistent, LLM-optimized output.
 */

export class FormattingHelpers {
  /**
   * Wrap content in XML tags
   * @param {string} tagName - Tag name (e.g., 'file_contents', 'directory_tree')
   * @param {string} content - Content to wrap
   * @param {object} [attributes={}] - Optional attributes as key-value pairs
   * @returns {string} XML-formatted content
   * @example
   * helpers.xml('file_contents', fileContent)
   * // Returns: <file_contents>\nfileContent\n</file_contents>
   * @example
   * helpers.xml('file_contents', fileContent, { path: 'src/main.js', lines: '150' })
   * // Returns: <file_contents path="src/main.js" lines="150">\nfileContent\n</file_contents>
   */
  static xml(tagName, content, attributes = {}) {
    const attrs = Object.entries(attributes)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    return `<${tagName}${attrs ? ' ' + attrs : ''}>\n${content}\n</${tagName}>`;
  }
}
