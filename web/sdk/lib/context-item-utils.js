//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Context Item Display Utilities
 *
 * Common utilities for formatting and displaying context item content.
 * Shared across all context item types.
 */

import { createCopyButton } from './copy-button.js';
import { renderMarkdown, decorateCodeBlocks } from './markdown.js';
import { highlightCode } from './syntax-highlight.js';
import { injectStylesOnce } from './inject-styles.js';

/**
 * Format file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size (e.g., "1.5 KB", "2.3 MB")
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes === null || bytes === undefined) return '—';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);

  if (i === 0) {
    return `${bytes} B`;
  }

  return `${size.toFixed(1)} ${units[i]}`;
}

/**
 * Format path for display with "./" prefix for relative paths
 * App-wide policy: relative paths get "./" prefix, absolute paths shown as-is
 * @param {string} path - File path
 * @returns {string} Formatted path for display
 */
export function formatDisplayPath(path) {
  if (!path) return '';
  // Absolute paths (start with /) are shown as-is
  if (path.startsWith('/')) return path;
  // Paths already starting with ./ are shown as-is
  if (path.startsWith('./')) return path;
  // Windows absolute paths are shown as-is: a drive-letter path (`C:\…` or
  // `C:/…`) or a UNC path (`\\server\share`). Without this they'd get a `./`
  // prefix and render as `./C:\build.bat` — reading as project-relative exactly
  // when the user most needs to see it isn't.
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path;
  // Relative paths get ./ prefix
  return `./${path}`;
}

/**
 * Format a filesystem path for a compact status summary: strip the project-root
 * prefix to a relative path, then truncate very long paths from the START so the
 * meaningful tail (the filename) survives, with a leading ellipsis cut at a clean
 * path separator.
 * @param {string} path - The raw path
 * @param {string} [projectPath] - Project root prefix to strip
 * @param {number} [maxLen=40] - Max length before truncation kicks in
 * @returns {string} Formatted path for display
 */
export function formatPathForStatus(path, projectPath, maxLen = 40) {
  let p = path;

  // Strip project root to get a relative path. Strip either separator so a
  // native Windows project path leaves no leading `\`.
  if (projectPath && p.startsWith(projectPath)) {
    p = p.slice(projectPath.length).replace(/^[/\\]+/, '');
  }

  // Truncate long paths from the start, preserving the tail
  if (p.length > maxLen) {
    // Find a path separator near the truncation point to cut cleanly (either
    // `/` or a Windows `\`).
    const tail = p.slice(p.length - maxLen);
    const sepIdx = tail.search(/[/\\]/);
    p = '\u2026/' + (sepIdx >= 0 ? tail.slice(sepIdx + 1) : tail);
  }

  return p;
}

/**
 * Return the final segment (filename or folder name) of a path for display.
 * Handles both POSIX (`/`) and Windows (`\`) separators — the backend reports
 * native OS paths, so titles must strip either — and trims trailing separators
 * so a directory path yields its own name rather than an empty string.
 * @param {string} path - File or directory path
 * @returns {string} Last path segment, or '' if the path is empty
 */
export function basename(path) {
  if (!path) return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Create an empty state element
 * @param {string} message - Empty state message
 * @param {string} [icon=''] - Optional icon
 * @returns {HTMLElement} Empty state element
 */
export function createEmptyState(message, icon = '') {
  const container = document.createElement('div');
  container.className = 'context-item-empty';

  if (icon) {
    const iconDiv = document.createElement('div');
    iconDiv.className = 'context-item-empty-icon';
    iconDiv.textContent = icon;
    container.appendChild(iconDiv);
  }

  const messageDiv = document.createElement('div');
  messageDiv.textContent = message;
  container.appendChild(messageDiv);

  return container;
}

/**
 * @typedef {object} FileContentParams
 * @property {string} content - File content
 * @property {string} path - File path
 * @property {number} [lineOffset=1] - Starting line number (1-indexed)
 * @property {number} [lineCount] - Number of lines in content
 * @property {number} [totalLines] - Total lines in file
 * @property {string} [readMode] - Human-readable read mode (e.g., "First 50 lines", "Lines 10-20")
 */

/**
 * Format file content for LLM context with line numbers and XML wrapper.
 * @param {FileContentParams} params - File content parameters
 * @returns {string} Formatted file content with line numbers and XML wrapper
 */
export function formatFileContentForLLM(params) {
  const { content, path, lineOffset = 1, lineCount, totalLines } = params;

  // Empty file warning
  if (!content || content.trim() === '') {
    return `<system-reminder>WARNING: File ${path} exists but is empty. Do not attempt to read it again.</system-reminder>`;
  }

  // Add line numbers with cat -n style format (variable-width, right-aligned, tab separator)
  const lines = content.split('\n');
  const maxLineNum = lineOffset + lines.length - 1;
  const numWidth = String(maxLineNum).length;

  const contentWithLineNumbers = lines.map((line, idx) => {
    const lineNum = lineOffset + idx;
    const paddedNum = String(lineNum).padStart(numWidth, ' ');
    return `${paddedNum}\t${line}`;
  }).join('\n');

  // Build simple XML tag with just path attribute
  const fileTag = `<file path="${path}">\n${contentWithLineNumbers}\n</file>`;

  // Add file info footer
  if (lineCount && totalLines && lineCount < totalLines) {
    // File was truncated - show how to get more
    const nextOffset = lineOffset + lineCount;
    return fileTag + '\n' +
      `(Showing lines ${lineOffset}-${lineOffset + lineCount - 1} of ${totalLines}. Use offset=${nextOffset} to read more.)`;
  }

  // Full file or single chunk - show total
  if (totalLines) {
    return fileTag + '\n' + `(${totalLines} lines total)`;
  }

  return fileTag;
}

/**
 * Create a text block element for rendering markdown content.
 *
 * Carries the standard hover-reveal copy button, which yields the markdown
 * source rather than the rendered text — what the block shows is text someone
 * will want to take elsewhere (a plan, a system prompt, a `.md` file), and the
 * source is the form that survives the trip.
 * @param {string} content - Markdown content to render
 * @returns {HTMLElement} Text block element with rendered markdown
 */
export function createTextBlock(content) {
  const textBlock = document.createElement('div');
  textBlock.className = 'ci-text-block properties-panel-copyable';

  const copyHeader = document.createElement('div');
  copyHeader.className = 'properties-panel-copy-header';
  copyHeader.appendChild(createCopyButton(() => content || ''));
  textBlock.appendChild(copyHeader);

  const markdownDiv = document.createElement('div');
  markdownDiv.className = 'markdown';
  markdownDiv.innerHTML = renderMarkdown(content || '');
  decorateCodeBlocks(markdownDiv);

  textBlock.appendChild(markdownDiv);
  return textBlock;
}

/**
 * @typedef {object} CodeBlockOptions
 * @property {string|Node} content - Code content (string or DOM node)
 * @property {string} [language='text'] - Language for syntax highlighting
 * @property {number} [lineNumberStart] - Starting line number (enables CSS Grid line numbers)
 * @property {boolean} [bordered=false] - Wrap in bordered container
 * @property {boolean} [header=false] - Show language/range header (implies bordered)
 * @property {string} [range] - Range label for header (e.g. "Lines 10-50")
 */

/**
 * Create a code block element with proper structure for scrolling.
 * @param {CodeBlockOptions} options - Code block configuration
 * @returns {HTMLElement} Code block element with nested structure
 */
export function createCodeBlock(options) {
  const opts = options;
  const content = opts.content;
  const language = opts.language || 'text';
  const lineNumberStart = opts.lineNumberStart;
  const bordered = opts.header || opts.bordered || false;

  const codeBlock = document.createElement('div');
  codeBlock.className = bordered ? 'ci-code-block' : 'ci-code-block ci-code-block-borderless';

  // Optional header (language badge + range)
  if (opts.header) {
    const headerDiv = document.createElement('div');
    headerDiv.className = 'ci-code-header';

    const langSpan = document.createElement('span');
    langSpan.className = 'ci-code-language';
    langSpan.textContent = language;
    headerDiv.appendChild(langSpan);

    if (opts.range) {
      const rangeSpan = document.createElement('span');
      rangeSpan.className = 'ci-code-range';
      rangeSpan.textContent = opts.range;
      headerDiv.appendChild(rangeSpan);
    }

    codeBlock.appendChild(headerDiv);
  }

  const codeContent = document.createElement('div');
  codeContent.className = 'ci-code-content';

  const pre = document.createElement('pre');
  const code = document.createElement('code');

  // Determine if we're dealing with a Node or string content
  const isNode = typeof content === 'object' && content !== null && 'nodeType' in content;
  const isGrid = lineNumberStart !== undefined && lineNumberStart !== null;

  // If content is a DOM node (HTMLElement or DocumentFragment), append it directly to code
  if (isNode) {
    // Still set pre className for consistent styling (font-size, etc.)
    pre.className = language ? `language-${language}` : '';
    code.appendChild(content);
  } else {
    // Otherwise, treat as code text with a language class and syntax-highlight
    // through the shared engine. `highlightCode` degrades to escaped plain text
    // when the grammar isn't bundled, so an unknown/`text` language renders
    // exactly as before. Grid mode highlights per line below, so skip the
    // throwaway full-block highlight here.
    pre.className = `language-${language}`;
    code.className = `language-${language}`;
    if (isGrid) code.textContent = content || '';
    else code.innerHTML = highlightCode(content || '', language);
  }

  pre.appendChild(code);
  codeContent.appendChild(pre);

  // Add line numbers using CSS Grid if lineNumberStart is provided
  if (isGrid) {
    // Get text content regardless of whether content is a Node or string
    const text = isNode ? (content.textContent || '') : (content || '');
    const lines = text.split('\n');

    // Replace pre>code with a CSS grid layout inside code
    code.textContent = '';
    code.classList.add('ci-code-grid');
    // counter-reset starts at lineNumberStart - 1 so first increment produces lineNumberStart
    code.style.setProperty('--line-start', String(lineNumberStart - 1));

    for (const line of lines) {
      const numSpan = document.createElement('span');
      numSpan.className = 'ci-line-num';

      // Highlight each line independently so it aligns with its grid line
      // number (and keeps wrap-per-line alignment). The tradeoff is that a
      // construct spanning multiple lines — a block comment, a multi-line
      // template literal — is tokenised per line rather than as a whole; the
      // shared engine still falls back to escaped text for unbundled languages.
      const lineSpan = document.createElement('span');
      lineSpan.className = 'ci-line';
      lineSpan.innerHTML = highlightCode(line, language);

      code.appendChild(numSpan);
      code.appendChild(lineSpan);
    }
  }

  codeBlock.appendChild(codeContent);

  return codeBlock;
}

/**
 * Render pinned/tool file content for the properties panel: markdown files go
 * through the standard markdown formatter ({@link createTextBlock}); everything
 * else through the syntax-highlighted {@link createCodeBlock}. Single source of
 * truth for the read/write/dropped/pinned file items so the markdown special
 * case stays consistent across all of them.
 * @param {object} [options]
 * @param {string} [options.content] - File body
 * @param {string} [options.language='text'] - Detected language identifier
 * @param {number} [options.lineNumberStart] - First line number (code blocks only)
 * @returns {HTMLElement} A text block for markdown, else a code block
 */
export function createFileContentBlock({ content = '', language = 'text', lineNumberStart } = {}) {
  if (language === 'markdown') {
    return createTextBlock(content || '');
  }
  return createCodeBlock({ content: content || '', language, lineNumberStart });
}

/**
 * Normalize the file_path → path alias that LLMs sometimes emit.
 * Mutates params in place and returns it for convenience.
 * @param {Record<string, any>} params
 * @returns {Record<string, any>} The same params object with path normalised
 */
export function normalizeFilePath(params) {
  if (params.file_path && !params.path) {
    params.path = params.file_path;
  }
  return params;
}

/**
 * Inject shared .file-content-* CSS into the document once.
 * Safe to call from multiple modules — guarded by style ID.
 */
export function injectFileContentStyles() {
  injectStylesOnce('file-content-ci-styles', `
.file-content-collapsed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 0.25rem;
  padding: 0.625rem;
  height: 100%;
}
.file-content-filename {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}
.file-content-meta {
  font-size: 0.625rem;
  font-family: var(--font-mono, 'Courier New', monospace);
  opacity: 0.7;
}
.file-content-expanded {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.file-content-warning {
  padding: 0.5rem;
  font-size: 0.75rem;
  background: rgb(from var(--accent-yellow) r g b / 15%);
  border: 1px solid var(--accent-yellow);
  border-radius: 0.25rem;
  color: var(--accent-yellow);
}
.file-content-not-found {
  padding: 0.5rem;
  font-size: 0.75rem;
  background: rgb(from var(--accent-red) r g b / 15%);
  border: 1px solid var(--accent-red);
  border-radius: 0.25rem;
  color: var(--accent-red);
}
`);
}
