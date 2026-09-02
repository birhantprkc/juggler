//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';
import { createFileContentBlock, formatFileContentForLLM } from 'juggler/item-utils';

/**
 * Extension → syntax-highlighting language identifier. The single client-side
 * language map: a dropped file never reaches the server, so it has no
 * server-detected `language` to fall back on and the browser must be able to
 * work this out on its own.
 * @type {Record<string, string>}
 */
const LANGUAGE_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', css: 'css', scss: 'scss',
  md: 'markdown', sql: 'sql',
};

/**
 * TextFileViewer — the fallback viewer, and the one that handles almost
 * everything. Renders a file as syntax-highlighted text (or rendered markdown),
 * and extracts it as the line-numbered `<file>` block the model reads.
 *
 * It is the only viewer that sets `matchAll`, so it is a candidate for every
 * file; `priority: 0` puts it in the fallback tier beneath any viewer with a
 * real claim on the format. Its `claims()` veto on binary files is what lets a
 * binary with no dedicated viewer resolve to *nothing* and land on the host's
 * "no viewer" state.
 * @augments FileViewer
 */
class TextFileViewer extends FileViewer {
  static MANIFEST = {
    id: 'text',
    name: 'Text',
    version: '1.0.0',
    description: 'Renders text and source files with syntax highlighting',
    matchAll: true,
    priority: 0,
  };

  /**
   * Decline binary files. This is the *only* place `isBinary` is treated as a
   * verdict — for every other viewer it stays advisory, so an image or PDF
   * viewer still claims its (binary) format.
   * @param {import('juggler/file-viewer').FileDescriptor} descriptor - File metadata
   * @returns {boolean|undefined} False for binary content, otherwise no opinion
   */
  static claims(descriptor) {
    return descriptor.isBinary ? false : undefined;
  }

  /**
   * Language identifier for a source: the server's detection when the transport
   * carried one, else path-based.
   * @param {import('juggler/file-source').FileSource} source - The file
   * @returns {string} Language identifier for syntax highlighting
   */
  static languageFor(source) {
    if (source.language) return source.language;
    const ext = (source.path || '').split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || '';
    return LANGUAGE_BY_EXT[ext] || 'text';
  }

  /**
   * @param {import('juggler/file-source').FileSource} source - The file to render
   * @param {HTMLElement} host - Element to render into
   * @returns {Promise<(() => void)|void>} Teardown when the block windows a long file
   */
  async render(source, host) {
    const text = source.text ?? new TextDecoder().decode(await source.bytes());
    const block = createFileContentBlock({
      content: text,
      language: TextFileViewer.languageFor(source),
      lineNumberStart: source.lineOffset || 1,
    });
    host.appendChild(block);
    // A file long enough to be rendered a window at a time is subscribed to its
    // scroller; hand that subscription to the host's teardown.
    const destroy = /** @type {any} */ (block).destroy;
    return typeof destroy === 'function' ? destroy : undefined;
  }

  /**
   * @param {import('juggler/file-source').FileSource} source - The file to extract
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} The model-facing text
   */
  async extract(source) {
    const text = source.text ?? new TextDecoder().decode(await source.bytes());
    return {
      text: formatFileContentForLLM({
        content: text,
        path: source.path,
        lineOffset: source.lineOffset || 1,
        lineCount: source.lineCount,
        totalLines: source.totalLines,
      }),
    };
  }
}

export default TextFileViewer;
