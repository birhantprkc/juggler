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
- **todo** — track a lightweight, no-approval checklist during multi-step work;
  each call replaces the whole list.
- **plan** — propose an approval-gated implementation plan for user review, then
  track its execution step by step.
- **memory** — record or remove durable, cross-session project facts.
- **AskUserQuestion** — ask the user a structured multiple-choice question.
- **define_command** — save a reusable prompt as a custom "/name" slash command;
  the user approves the full definition before it is created.

## Strategies

- **Default** — standard general-purpose coding-assistant behaviour.
- **Read-only** — any action that could change files is automatically refused;
  useful for safe exploration and review.
- **YOLO** — auto-approves every tool call. Fast but unguarded; use at your own
  risk.

Switch the active strategy with the strategy switcher (default shortcut Shift+Tab;
hold to open the strategy menu).

## Slash commands

Type "/" in the composer to run a command against the current conversation. The
built-in commands are:

- **/new** — open a new, empty conversation in a new tab.
- **/duplicate** — clone the current conversation into a new tab.
- **/clear** — clear the conversation's messages.
- **/compact** — compact the whole conversation into a summary thread.
- **/thread** — create a new sub-conversation thread.
- **/commands** — open the manager for creating and editing custom commands.

### Custom slash commands

You can define your own "/name" commands without writing code. A custom command
is a markdown file — YAML frontmatter (description, run mode, and a few options)
over a prompt template — that Juggler turns into a real menu command and
hot-reloads the moment you save. Placeholders in the template expand from what
you type after the command: "$1".."$9" for positional arguments, "$ARGUMENTS"
for everything after the command name, and "$$" for a literal dollar sign.

There are three ways to create one, all writing the same file: type a name that
does not exist yet (the menu offers a "New command…" row that opens the editor),
use "/commands", or ask the assistant to save a workflow as a command (it calls
the define_command tool and you approve the full definition first). A command
runs in one of three modes: send it immediately, insert it into the composer as
an editable draft, or run it in an isolated sub-thread (which can use its own
strategy or model).

Custom commands are stored as markdown files in two scopes:
"~/.juggler/commands/" (yours, across all projects) and
"<project>/.juggler/commands/" (shared through the project's git repository). A
project command shadows a user command of the same name, but neither can override
a built-in. For commands that need real code, write an extension instead. See
docs/custom-commands.md.

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
- **commands/** — your custom slash commands (see custom-commands.md).
- **cache/** — regenerable cache (recent projects, learned model context sizes);
  safe to delete at any time.

Everything directly under "~/.juggler" is durable and worth copying to a new
machine; everything under "~/.juggler/cache/" is regenerable. Logs do not live
here — they go to the platform's standard log directory to keep the config folder
small and copyable.

Per-project state lives in a ".juggler" folder inside the project, including
"MEMORY.md" — the durable, user-visible project memory the memory tool writes to
(gitignored by default) — and "commands/", holding project-scoped custom slash
commands that are shared through the project's git repository.

## Extensions

Juggler's capabilities are delivered as extensions. Built-in ones include Juggler
Core (the standard tools, strategies, and commands) and Juggler MCP (tools from
configured MCP servers). "About Juggler" — the extension providing this manual —
is itself one such extension: it is on by default and can be turned off in the
Extensions view, which removes this tool entirely.

User extensions can be installed under "~/.juggler/extensions/". Extensions are
managed in the Extensions view, where each extension and each capability has an
enable/disable toggle.

### Writing an extension

You do not need Juggler's source checked out to build one — everything you need
ships with the app.

Fastest start: the Juggler binary has an "ext" subcommand.

- "juggler ext init <name>" scaffolds a complete, working extension (a manifest
  plus one sample of each capability and a README) that loads and passes
  validation unedited — edit the samples into what you want.
- "juggler ext validate <path>" runs the exact admission check the app applies
  at load: required manifest fields, engineApi compatibility with this host, and
  that every "provides" glob resolves to real files.
- "juggler ext link <path>" symlinks your directory into "~/.juggler/extensions/";
  after that, saving any file hot-reloads the extension in connected viewers with
  no restart.
- "juggler ext add github.com/owner/repo" clones a published extension.

Anatomy: an extension is a folder with a "juggler.extension.json" manifest at its
root plus capability files whose names carry a type suffix, which is how the
manifest globs find them — "context-items/*-context-item.js" (tools the model can
call), "strategies/*-strategy-type.js" (agentic-loop policies), and
"commands/*-command-type.js" (slash commands). Each capability is a class that
"export default"s, extends an SDK base class ("juggler/context-item",
"juggler/strategy-type", or "juggler/command-type"), and declares a static
MANIFEST. (For a reusable prompt you do not need an extension at all — a custom
slash command is enough.)

Minimal manifest. Required fields are id, name, version, and provides; engineApi
is recommended and is checked against the host SDK version in web/sdk/version.js:

    {
      "id": "@you/word-count",
      "name": "Word Count",
      "version": "1.0.0",
      "engineApi": "^1.0.0",
      "provides": { "contextItems": ["context-items/*-context-item.js"] }
    }

Minimal tool (a context item). Implement getToolDefinitions() (the schema the
model sees), execute() (do the work; return RAW data), and getSummary() (format
the outcome). The single most common mistake is reading outcome.foo instead of
outcome.result.foo — execute()'s return value is wrapped as outcome.result:

    import ContextItem from 'juggler/context-item';

    class WordCountContextItem extends ContextItem {
      static MANIFEST = { id: 'word-count', name: 'Word Count', version: '1.0.0',
        description: 'Count words in a text string' };

      static getToolDefinitions() {
        return [{
          name: 'word_count',
          category: 'read',
          description: 'Count words in a text string',
          input_schema: { type: 'object',
            properties: { text: { type: 'string', description: 'Text to count' } },
            required: ['text'] }
        }];
      }

      async execute(params) {
        return { count: params.text.split(/\\s+/).filter(Boolean).length };
      }

      getSummary(outcome) {
        if (!outcome.success) return { summary: outcome.error, success: false };
        return { summary: outcome.result.count + ' words', success: true };
      }
    }

    export default WordCountContextItem;

For the exact API — every base-class method, the engine-vs-viewer execution
rules, approval and status-UI hooks, and the full manifest schema — read the SDK
source and the built-in examples directly. You can pull that source inside this
app, with no repo and no network, using the ReadJugglerSource tool: pass a path
under sdk/ or extensions/. The most useful targets are sdk/context-item.js,
sdk/strategy-type.js, and sdk/command-type.js (each opens with a quickstart and a
full method reference), plus the working examples under
extensions/juggler-core/context-items/ (for example read-file-context-item.js for
validation and status UI, or write-file-context-item.js for an approval gate).
The same files are also served by the running app at /sdk/... and /extensions/...
if you would rather open them in a browser tab. The authoring guide itself lives
in the repo at docs/extension_guide.md (linked below).

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
  The guide lives on GitHub, but those SDK base classes and the web/extensions/
  examples are also readable inside this app via the ReadJugglerSource tool
  (paths under sdk/ or extensions/) — so you can consult the exact API offline,
  with no repo checkout.
- **Configuration and data layout** — docs/config-directory.md (the ~/.juggler
  directory, durable vs. cache).
- **Custom slash commands** — docs/custom-commands.md (the no-code command
  format: placeholders, run modes, and scopes).
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
