# Vendored third-party code

Everything in this directory is third-party code copied into the repository
rather than fetched at build time, so a clone builds and runs offline and the
exact bytes we ship are reviewable in git.

The whole tree is excluded from linting (`Makefile` `lint-js`) and from
`tooling/jsconfig.json`'s `include`, so files normally land here byte-for-byte.
Never reformat or patch a vendored file's logic; to update one, re-download the
release and replace it wholesale, then update its row below.

**The one sanctioned edit is a leading `// @ts-nocheck` line** (see `yjs.mjs` and
`pdf.min.mjs`). `exclude` only keeps a file out of the *initial* program — a
bundle that our own code `import`s is pulled back in and type-checked, and a
minified bundle produces thousands of errors. The banner is a comment, changes
no behaviour, and must be re-added after every upgrade.

`web/embed.go` embeds `js/*`, so every file here is compiled into the binary and
adds to its size.

| File | Project | Version | Source | Licence | Vendored |
|---|---|---|---|---|---|
| `pdf.min.mjs` | [Mozilla PDF.js](https://github.com/mozilla/pdf.js) | 6.2.108 | `pdfjs-dist` npm tarball, `package/build/` | Apache-2.0 | 2026-08-09 |
| `pdf.worker.min.mjs` | Mozilla PDF.js | 6.2.108 | `pdfjs-dist` npm tarball, `package/build/` | Apache-2.0 | 2026-08-09 |
| `pdf-standard-fonts/` | Mozilla PDF.js | 6.2.108 | `pdfjs-dist` npm tarball, `package/standard_fonts/` | Apache-2.0 (fonts: Liberation + Foxit, see the `LICENSE_*` files alongside) | 2026-08-09 |
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | 18.0.10 | jsDelivr (`npm/marked@18.0.10/lib/marked.umd.js`) | MIT | 2026-08-22 |
| `yjs.mjs` | [Yjs](https://github.com/yjs/yjs) | 13.6.x (bundled with its `lib0` dependencies) | Yjs release, bundled | MIT | before this file existed |
| `y-generic-sync.js` | Yjs sync protocol helper | — | bundled alongside `yjs.mjs` | MIT | before this file existed |
| `prism-*.js` | [Prism](https://github.com/PrismJS/prism) | 1.29.0 | jsDelivr (`npm/prismjs@1.29.0`), minified by Terser 5.37.0 | MIT | before this file existed |

The rows marked "before this file existed" were backfilled from the version
banners inside the files themselves; treat their vendored dates as unknown.

## marked notes

**Upstream has no `marked.min.js` any more.** It was a root-level file up to
15.x; from 16.x the only minified browser build is `lib/marked.umd.js`, which is
what the local `marked.min.js` now holds. The local name is kept so the
`<script>` tags in `web/index.html` and `web/js-tests/headless-test.html` do not
have to change.

The build carries a `//# sourceMappingURL=marked.umd.js.map` line and we do not
vendor the 167 KB map, so opening the inspector logs one 404 for it. The comment
is left in place because vendored files land byte-for-byte.

## PDF.js notes

**Only `build/` is vendored, not `legacy/build/`.** The `legacy` build exists for
runtimes without `DOMMatrix` / `Path2D` / `ImageData`, and it polyfills them by
`require`-ing the **native** `@napi-rs/canvas` package — which cannot be
vendored as plain JS. A spike confirmed both builds throw
`ReferenceError: DOMMatrix is not defined` under Node without that native
module. A browser realm provides all three, so the vendored `build/` is the
right one for both the viewer and the engine WebView; the viewer
(`web/extensions/juggler-core/viewers/pdf-file-viewer.js`) degrades to a warning
rather than throwing if it ever runs somewhere the library will not load.

**WebKit needs a workaround for text extraction.** PDF.js's `getTextContent()`
consumes its own `streamTextContent()` result with
`for await (const chunk of stream)`, and WebKit does not support async iteration
of a `ReadableStream` — so `getTextContent()` throws
`undefined is not a function` there, which matters because Juggler's WebView is
WebKit. The viewer therefore calls `streamTextContent().getReader()` and pulls
chunks itself: same public API, no unsupported syntax. `unit:pdf-viewer` asserts
real text comes back, so removing the workaround fails the suite rather than
silently regressing the model to seeing nothing.

**`cmaps/` is deliberately not vendored** (~1.2 MB, needed only for CJK
character maps). Add it if a CJK PDF turns up rendering blank glyphs.

`standard_fonts/` **is** vendored: plenty of PDFs omit the base-14 fonts, and
without it those documents render with fallback metrics.
