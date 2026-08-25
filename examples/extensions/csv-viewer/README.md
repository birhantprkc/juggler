# CSV Viewer

A file viewer: it owns one file type end to end. Open a `.csv` and you get a
table instead of a wall of commas; when the model reads one, it gets aligned
columns instead of raw text.

```bash
juggler ext link ./examples/extensions/csv-viewer
```

Then open any `.csv` file in the project.

## Two audiences, two realms

That is the whole idea of this capability, and the class splits along it:

| Method | Realm | Audience |
|--------|-------|----------|
| `render(source, host, ctx)` | viewer — has DOM | You. Draw the file. |
| `extract(source, ctx)` | engine — **no DOM** | The model. Produce text. |

Calling `document.*` in `extract()` throws in dev mode, because there is no
document in the engine. The split is not advisory.

## Resolution is declarative

The registry chooses a viewer from `static MANIFEST` alone — `mimeTypes`,
`extensions`, `matchAll`, `maxBytes`, `priority` — and imports the module only
once it has **won**. That is why a viewer with a heavy dependency must
`import()` it *inside* the method that needs it: a top-level import would make
the engine download a rendering library it will never use. (The built-in PDF
viewer does exactly this with PDF.js.)

`static claims(descriptor)` is the escape hatch for rules the manifest cannot
express: `true` to claim a file it would have missed, `false` to refuse one it
would have taken, `undefined` to defer. It runs during resolution, so it is
synchronous, cheap, and sees only metadata — **the bytes have not been fetched**.

## Truncate on a boundary

`extract()` gets a `ctx.maxChars` budget. Stop at a natural boundary — here, a
whole row — and set `truncated: true`. Returning everything and letting the
caller cut it leaves the model reading half a record and inventing the rest.
