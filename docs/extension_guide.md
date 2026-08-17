# Writing Juggler Extensions

This is the authoring guide for **extensions** — the unit Juggler uses to add
capabilities. It covers the concepts, packaging, and workflow. For the actual
classes and methods you call, it points you at the SDK source: every base class
in `web/sdk/` carries a JSDoc header with a quickstart and a full method
reference, and that source is the canonical API documentation. This guide stays
high-level so it doesn't drift from the code.

> **Terminology.** The unit of packaging is an **extension**. The things an
> extension can contribute are **capabilities**. ("Plugin" is the old word for a
> capability — you'll still see it in some identifiers like the `@plugin-api`
> JSDoc marker and the `plugins.disabled` config key.)

## Capabilities

An extension bundles any mix of three capability types — each a class you
`export default`, extending an SDK base class and declaring a `static MANIFEST`:

| Capability | What it does | Base class (SDK module) | Built-in examples |
|------------|--------------|-------------------------|-------------------|
| **Context Item** | A tool the LLM can call (read a file, search, run a command) | `juggler/context-item` | `glob`, `read_file`, `write_file` |
| **Strategy** | Controls how the agentic loop runs — turns, tools, stopping | `juggler/strategy-type` | `default`, `read-only`, `yolo` |
| **Command** | A user-invoked slash command (`/clear`, `/compact`) | `juggler/command-type` | `clear`, `compact`, `thread` |

An extension may **also** contribute a **system-prompt contribution** — not a
class but a single module whose default export adds terse, durable guidance to
the system prompt (see [System-prompt contribution](#system-prompt-contribution)
below). An extension that provides *only* a system-prompt contribution (a
"prompt pack") is valid.

Juggler ships its own built-ins as one core extension, `@juggler/core`
(`web/extensions/juggler-core/`), loaded through the **exact same path** as any
third-party extension. It is the best reference for well-formed capabilities.

> **Just want a `/name` shortcut for a prompt you reuse?** You don't need an
> extension. A [custom slash command](custom-commands.md) is a no-code markdown
> file — a prompt template plus a few options — editable from the UI. Reach for a
> Command capability (below) only when the command needs real code.

## Quick start

```bash
juggler ext init my-extension       # scaffold manifest + one sample of each capability + README
juggler ext validate ./my-extension # run the server's admission check locally
juggler ext link ./my-extension     # symlink into ~/.juggler/extensions (hot-reloads on save)
juggler ext add github.com/owner/repo  # git-clone a published extension into ~/.juggler/extensions
```

`ext validate` applies the **same** check the server runs at discovery —
required manifest fields, `engineApi` compatibility with this host, and that
every `provides` glob resolves to real files — so a packaging mistake fails fast
with a clear `✗` instead of a silently-missing extension. `ext link` symlinks
your dev directory into `~/.juggler/extensions/` (validating first); start or
reconnect to Juggler once and it loads. From then on, editing any capability
file or the manifest **hot-reloads** the extension in connected viewers — no
restart.

`ext add` is a plain `git clone` into `~/.juggler/extensions/<name>`; it prints
the extension's declared permissions and asks you to confirm before keeping it
(`-y` skips the prompt). There is no auto-update — **update an installed
extension with `git pull` in `~/.juggler/extensions/<name>`**, then reconnect (or
save a file to hot-reload).

## Anatomy of an extension

An extension is a directory with a `juggler.extension.json` manifest at its root
and capability files grouped by type:

```
my-extension/
  juggler.extension.json
  context-items/word-count-context-item.js
  strategies/cautious-strategy-type.js
  commands/hello-command-type.js
  README.md
```

A capability file's name **must** end with the suffix for its type — that is how
the manifest globs find it:

| Capability | Filename suffix |
|------------|-----------------|
| Context Item | `*-context-item.js` |
| Strategy | `*-strategy-type.js` |
| Command | `*-command-type.js` |

Files without a suffix (private helpers, base classes) are imported by capability
files but are not themselves registered — group them in subdirectories as the
core extension does (`context-items/edit/`, `context-items/execute/`).

### The manifest

```jsonc
// juggler.extension.json
{
  "id": "@you/my-extension",        // scoped id — no global collisions
  "name": "My Extension",
  "version": "1.0.0",
  "author": "you",                  // optional
  "homepage": "https://…",          // optional
  "engineApi": "^1.0.0",            // host SDK compat range, checked at load
  "permissions": ["filesystem.read"],
  "provides": {
    "contextItems": ["context-items/*-context-item.js"],
    "strategies":   ["strategies/*-strategy-type.js"],
    "commands":     ["commands/*-command-type.js"],
    "systemPrompt": "system-prompt-contribution.js"   // optional; single module path
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Scoped, e.g. `@you/name`. The unit of enable/disable. |
| `name`, `version` | Yes | Display name and semver. |
| `provides` | Yes | At least one capability. `contextItems`/`strategies`/`commands` are root-relative globs; `systemPrompt` is a single module path (see [System-prompt contribution](#system-prompt-contribution)). Neither may escape the extension root. |
| `engineApi` | Recommended | Semver range (`^1.0.0`, `1.2.3`, or `*`). Omitting it disables the compat check and earns a validation warning. The host SDK version lives in `web/sdk/version.js`. |
| `permissions` | As needed | **Declares** the host access this extension's code uses. Surfaced to the user in the catalog and the install prompt — a disclosure, not a sandbox (see [Trust model](#trust-model)). Known values: `filesystem.read`, `filesystem.write`, `shell.exec`, `web.fetch`. |
| `author`, `homepage` | Optional | Metadata. |

A duplicate capability id across extensions is a surfaced load error, never a
silent last-write-wins: the lowest-precedence provider holds the id.

The manifest is the canonical definition of these fields:
`cmd/juggler/extmanifest/extmanifest.go`. Each capability *also* has its own
`static MANIFEST` (id, name, version, description, plus type-specific fields) —
that's defined in the SDK base class's JSDoc typedef.

### Where extensions live

| Location | Scope | Path |
|----------|-------|------|
| **Built-in** | Always | embedded `@juggler/core` |
| **Global** | All projects | `~/.juggler/extensions/` |

Precedence is global → built-in. Two extensions cannot provide the same
capability id: a duplicate is a surfaced load error, and the built-in (lowest
precedence) keeps the id.

## Trust model

Extensions are **unsandboxed JavaScript running with the full privileges of the
app** — exactly like plugins in an editor. An enabled extension's code can read
and write your files, run shell commands, and reach the network through
`juggler/ops` (and, being ES modules in the same realm, even around it). There is
no per-extension containment.

That means the `permissions` manifest field and the catalog's permission badges
are **disclosure, not enforcement**: they tell you what host access an
extension's code declares it uses, so you can make an informed decision. They do
not stop an extension from doing more. The real safeguards are the ones you
control at runtime — tool-approval dialogs and allowed-paths — plus the single
rule that matters most:

> **Install and enable only extensions you trust.** Treat an extension like any
> other code you're about to run — you install a global extension deliberately
> (`ext add` prints its declared permissions and asks you to confirm), so only
> add ones whose source you trust.

## The SDK

Extensions import **only** from the public `juggler/*` specifiers — the same
surface the core extension uses, which is how third-party parity is guaranteed.
The import map in `web/index.html` / `web/engine.html` is the full list; the ones
you'll reach for:

```javascript
import ContextItem from 'juggler/context-item';
import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';
import CommandType from 'juggler/command-type';
import { readFile, writeFile, glob, grep, shell, webFetch } from 'juggler/ops';
import { smartTruncate, createElement } from 'juggler/ui';
```

- **`juggler/ops`** is the privileged host-operations layer — filesystem, shell,
  search, tree, and web operations that were once built-in-only. These ops run
  with the user's full authority; there is no per-extension sandbox. Declare the
  access your code uses in the manifest `permissions` list — that declaration is
  surfaced to the user (catalog + install prompt) as disclosure, **not** a gate
  (see [Trust model](#trust-model)). The actual gate is the user-approval layer
  (tool approval dialogs, allowed-paths), which applies to every op. The export
  names are a clean vocabulary (`readFile`, `writeFile`, `editFile`, `stat`,
  `mkdir`, `glob`, `getTree`, `grep`, `findSymbol`, `shell`, `shellBackground`,
  `webFetch`, `webSearch`, `openPath`, `revealPath`, plus
  `FileSystem`/`ReadOnlyFileSystem` and `OpsError`). See `web/sdk/ops.js`.
- **`juggler/ui`** holds render/format helpers (`smartTruncate`, `createElement`,
  `FormattingHelpers`, …). See `web/sdk/ui.js`.

An extension whose `engineApi` range excludes the current SDK version is refused
at load with a clear diagnostic instead of a mystery `import` failure
(`web/sdk/version.js`).

### What the version promise covers

The `engineApi` semver promise (`web/sdk/version.js`) covers a **specific
surface**, not everything you can reach:

- **Covered:** the named exports of each `juggler/*` module; the documented
  `static MANIFEST` fields and `provides` fields; and the MessageThread methods
  marked **`@plugin-api`** in `web/js/model/message-thread.js`.
- **Not covered:** anything reached through `this.session` / `this.conversation`,
  the raw Y.Map objects from `messageThread.items` / `CommandType.items`, and any
  member tagged `@internal` or `@deprecated`. These work today but can change at
  any release — don't build on them.

## Writing each capability

Each base class's JSDoc header is the real reference — read it first. Below is
the shape of each, with one runnable example. Study the matching built-ins under
`web/extensions/juggler-core/` as templates.

### Context Item — a tool for the LLM

Implement `static getToolDefinitions()` (the schemas the model sees), `execute()`
(do the work), and `getSummary()` (format the result). `execute()` returns **raw**
data; the framework wraps it as an outcome `{ success, result, prepared, error }`.
The single most common mistake is reading `outcome.foo` instead of
`outcome.result.foo` — that returns `undefined` and the model sees an empty
result.

```javascript
import ContextItem from 'juggler/context-item';

class WordCountContextItem extends ContextItem {
  static MANIFEST = {
    id: 'word-count',
    name: 'Word Count',
    version: '1.0.0',
    description: 'Count words in a text string'
  };

  static getToolDefinitions() {
    return [{
      name: 'word_count',
      category: 'read',
      description: 'Count words in a text string',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to count' } },
        required: ['text']
      }
    }];
  }

  async execute(params) {
    return { count: params.text.split(/\s+/).filter(Boolean).length };
  }

  getSummary(outcome) {
    if (!outcome.success) return { summary: outcome.error, success: false };
    return { summary: `${outcome.result.count} words`, success: true };
  }
}

export default WordCountContextItem;
```

The base class carries the boilerplate for all three: `this.successSummary(text,
extra)` / `this.failureSummary(message, extra)` build the standard summary shape,
`this.truncateForLLM(output)` caps large output at the conversation's budget
(appending the "output truncated" note), and `this.buildStatusUI(actionStatus,
{ typeName, pending, success, failurePrefix })` renders the usual
pending / success / failure status ladder.

For destructive tools set `requiresApproval: true` and implement
`getApprovalConfig()`; for rich viewer rendering implement `getStatusUI()`. The
full method table, the engine-vs-viewer execution-context rules, and every typedef
live in **`web/sdk/context-item.js`**. Good templates: `glob-context-item.js`
(simple read), `read-file-context-item.js` (validation + status UI),
`write-file-context-item.js` (approval + diff), `search-context-item.js` (many
params, truncation).

**Staying out of collapsed tool groups — `static isGroupable()`:** the transcript
can fold a run of adjacent tool rows into a single tile, and every ordinary tool
row folds — a run of "this tool ran" records is exactly what is worth collapsing.
Return `false` from `static isGroupable()` when your row must stay on screen in
its own right: either because the row IS the item (a type that returns `false`
from `isVisible()` has no standing card, so it renders its whole state on the
row, and folding would hide the item rather than a record of it), or because the
user is meant to keep it in sight. The built-ins that opt out are `plan` and
`todo` (no standing card), `AskUserQuestion` (the record of what the user was
asked and answered), and `define_command` / `new_conversation` (artifacts created
outside this transcript). An opted-out row is left unfolded and breaks the run
around it, so no tile ever spans it.

**Per-turn side-effects — `static onTurnEnd(ctx)`:** to do work once at the end of
every turn — retain a memory, ping an external service, checkpoint state — add a
static `onTurnEnd(ctx)`. It runs in the engine each time the root conversation
goes idle, once per completed turn, for **every** context-item type that defines
it — including turns where your tool was never called. It's a *type*-level hook
(context items are per-tool-call, so there's no per-conversation instance), so
keep conversation-scoped state in session/conversation metadata keyed off
`ctx.conversation.id`. It's fire-and-forget and **side-effects only** — read the
transcript via `ctx.messageThread` and do external work; to feed something back
into the next turn use `getContextText()` instead (the read-in half to
`onTurnEnd`'s write-out). Forward `ctx.signal` to async work so a slow run bails
when the next turn supersedes it. A throw is logged and isolated.

### Strategy — control the agentic loop

**How strategies actually run:** in a normal install the **Go worker owns the
loop** (call → execute tools → repeat). A strategy does not drive that loop — it
*shapes* it through its `static MANIFEST` and a set of hooks the worker calls in
the engine. The built-in strategies (`read-only`, `default`, `yolo`) work purely
this way; `read-only-strategy-type.js` is the simplest and best starting point.

The production surface is:

- **MANIFEST fields**: `defaultRules`, `defaultAllowedPaths`, `toolExecution`,
  `showsApprovalControls`, `recommendations`, `color`, `icon`.
- **`filterTools(tools)`** — restrict the tools the model may call (per phase).
- **`getApprovalPolicy(info)`** — auto-approve or force-approve a tool call
  (with the exported `APPROVAL_POLICY` constants).
- **`onActivate(prevId)` / `onWorkerIdle()`** — inject guidance / drive
  follow-on work. Steer the model with **`injectGuidance()`** (a durable
  system-reminder), never by authoring system-prompt text.
- **`createThread()` / `continueConversation()`** — worker-request primitives
  for multi-phase strategies.

```javascript
import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';

// A "planning" strategy: expose only read/meta tools and auto-approve them, so
// the model investigates without touching files or stopping for prompts.
class PlanningStrategyType extends StrategyType {
  static MANIFEST = {
    id: 'planning',
    name: 'Planning',
    version: '1.0.0',
    description: 'Read-only investigation before any changes',
    author: 'You',
    showsApprovalControls: false
  };

  filterTools(tools) {
    return tools.filter(t => t.category === 'read' || t.category === 'meta');
  }

  getApprovalPolicy({ category }) {
    return (category === 'read' || category === 'meta')
      ? APPROVAL_POLICY.APPROVE
      : APPROVAL_POLICY.DEFAULT;
  }

  onActivate() {
    this.injectGuidance('PLANNING MODE: investigate and propose a plan; do not modify anything.');
  }
}

export default PlanningStrategyType;
```

A strategy never drives the loop itself: the Go worker owns it, and the strategy
shapes it through the manifest and hooks above.

The built-in strategies form a single autonomy axis — **Read-only** (cannot
write), **Default** (asks before writing), **YOLO** (never asks). The full hook
list and manifest fields are in **`web/sdk/strategy-type.js`**.

**Keeping a strategy out of the picker — `hidden: true`:** a strategy with
`hidden: true` in its manifest is excluded from every user-facing list (the
selector, the Shift+Tab ring, the default-strategy picker, the command editor)
and from the first-available fallbacks, but stays resolvable by id. That is for a
strategy nobody picks — one that shapes a single delegated run rather than a mode
the user enters. See the sub-agent pattern below.

### Sub-agent — a tool that runs as its own agent

A context item whose tool runs its invocation as a delegated child thread, under
a strategy the item itself owns. The child's working context — its searches, its
reads, its intermediate tool calls — never enters the caller's; only its final
message comes back as the tool result. `Explore` and `Research` in
`@juggler/core` are the reference implementations
(`context-items/explore-agent-context-item.js` and its `subagents/` siblings).

Three parts:

1. **The item delegates.** Set `delegatesToSubthread: true` in its MANIFEST and
   return a spec from `buildSubthreadSpec(toolInput)` — a very short,
   single-line, user-facing `goal`; a complete self-contained `prompt` (the child
   sees nothing of the caller's conversation); and `resultSpec`, containing only
   the return contract. Keep these three jobs separate. If the tool exposes a
   session argument, pass it through as `sessionName`.
2. **The item owns a hidden strategy.** Return it from
   `static getStrategies()`; the framework registers it and forces
   `hidden: true`. Put the class in a module *beside* the item, not under the
   extension's `strategies/` directory — that glob would register it as an
   ordinary, visible strategy.
3. **The spec pins it.** Set `spec.strategyId` to the strategy's id, guarded on
   `strategyRegistry.has(id)` so a user who disabled the extension's strategies
   gets a working (if unfiltered) child instead of a broken tool.

**The no-hang invariant.** A sub-agent thread has no human in it, and
`APPROVAL_POLICY` has no DENY. So a tool the strategy exposes but cannot
auto-approve does not prompt anybody — it strands the caller's tool call for the
life of the conversation. Everything surviving `filterTools` must therefore be
either auto-approved by `getApprovalPolicy` or refused outright by
`onToolPending` (`refuseApproval(toolUseId, reason)`, which settles the call as a
failed tool the sub-agent can work around — **not**
`resolveApproval(toolUseId, 'no')`, which records it as a human denial and stops
the turn). Withhold anything that
blocks on a person — note `AskUserQuestion` is category `read`, so a naive
read-only filter keeps it, and as an *elicitation* it can be neither approved nor
refused — and anything that steers the caller's session (`todo`, `plan`,
`memory`, `define_command`, `new_conversation`).

Deliver the sub-agent's brief through the strategy's `onActivate()` →
`injectGuidance()`, from its own prompt module. In a freshly-born thread that
reminder leads the transcript, so it acts as the brief without touching the
cached system prefix.

### Command — a slash command

The simplest type: no LLM, no approval. Implement `execute(args)` and return a
`CommandResult` (`{ handled, message?, error?, sideEffects? }`). Commands can't
perform host side-effects directly (opening a thread, etc.) — they **declare**
them on `sideEffects` and the host dispatches.

```javascript
import CommandType from 'juggler/command-type';

class HelloCommandType extends CommandType {
  static MANIFEST = {
    id: 'hello',
    name: 'Hello',
    version: '1.0.0',
    description: 'Say hello'
  };

  async execute(args) {
    return { handled: true, message: `Hello, ${args[0] || 'world'}!` };
  }
}

export default HelloCommandType;
```

Manifest extras (`alias`, `icon`, `danger`, `mutatesConversation`,
`coalesceUndo`) and the `CommandResult`/`CommandSideEffect` typedefs are in
**`web/sdk/command-type.js`**. Templates: `clear-command-type.js` (minimal),
`compact-command-type.js` (alias), `thread-command-type.js` (side effects).

If your command **writes to the conversation** (snapshots, moves, deletes, or
re-seeds items), set both **`mutatesConversation: true`** (so the host settles
any live turn before `execute()` runs, avoiding a race) and **`coalesceUndo:
true`** (so a multi-step mutation reverts as one undo). *When in doubt, set
both* — they are only unnecessary for pure read/side-effect commands (`/help`, a
command that only opens a panel), and setting them there is harmless.

### System-prompt contribution

Add durable guidance to the prompt. Not a class: a **single module** named by the manifest's `provides.systemPrompt`
(a plain path, not a glob). Its **default export** is
`({ enabledPluginIds }) => string` and must be a **pure function** of the
enabled-plugin set — it is folded into the *cached* system-prompt anchor, so it
runs once and its output must be stable across turns and strategy changes (do not
read the clock, conversation, or anything else). Gate each section on the plugins
that are on (`enabledPluginIds.includes('my-tool')`) so the prompt never
advertises a capability the user has disabled. Keep it terse: this text is a
permanent resident of every turn's context, billed at the cache-read rate. An
extension may provide *only* this (a prompt pack) with no other capabilities.

```javascript
// system-prompt-contribution.js
export default function systemPromptContribution({ enabledPluginIds }) {
  const has = (id) => enabledPluginIds.includes(id);
  const sections = [];
  if (has('my-tool')) {
    sections.push('## My Tool\nPrefer `my_tool` over shelling out for X; it returns structured Y.');
  }
  return sections.join('\n\n'); // may be empty
}
```

Reference: `web/extensions/juggler-core/system-prompt-contribution.js`; the
aggregation contract is in `web/sdk/lib/system-prompt-registry.js`.

## Talking to the conversation

Commands and strategies receive a **`MessageThread`** (`this.messageThread`). It
is the **only** interface you should use to read or mutate conversation state.
Its safe public methods are marked **`@plugin-api`** in the source —
`web/js/model/message-thread.js` is the reference; grep it for `@plugin-api`.

Common reads: `items`, `length`, `findByItemId(id)`, `contextItems`,
`modelConfig`, `permissions`. Common writes: `addEvent()`, `deleteItemById()`,
`addContextItem()`. For several mutations as one atomic Yjs
transaction use **`mutate(fn)`** (it also runs `assertInvariants()` in dev mode);
`buildThreadYMap()` is the safe way to seed a sub-thread with items.

> **Never touch raw Yjs objects from a capability** — `messageThread.yarray`,
> `.container.set(…)`, or importing `yjs.mjs`. The framework maintains invariants
> (every thread owns one SYSTEM_1, itemId uniqueness, the tool state machine)
> reactively in Yjs observers that only fire for mutations routed through the
> `@plugin-api` methods. Bypassing them breaks undo, redo, and peer sync. This is
> a hard rule, not a style preference.

## Pinned file content vs. reads

Juggler distinguishes two ways a file's contents reach the model:

| Item | Role | Content read | Placement |
|------|------|--------------|-----------|
| `ReadFileContextItem` | Immutable record of a `read` tool call | Once, at call time | conversation history (part of the transcript) |
| `FileContentContextItem` | A user's "keep this file current" pin | Live, every turn | `contextPosition: 'prefix'` (before history) |

The split is **who asked**. A **read** is the model's: it lands in the
append-only history as a `tool_use`/`tool_result` pair and never moves, so it is
inside the byte-stable cached prefix and is paid for **once**.

Everything the **user** points at is a pin — the file picker, an `@`-mention
(the composer creates one pin per mentioned path), and the `CLAUDE.md` /
`AGENTS.md` a session seeds itself with. An `@`-mention is not a read, and is
not a one-shot: a mentioned file is as live as any other pin.

A **pin** means "this file, kept current." It persists only a `path` in Yjs (no
bytes), and `createContextText()` resolves the live file every turn. Because a pin
rides the leading, cached prefix (`contextPosition: 'prefix'`), an *unchanged* file
renders byte-identically each turn → the prompt cache hits and the pin is paid for
once; only a *genuine change* to the file busts the cache from that point — which
is exactly the point of a pin. There is no watcher (nothing is in flight between
sends) and no bytes in the document (pinning a 5 MB file doesn't bloat Yjs).

### `contextPosition`: where a standing item's content is injected

A context item's `MANIFEST.contextPosition` decides where its rendered content
lands in the request, which governs whether it is cached:

| Value | Placement | Cached? | Built-in users |
|-------|-----------|---------|----------------|
| `system` | folded into the system prompt | yes; a change re-bills the whole request | memory, skills, system-prompt |
| `prefix` (default) | leading messages, **before** history | yes; unchanged render caches, a real change busts once | file-content, dropped-file |
| `none` | not injected at all | n/a — state lives in tool_use history | todo, plan |

**Freeze anything at the `system` position that is sourced from outside the
conversation.** Both built-in examples read from somewhere shared — memory from
`.juggler/MEMORY.md`, skills from the skills directories — so both snapshot into
`this.data` in `onToolCall` (write-once) and render that snapshot in
`createContextText`. Reading live there is the most expensive mistake in this
table: the system block is the head of the cached prefix, so a single edit
doesn't just bust the current turn, it forces **every open conversation** to
re-read its entire context at the uncached rate. Freezing costs those
conversations nothing and lets the change reach new ones instead.

There is deliberately **no trailing/tail position**. Standing content is either
cacheable (`system`/`prefix`) or lives in the model's own tool history (`none`);
content that genuinely changes every turn is an anti-pattern (it would bust the
cache each turn) — put that state in a tool result instead. Content the model
fetched for itself (a `read`) belongs in the append-only history, not in a
standing context item.

## Enabling and disabling

Settings (gear icon) → **Extensions** lists every installed extension, its
bundled capabilities, and any that failed to load. Toggle a whole extension or an
individual capability live. Toggles persist to your project config
(`<project>/.juggler/config.json`) as a flat list of disabled ids — an extension
id disables everything it bundles:

```json
{ "plugins": { "disabled": ["web-search", "@you/my-extension"] } }
```

## Reference map

- **API source of truth** — `web/sdk/`: `context-item.js`, `strategy-type.js`,
  `command-type.js`, `ops.js`, `ui.js`, `version.js`. Read the JSDoc headers.
- **Conversation API** — `web/js/model/message-thread.js` (grep `@plugin-api`).
- **Worked examples** — `web/extensions/juggler-core/` (the built-in extension).
- **Manifest format** — `cmd/juggler/extmanifest/extmanifest.go`.
- **CLI** — `juggler ext --help`.
