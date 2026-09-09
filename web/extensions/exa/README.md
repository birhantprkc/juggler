# Exa Search (`@juggler/exa`)

A built-in Juggler extension that provides `exa_search`, a read-only web search
tool backed by the [Exa Search API](https://exa.ai/docs/reference/search).
The extension ships disabled. Enable it in the Extensions catalog, then set an
Exa API key in its Settings section. Keys are stored as masked extension secrets.

Create an API key at <https://dashboard.exa.ai/api-keys>.

## Tool

`exa_search` accepts a query, result count, Exa search mode, and optional include
and exclude domain lists. It calls `POST https://api.exa.ai/search` through
Juggler's server-side HTTP operation and returns Exa's ranked result objects.

`contents` chooses how much of each page comes back: `highlights` (the default)
returns the passages matching the query, `text` returns full page text, and
`none` returns titles and links alone. Exa applies no length limit of its own, so
every request carries a per-result character cap — a share of the conversation's
truncation budget, at most 10 000 — which `maxCharacters` overrides.

## Layout

```
exa/
  juggler.extension.json
  context-items/exa-search-context-item.js
```

## License

This extension is licensed under [Apache-2.0](../LICENSE).
