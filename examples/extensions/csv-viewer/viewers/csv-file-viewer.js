//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';

/** Rows past this are neither rendered nor extracted — a CSV can be enormous. */
const MAX_ROWS = 2000;

/**
 * Split CSV text into rows of cells, honouring double-quoted fields (including
 * `""` as an escaped quote). Deliberately small: a real viewer would use a
 * proper parser, but a dependency would obscure the shape this file is here to
 * show.
 * @param {string} text - Raw CSV text
 * @returns {string[][]} Rows of cells
 */
function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Render rows as a fixed-width text table — what the model reads. Columns are
 * padded so a value lines up with its header, which is most of what makes a CSV
 * legible to a language model.
 * @param {string[][]} rows - Rows of cells
 * @returns {string} Aligned plain text
 */
function toAlignedText(rows) {
  const widths = /** @type {number[]} */ ([]);
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  }
  return rows
    .map(row => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

/**
 * Shows CSV files as a table, and gives the model aligned columns rather than
 * raw comma-separated text.
 * @augments FileViewer
 */
class CsvFileViewer extends FileViewer {
  static MANIFEST = {
    id: 'csv',
    name: 'CSV',
    version: '1.0.0',
    description: 'Renders CSV as a table and extracts it as aligned columns',
    mimeTypes: ['text/csv'],
    extensions: ['csv', 'tsv'],
    // Above the text viewer's fallback tier, so a .csv lands here rather than
    // in the generic text pane.
    priority: 50,
    // Decline anything larger. The file is parsed whole in memory, and a viewer
    // that claims a file it cannot handle is worse than one that never claimed
    // it: declining leaves the host free to fall back.
    maxBytes: 16 << 20
  };

  /**
   * Draw the table. VIEWER realm — the DOM exists here.
   *
   * No teardown is returned because this render owns nothing that outlives the
   * element: no timer, no observer, no object URL. Return one the moment it
   * does, or a viewer leaks per panel selection.
   * @param {import('juggler/file-source').FileSource} source - The file to render
   * @param {HTMLElement} host - Element to render into (already empty)
   * @returns {Promise<void>} Resolves once the table is in the DOM
   */
  async render(source, host) {
    const rows = parseCsv(new TextDecoder().decode(await source.bytes())).slice(0, MAX_ROWS);
    const table = document.createElement('table');
    for (const [index, row] of rows.entries()) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        // First row as headers; textContent, never innerHTML — this is file
        // content from disk and must never be parsed as markup.
        const td = document.createElement(index === 0 ? 'th' : 'td');
        td.textContent = cell;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    host.appendChild(table);
  }

  /**
   * Produce what the model sees. ENGINE realm — there is no DOM here, so this
   * method builds text rather than elements.
   * @param {import('juggler/file-source').FileSource} source - The file to extract from
   * @param {import('juggler/file-viewer').ExtractContext} [ctx] - Character budget and abort signal
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} What the model should see
   */
  async extract(source, ctx) {
    const rows = parseCsv(new TextDecoder().decode(await source.bytes()));
    const budget = ctx?.maxChars ?? Infinity;

    // Add rows until the next one would breach the budget, so the model always
    // sees whole records. Cutting mid-row would leave it reading a fragment and
    // guessing at the rest.
    const kept = /** @type {string[][]} */ ([]);
    let size = 0;
    for (const row of rows.slice(0, MAX_ROWS)) {
      const cost = row.join('  ').length + 1;
      if (size + cost > budget && kept.length > 0) break;
      kept.push(row);
      size += cost;
    }

    return {
      text: toAlignedText(kept),
      truncated: kept.length < rows.length
    };
  }
}

export default CsvFileViewer;
