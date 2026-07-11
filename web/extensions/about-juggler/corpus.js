//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The "About Juggler" corpus — a self-contained reference manual describing the
 * Juggler application itself. It is returned verbatim by the AboutJuggler tool
 * when the user asks about Juggler (its features, tools, shortcuts, config, etc.).
 *
 * COST MODEL: this string never enters the model's context until the tool is
 * actually called, so it costs zero tokens on a normal turn. When the extension
 * is disabled, the tool disappears and this module is never loaded.
 *
 * STRUCTURE: this is the GENERIC, cross-platform base manual. It is not the
 * whole answer — the AboutJuggler tool fills two placeholders at call time with
 * text derived from the live session's platform, so the manual reads correctly
 * on the machine it is describing:
 *   - {{KEYBOARD_SHORTCUTS}} — the current shortcut table, each binding rendered
 *     for the platform (⌘J on macOS, Ctrl+J on Windows/Linux), from the app's
 *     own SHORTCUT_DEFS (so it can never drift from the real key map).
 *   - {{LOG_LOCATION}} — the platform's actual log directory.
 * Keep these tokens intact when regenerating; never hard-code a shortcut table
 * or a single platform's paths into this base.
 *
 * MAINTENANCE: this file is generated, not hand-edited section by section. When
 * Juggler's tools/commands/providers change, regenerate the whole corpus from
 * repo source using the prompt in ./REGEN-CORPUS.md so it never drifts from
 * reality. Keep it grounded in real repo facts — no speculation.
 * @module about-juggler/corpus
 */

/** @type {string} The full About-Juggler reference manual (markdown). */
const CORPUS = `# About Juggler

This is Juggler's own reference manual — factual information about the Juggler
application itself. Use it to answer questions about what Juggler is, how it
works, and how to drive it. It does not describe the user's own code or project.

## What Juggler is

Juggler is a local-first AI coding agent with a graphical workbench UI. Its
angle is hands-on control: instead of a scrolling chat transcript, it gives you
an inspectable, navigable view of everything the model is doing to your codebase.

Distinguishing ideas:

- **It is a proper GUI**, not a console app — graphical navigation, inspection,
  and control throughout.
- **The session is a tree, not a doom-scroll.** A conversation is a Yjs document,
  not a flat transcript: you can branch sub-threads, drill down, backtrack,
  compare, and edit context items directly.
- **Everything important is visible.** Tool calls, approvals, thread structure,
  item properties, and raw context are laid out in Finder-style Miller columns.
- **It is plugins all the way down.** Context items (tools), slash commands, LLM
  loop strategies, and their UIs are JavaScript extensions you can inspect, fork,
  or replace.
- **It runs locally, remotely, or both at once.** The same session, with the same
  UI, is reachable from the native desktop app and/or a browser; multiple clients
  can attach to one session simultaneously.

## Core concepts

- **Conversation / session** — a Yjs document holding the whole tree of messages,
  threads, and context items. Because it is a CRDT document, multiple attached
  clients stay in sync and edits are non-destructive.
- **Threads** — sub-conversations branched off a point in the tree. Use them to
  explore a tangent, delegate a self-contained sub-task, or compare approaches
  without polluting the main line.
- **Context items** — the typed units that make up context: files, tool calls,
  memory, the system prompt, dropped files, and so on. Each is a plugin with its
  own UI, and each tool the model can call is backed by a context-item type.
- **Strategies** — pluggable LLM-loop policies that steer the model by gating
  which tools are available and injecting guidance, without changing the cached
  system prompt.

## Tools the agent can use

Tool availability depends on which extensions/plugins are enabled; the built-in
core provides:

- **read** — read a file (preferred over cat/head/tail).
- **write** — create or overwrite a file.
- **edit** — exact-string replacement in a file.
- **grep** — content search built on ripgrep (regex, globs, file-type filters).
- **glob** — find files by name pattern.
- **bash** — run a shell command; supports long-running background processes.
- **explore_code** — run reads/greps/globs inside one sandboxed JavaScript call
  and return only the computed value, keeping intermediate output out of context.
- **batch_read / batch_grep** — read or search several files in one call.
- **WebFetch** — fetch a URL and convert it to markdown (with a short cache).
- **WebSearch** — web search returning titles, URLs, and descriptions.
- **create_thread** — run a self-contained sub-task in an isolated sub-conversation
  whose intermediate steps stay out of the parent context.
- **Monitor** — stream lines from a long-running command as events.
- **TaskOutput / TaskStop (KillShell)** — read new output from, or stop, a
  background task.
- **plan** — create and track a multi-step implementation plan.
- **memory** — record or remove durable, cross-session project facts.
- **AskUserQuestion** — ask the user a structured multiple-choice question.

## Strategies

- **Default** — standard general-purpose coding-assistant behaviour.
- **Read-only** — any action that could change files is automatically refused;
  useful for safe exploration and review.
- **YOLO** — auto-approves every tool call. Fast but unguarded; use at your own
  risk.

Switch the active strategy with the strategy switcher (default shortcut Shift+Tab;
hold to open the strategy menu).

## Slash commands

Type "/" in the composer to run a command against the current conversation:

- **/new** — open a new, empty conversation in a new tab.
- **/duplicate** — clone the current conversation into a new tab.
- **/clear** — clear the conversation's messages.
- **/compact** — compact the whole conversation into a summary thread.
- **/thread** — create a new sub-conversation thread.

## Keyboard shortcuts

Shortcuts are customisable. The following are the current bindings, shown for
this platform:

{{KEYBOARD_SHORTCUTS}}

## Model providers

Juggler talks to models through pluggable providers; the built-in set includes
Anthropic, the Claude Code CLI, OpenAI, OpenAI Codex, Google Gemini, DeepSeek,
OpenRouter, Z.AI, and Ollama (for local models). Pick and configure your default
model in the app; API keys are stored locally (see below).

## Configuration and data locations

Per-user state lives in the "~/.juggler" directory:

- **credentials.json** — API keys, owner-only permissions.
- **default-model.json** — your chosen default model.
- **workspace.json** — the desktop app's open-window set and last-used theme.
- **extensions/** — installed user extensions.
- **cache/** — regenerable cache (recent projects, learned model context sizes);
  safe to delete at any time.

Everything directly under "~/.juggler" is durable and worth copying to a new
machine; everything under "~/.juggler/cache/" is regenerable. Logs do not live
here — they go to the platform's standard log directory to keep the config folder
small and copyable.

Per-project state lives in a ".juggler" folder inside the project, including
"MEMORY.md" — the durable, user-visible project memory the memory tool writes to
(gitignored by default).

## Extensions

Juggler's capabilities are delivered as extensions. Built-in ones include Juggler
Core (the standard tools, strategies, and commands) and Juggler MCP (tools from
configured MCP servers). "About Juggler" — the extension providing this manual —
is itself one such extension: it is on by default and can be turned off in the
Extensions view, which removes this tool entirely.

User extensions can be installed under "~/.juggler/extensions/". Extensions are
managed in the Extensions view, where each extension and each capability has an
enable/disable toggle. To write one, see the authoring guide and SDK linked under
"Source code and deeper documentation" below — an extension is a small folder
with a juggler.extension.json manifest plus capability classes (context items,
strategies, commands) that subclass the SDK base classes.

## Updates and connectivity

Juggler runs locally and only contacts the network when it needs to: LLM requests
go to whichever model provider you have configured, WebFetch/WebSearch reach the
sites you ask for, and Juggler checks for new versions. Your code is not sent
anywhere except to the model provider you choose for a given request.

## Troubleshooting

- **Logs** — logs do not live in "~/.juggler"; on this platform they are written
  to {{LOG_LOCATION}}. The in-app logging documentation explains how to read them
  and report issues.
- **Reset the cache** — deleting "~/.juggler/cache/" is safe; Juggler rebuilds it.
- **A tool seems missing** — check the Extensions view; the tool's providing
  extension or capability may be disabled.

## Source code and deeper documentation

Juggler is open source at https://github.com/juggler-ai/juggler. The app lives at
the repository root, so the paths below are relative to it — when you need more
than this manual carries (exact API signatures, precise behaviour, or how to
extend the app), read the source rather than guessing:

- **Writing extensions** — docs/extension_guide.md is the authoring guide
  (concepts, packaging, workflow). The base classes an extension subclasses live
  in web/sdk/, and each carries a JSDoc header with a quickstart and full method
  reference — that source is the canonical API documentation: web/sdk/context-item.js
  (tools/context items), web/sdk/strategy-type.js (strategies), and
  web/sdk/command-type.js (slash commands). The built-in extensions under
  web/extensions/ (juggler-core and juggler-mcp) are working examples to copy.
- **Configuration and data layout** — docs/config-directory.md (the ~/.juggler
  directory, durable vs. cache).
- **Project memory** — docs/memory.md (how .juggler/MEMORY.md is read and written).
- **Logs and reporting issues** — docs/logging.md.
- **Building and distribution** — docs/distribution.md; the top-level README.md
  covers cloning (with submodules) and building from source.
- **Contributing and licensing** — CONTRIBUTING.md, and LICENSING.md for the
  license boundary (the core is AGPL-3.0; the extension SDK under web/sdk/ and the
  built-in extensions under web/extensions/ are Apache-2.0).

To open any of these in a browser, prefix the repo-relative path with the
repository's blob URL on the default branch — for example
https://github.com/juggler-ai/juggler/blob/main/docs/extension_guide.md.

## Where to learn more

The website https://juggler.studio has the current overview and docs. This manual
is generated from Juggler's own source, so for the newest details always defer to
the source above, the running app's Extensions view, and the official docs.`;

export default CORPUS;
