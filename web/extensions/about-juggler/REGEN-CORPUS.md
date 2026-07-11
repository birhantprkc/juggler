<!--
  ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
  ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
SPDX-License-Identifier: Apache-2.0
-->

# Regenerating `corpus.js`

`corpus.js` in this folder is the reference manual the **AboutJuggler** tool
returns when a user asks about Juggler itself. It is **generated from repo
source, not hand-maintained** — so when Juggler's tools, shortcuts, commands,
providers, or config layout change, regenerate it instead of patching prose.

Hand this whole file to an LLM (Juggler itself, ideally) with access to the
`juggler/` source tree. It should read the source-of-truth files below, then
rewrite `corpus.js` so every factual section matches what the code actually
declares today.

## Hard rules

1. **Ground every claim in the source files listed below.** If the source does
   not support a statement, cut it — never invent behaviour, telemetry claims,
   provider names, or shortcuts.
2. **Only `corpus.js` changes.** Keep it a single ES module that
   `export default`s one markdown string, with the existing Apache-2.0 header.
3. **No backtick characters inside the string.** The corpus is a JS template
   literal, so backticks would break it. Use plain text or single quotes for
   paths and commands (e.g. write ~/.juggler/credentials.json, not a code span).
   Preserve the two placeholder tokens verbatim — `{{KEYBOARD_SHORTCUTS}}` and
   `{{LOG_LOCATION}}`. The tool substitutes these at call time with text rendered
   for the live session's platform. Do NOT hard-code a keyboard-shortcut table or
   a single platform's log path into the base — the base is generic and
   cross-platform; platform-specifics are injected. (Shortcuts with no modifier,
   like Shift+Tab for the strategy switcher, are platform-neutral and may be
   named in prose.)
4. **Keep it sensibly sized** — a scannable manual (roughly 150–250 lines of
   markdown), not an exhaustive dump. Prefer the user-facing shape of a feature
   over implementation detail.
5. **Audience is the model at runtime**, answering an end user. Factual and
   terse; no marketing.

## Source-of-truth files (read these, then write the sections)

Paths are relative to the `juggler/` repo root.

- **What Juggler is / core concepts** — `README.md` (the product one-liner and
  the TL;DR bullets: GUI, session-as-tree/Yjs, visibility, plugins, local+remote).
- **Tools** — `web/extensions/juggler-core/context-items/*-context-item.js`. Each
  file's `getToolDefinitions()` returns the tool `name` + `description`; the
  `MANIFEST.id` is the capability id. List the user-facing tools (skip internal
  items that expose no tool, e.g. `file-content`, `system-prompt`, `dropped-file`).
  Cross-check tool names against the alias map in
  `web/js/services/tool-generator.js`.
- **Strategies** — `web/extensions/juggler-core/strategies/*-strategy-type.js`
  (each declares `id`, `name`, `description`).
- **Slash commands** — `web/extensions/juggler-core/commands/*-command-type.js`
  (each declares `id` and a `description`).
- **Keyboard shortcuts** — do NOT transcribe these into the base. The tool
  generates the table live from `SHORTCUT_DEFS` in
  `web/js/services/key-shortcut-manager.js` and drops it in at the
  `{{KEYBOARD_SHORTCUTS}}` token, formatted per platform. Just keep the token and
  the surrounding sentence noting bindings are customisable.
- **Log location** — do NOT transcribe. The tool injects the platform's real log
  directory (mirrored from `internal/logpaths/logpaths.go`) at the
  `{{LOG_LOCATION}}` token. If those Go paths change, update the `logLocationFor`
  table in `context-items/about-juggler-context-item.js`, not the base corpus.
- **Model providers** — the directories under `cmd/juggler/providers/` (each is a
  provider; `openaibase`, `utils`, and `registry` are shared infrastructure, not
  user-facing providers).
- **Configuration & data locations** — `docs/config-directory.md` (the
  `~/.juggler` layout, durable-vs-cache split, and that logs live elsewhere);
  `docs/memory.md` for the project-level `.juggler/MEMORY.md`.
- **Extensions** — `web/extensions/*/juggler.extension.json` for the built-in
  extension ids/names (@juggler/core, @juggler/mcp, and this @juggler/about);
  `cmd/juggler/server/handlers/extensions.go` for how embedded vs user
  (`~/.juggler/extensions/`) extensions are discovered.
- **Source code and deeper documentation** — the corpus ends with a section
  linking the public repo and its docs so the model can dive deeper (especially
  for writing extensions). Keep it grounded: the repo URL is
  `https://github.com/juggler-ai/juggler` (confirm against `git remote -v` and the
  root `README.md`), and every repo-relative path you cite must actually exist —
  the deep-dive targets are `docs/extension_guide.md`, the SDK base classes under
  `web/sdk/` (`context-item.js`, `strategy-type.js`, `command-type.js`), the
  example extensions under `web/extensions/`, and the other `docs/*.md`
  (`config-directory.md`, `memory.md`, `logging.md`, `distribution.md`). Prefer
  repo-relative paths plus one example `blob/<default-branch>` URL over
  hand-writing a full URL per file (branch names drift).
- **Updates/connectivity** — `internal/updatecheck/` confirms the update check;
  keep connectivity claims conservative and true (LLM calls go to the configured
  provider; WebFetch/WebSearch reach requested sites; version check runs). Do not
  assert "no telemetry" unless the source supports it.

## After regenerating

- Verify the string still parses (no stray backticks; balanced template literal).
- Build the app so the new extension asset is embedded and served — from the
  parent repo run `make build` (per the parent's build convention), or build the
  core standalone if working in the submodule directly.
- Sanity-check by asking a running Juggler a question like "what keyboard
  shortcuts do you have?" and confirming the AboutJuggler tool fires and answers
  from the refreshed corpus.
