//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the PDF file viewer against the real vendored PDF.js.
 *
 * This is the standing answer to the "does PDF.js work here?" spike: rather than
 * asserting a conclusion, it loads the actual library in a real browser realm
 * and drives it. Covers:
 *  - `extract()` returning the document's text (the capability the model gains);
 *  - `render()` producing one canvas per page and a teardown that destroys the
 *    PDF.js document — a leaked worker per panel selection being this viewer's
 *    obvious failure mode;
 *  - teardown being safe to call twice.
 *
 * The fixture is a hand-built single-page PDF containing the literal text
 * "Juggler PDF spike", small enough to inline as base64.
 * @module unit-tests/pdf-viewer-test
 */

import PdfFileViewer from '../../extensions/juggler-core/viewers/pdf-file-viewer.js';
import { createFileSource } from '../../sdk/file-source.js';

/** A minimal one-page PDF whose only text is "Juggler PDF spike". */
const PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg' +
  'L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg' +
  'UiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMg' +
  'NCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0OCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDEwMCBUZCAoSnVn' +
  'Z2xlciBQREYgc3Bpa2UpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlw' +
  'ZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAw' +
  'MDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAw' +
  'MzM5IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA5CiUlRU9GCg==';

/**
 * @param {boolean} cond - Assertion condition
 * @param {string} msg - Failure message
 * @param {string[]} errors - Collected failures
 * @returns {number} 1 when the assertion passed, 0 when it failed
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * @returns {import('../../sdk/file-source.js').FileSource} A source backed by the inline fixture
 */
function pdfSource() {
  const bytes = Uint8Array.from(atob(PDF_BASE64), (c) => c.charCodeAt(0));
  return createFileSource({
    path: 'docs/spike.pdf',
    absPath: '/proj/docs/spike.pdf',
    mime: 'application/pdf',
    size: bytes.length,
    isBinary: true,
    url: () => `data:application/pdf;base64,${PDF_BASE64}`,
    bytes: async () => bytes,
  });
}

/**
 * A source whose streaming URL is same-origin and well-formed but will be
 * refused at load time — the shape of an @-mentioned file outside the project
 * root, which the content route answers with a 403. Its bytes still resolve.
 * @returns {import('../../sdk/file-source.js').FileSource} A source with a dead URL
 */
function pdfSourceWithDeadURL() {
  const source = pdfSource();
  return createFileSource({
    ...source,
    url: () => '/api/session/files/content?path=%2Fnowhere%2Fout-of-project.pdf',
  });
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} n - 1 when passed */
  const tally = (n) => { if (n) passed++; else failed++; };

  const viewer = new PdfFileViewer();

  // The manifest must actually claim PDFs, or none of this viewer runs.
  const manifest = /** @type {any} */ (PdfFileViewer).MANIFEST;
  tally(check(manifest.mimeTypes.includes('application/pdf') && manifest.extensions.includes('pdf'),
    'the PDF viewer should declaratively claim application/pdf and .pdf', errors));

  // Extraction — the outcome the spike was about.
  // Extraction must actually produce the document's text in a browser realm.
  // This is the regression guard for the WebKit gap the viewer works around:
  // PDF.js's own getTextContent() consumes its stream with `for await`, which
  // WebKit cannot do, so the viewer drives the reader explicitly. If that
  // workaround is ever removed, extract() silently degrades to a warning and
  // the model stops seeing PDFs — this assertion is what catches it.
  let extracted;
  let threw = null;
  try {
    extracted = await viewer.extract(pdfSource(), {});
  } catch (err) {
    threw = err;
    extracted = /** @type {any} */ ({});
  }
  tally(check(threw === null,
    `extract() must never throw, it degrades instead; threw: ${/** @type {any} */ (threw)?.message}`, errors));
  tally(check(!extracted.warning,
    `extract() should produce text in a browser realm, but degraded: ${extracted.warning}`, errors));
  tally(check(!!extracted.text && extracted.text.includes('Juggler PDF spike'),
    `extracted text should contain the document's text, got ${JSON.stringify(extracted.text)}`, errors));
  tally(check(!!extracted.text && extracted.text.includes('docs/spike.pdf'),
    'extracted text should be wrapped in a <file> tag naming the path', errors));
  tally(check(extracted.truncated === false,
    'a one-page document within budget should not report truncation', errors));

  // A budget smaller than the first page must still yield that whole page —
  // extraction stops at a page boundary rather than cutting mid-word.
  const tiny = await viewer.extract(pdfSource(), { maxChars: 1 });
  tally(check(!!tiny.text && tiny.text.includes('Juggler PDF spike'),
    'a tiny budget should still emit the first whole page', errors));

  // Rendering, in a detached-but-connected host so IntersectionObserver and
  // canvas sizing behave as they do in the panel.
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const header = document.createElement('div');
    const teardown = await viewer.render(pdfSource(), host, { header });

    const canvases = host.querySelectorAll('canvas.pdf-view-page');
    tally(check(canvases.length === 1,
      `render() should create one canvas per page, got ${canvases.length}`, errors));
    tally(check(header.textContent?.includes('1 page') === true,
      `the header should report the page count, got ${JSON.stringify(header.textContent)}`, errors));
    tally(check(typeof teardown === 'function',
      'render() must return a teardown so the PDF.js worker is destroyed', errors));

    // Teardown must be idempotent — <file-view> can call it on disconnect after
    // an abort has already fired.
    if (typeof teardown === 'function') {
      let threw = false;
      try {
        teardown();
        teardown();
      } catch {
        threw = true;
      }
      tally(check(!threw, 'teardown should be safe to call twice', errors));
    }
  } catch (err) {
    tally(check(false, `render() threw: ${/** @type {any} */ (err)?.message || err}`, errors));
  } finally {
    host.remove();
  }

  // A refused streaming URL must fall back to the bytes transport rather than
  // surfacing the HTTP status as "could not display this file". This is the
  // out-of-project case: the content route serves only files inside the project
  // root, so an @-mentioned PDF elsewhere can only ever render from bytes.
  const fallbackHost = document.createElement('div');
  document.body.appendChild(fallbackHost);
  try {
    const teardown = await viewer.render(pdfSourceWithDeadURL(), fallbackHost, {});
    const canvases = fallbackHost.querySelectorAll('canvas.pdf-view-page');
    tally(check(canvases.length === 1,
      `a refused URL should fall back to bytes and still render, got ${canvases.length} canvases`, errors));
    if (typeof teardown === 'function') teardown();
  } catch (err) {
    tally(check(false,
      `render() should recover from a refused URL, but threw: ${/** @type {any} */ (err)?.message || err}`, errors));
  } finally {
    fallbackHost.remove();
  }

  return { passed, failed, errors };
}
