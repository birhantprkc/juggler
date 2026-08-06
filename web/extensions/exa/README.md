# Exa Search (`@juggler/exa`)

A built-in Juggler extension that provides `exa_search`, a read-only web search
tool backed by the [Exa Search API](https://exa.ai/docs/reference/search).
The extension ships disabled. Enable it in the Extensions catalog, then set an
Exa API key in its Settings section. Keys are stored as masked extension secrets.

Create an API key at <https://dashboard.exa.ai/api-keys>.

## Tool

`exa_search` accepts a query, result count, Exa search mode, optional include and
exclude domain lists, and an option to retrieve page text. It calls
`POST https://api.exa.ai/search` through Juggler's server-side HTTP operation and
returns Exa's ranked result objects.

## Layout

```
exa/
  juggler.extension.json
  context-items/exa-search-context-item.js
```

## License

This extension is licensed under [Apache-2.0](../LICENSE).
