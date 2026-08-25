# Bookmarks

Save named locations in a project — `bookmarks.js:42`, "the retry loop", "where
config gets merged" — and recall them later. Both you and the model can use them.

This is the finished state of the
[extension tutorial](../../../docs/extension_tutorial.md), which builds it from
an empty directory one capability at a time. Read that if you want the reasoning;
read this if you want the shape.

```bash
juggler ext link ./examples/extensions/bookmarks
```

## What it demonstrates

Four capabilities from one extension, which is the point — an extension is a
bundle, not a single thing:

| File | Capability | Worth reading for |
|------|-----------|-------------------|
| `context-items/bookmarks-context-item.js` | Context item | Two tools on one class; validation; `summary` as the model-facing content |
| `context-items/bookmark-clear-context-item.js` | Context item | `requiresApproval` and an approval dialog that names what will be lost |
| `commands/bookmarks-command-type.js` | Command | The simplest capability there is: no LLM, no approval |
| `cards/bookmarks-card.js` | Info card | `mount()`/teardown, `hasContent()`, and caching against re-mounts |
| `lib/bookmark-store.js` | *(not a capability)* | A shared helper — no suffix, so no glob matches it |
| `juggler.extension.json` | — | A `number` setting with a default, read via `extensionConfigResolve` |

## Design notes

**Clearing lives in its own class.** `requiresApproval` is declared per class,
not per tool, so a class holding both `bookmark_list` and `bookmark_clear` would
have to gate both or neither. Splitting them is what lets listing stay instant
while clearing still asks.

**The store is `.juggler/bookmarks.json`, project-relative.** Ops resolve
relative paths against the project root, so bookmarks follow the project rather
than the machine. A missing file is the normal first-run state and reads back as
an empty list — not an error anybody has to handle.

**The card caches outside the class.** The sidebar rail drops the
lowest-priority card when it runs short of room and rebuilds it when the room
returns, so `mount()` runs much more often than the card's apparent lifetime. A
card that fetched on every mount would hammer the host during a window resize.

## Things it deliberately does not do

No file watcher, no sync across machines, no undo. Each would be a reasonable
next exercise — and each would obscure the shape this example exists to show.
