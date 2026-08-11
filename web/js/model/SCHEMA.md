# Conversation Yjs schema

The on-disk source of truth for a conversation is a single Yjs document
(`Y.Doc`). This file enumerates every well-known top-level structure, the
keys inside each, and the invariants the runtime maintains across them.

**Authoritative producers/consumers:** `web/js/model/conversation-document.js`
(top-level structure), `web/js/model/message-thread.js` (per-thread mutations),
`web/sdk/lib/message.js` (item-level typedefs), `web/js/model/conversation-observers.js`
(invariants). Tests under `web/js-tests/` exercise these shapes end-to-end —
treat `test/utilities/test-harness.js` as the executable schema reference.

Keep this file in sync when adding a new top-level key, new item type, or
new metadata field. The PR that introduces the key is the PR that updates
this doc.

---

## 1. Top-level structure

A `Y.Doc` for a single conversation exposes three named top-level shared
types (see `ConversationDocument` constructor):

| Top-level | Yjs type | Producer | Purpose |
|---|---|---|---|
| `root` | `Y.Map` | `doc.getMap('root')` | Container for the conversation items array. |
| `metadata` | `Y.Map` | `doc.getMap('metadata')` | Per-conversation settings (model, strategy, permissions, etc.). |
| `undoLog` | `Y.Array` | `doc.getArray('undoLog')` | Worker-managed undo log. Main thread does not own a `Y.UndoManager`; the worker mutates this log and the main thread observes it via the `undoState` metadata key. |

### `root` Y.Map

| Key | Type | Description |
|---|---|---|
| `items` | `Y.Array<Y.Map>` | Ordered conversation flow. Each entry is an item Y.Map (see §2). Created lazily via `MessageThread.ensureYarray()`. |
| `modelConfig` | `Y.Map` \| object | Active model selection: `{providerId, modelId, ...overrides}`. Optional `thinking` override (`'off'\|'low'\|'medium'\|'high'\|'max'`; absent ⇒ provider default) rides atomically with the pair. Mirrored on each thread container; the root copy is the conversation default. |
| `draft` | `Y.Map` \| object | Unsent composer-box draft as one record: `{text, attachments}` (staged image `AssetRef`s). Stored as a single object so text and attachments persist or clear together — never half. Root draft lives in `metadata.draft`; per-thread drafts live on the thread container. |

Note: the conversation **name** is **not** stored in the Y.Doc. It lives on
the on-disk folder name and is mutated via the rename API (see comment in
`conversation-observers.js:158-161`).

### `metadata` Y.Map

| Key | Type | Producer | Notes |
|---|---|---|---|
| `modelConfig` | object | `Conversation.setModelConfig` | `{providerId, modelId, options?}`. Triggers `_fetchContextWindow` on change. |
| `currentStrategyId` | string | `Conversation.setStrategy` / strategy plugins | One of the registered strategy IDs (`default`, `plan`, `research`). Change reinstantiates the root thread's `strategy`. |
| `permissions` | object | `MessageThreadPermissions` | Persisted tool-approval grants keyed by tool name/path. |
| `processingState` | `Y.Map` | Worker | `{status: 'idle'|'busy', ...}`. On the root idle transition the worker dispatches `onWorkerIdle` to the engine (run-strategy-hook), never to a viewer. |
| `activatedStrategyId` | string | Worker | Last strategy whose `onActivate` hook the worker has run. Drives once-per-switch activation; survives reload/re-exec. |
| `undoState` | object | Worker | `{canUndo, canRedo, ...}`. Pushed FROM worker; main thread only reads. |
| `nextSteps` | string \| null | Strategy plugins | Hint text rendered in the column header until a new turn starts. |
| `draft` | `Y.Map` \| object | Composer | Root conversation's unsent draft: `{text, attachments}`. Per-thread drafts live on the thread container instead. |
| `isProvisionalName` | boolean | Worker (seed) / `Session.setNameIsProvisional` | Whether the name is still provisional (machine-derived) and so may be replaced by the auto-namer. Seeded on first init from the `Untitled N` shape; cleared by a rename, set by the "Auto-name" button and `/handoff`. |

`undoLog` and `metadata.undoState` are split deliberately: the log is a CRDT
that survives sync; the state is the worker's view of "what can be
undone/redone right now" and is replaced wholesale on each worker tick.

The conversation **name** is not in the doc, but `isProvisionalName` — its
*provenance* — is. That is deliberate: the marker then rides the doc copy into a
duplicate (so a `/handoff` clone stays eligible for a derived title), and the
worker holding the doc is what the server asks before renaming a tab.

---

## 2. Item Y.Map shapes

Every entry in an `items` Y.Array is a `Y.Map` discriminated by its `type`
key. Always access fields via `item.get(key)` / `item.set(key, value)` —
the typedefs in `message.js` document the schema but the literal property
syntax is for type-checking only.

All items may optionally carry:
- `itemId` (string) — stable identifier used by the renderer for DOM diffing
  and selection. Some types (thread, context-item) make this required.
- `transactionId` (string) — groups items inserted in the same Yjs
  transaction; used by undo/redo to undo a turn as a unit.

### `type: 'user'` — `UserMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | The user's typed text. |

### `type: 'assistant'` — `AssistantMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Assistant prose. Streamed in chunks; the renderer treats `content` updates specially via `BaseMessage._supportsStreaming`. |

### `type: 'thinking'` — `ThinkingMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Extended-thinking text. |
| `providerData` | object \| undefined | Opaque provider blob (e.g. signed thinking token for Anthropic). Round-tripped verbatim. |

### `type: 'tool-action'` — `ToolActionMessage`
Unified lifecycle for one tool call. See `TOOL_STATES` for state machine.

| Key | Type | Notes |
|---|---|---|
| `toolUseId` | string | Provider-assigned tool-use ID. |
| `toolName` | string | Plugin tool name (`read-file`, `glob`, `execute`, …). |
| `toolInput` | object | Plugin-specific input. |
| `state` | `'pending' \| 'approved' \| 'running' \| 'completed' \| 'cancelled'` | Undefined before approval flow starts. |
| `approvalResponse` | string \| undefined | Last user response to the approval modal. |
| `approvalOptions` | object \| undefined | Approval UI options snapshot. |
| `displayData` | object \| undefined | Renderer hints. |
| `result` | `Y.Map` \| object \| null | Populated on terminal states. `result.resultType` distinguishes `'context'`, `'action'`, `'meta-tool'`, `'drop'`, `'strategy-tool'` (see `RESULT_TYPES`). For `'context'`, `result.itemType` carries the produced context item's type. |
| `contextItemId` | string \| undefined | Set when the action emits / mutates a context item. |

State machine (command-driven: the Go worker observes every doc update and
drives the lifecycle by commanding the engine — `evaluate-tool` →
`execute-tool` → `cancel-tool`; the engine has no reactive tool reducer):
```
undefined → pending → approved → running → completed
                              ↘            ↘ cancelled
                  (auto-approve)
undefined → approved → running → completed | cancelled
```

### `type: 'thread'` — `ThreadMessage`
A nested sub-conversation.

| Key | Type | Notes |
|---|---|---|
| `itemId` | string | **Required.** Format: `thread_<ts>_<rand>`. |
| `goal` | string | Human description of what the thread is for. |
| `result` | string \| null | Set by `return_result`. Null while in flight. |
| `items` | `Y.Array<Y.Map>` | The nested conversation. Every thread is isolated. A sub-thread is born empty (no `SYSTEM_1`); its system prompt is sourced from the root thread at LLM-call time. |
| `resultSpec` | string | Optional. The caller's contract (from `create_thread`) for what the thread's `return_result` summary must contain. Stored at creation, surfaced at the top of the thread column, and appended to the thread's seed message. Absent when the caller omitted it. |
| `modelConfig` | object | Per-thread override of the root model. May carry an optional `thinking` level (`'off'\|'low'\|'medium'\|'high'\|'max'`) that overrides atomically with the model. |
| `draft` | `Y.Map` \| object | Per-thread unsent input draft as one record: `{text, attachments}`. |
| `needsStrategyRun` | boolean | One-shot flag: the worker auto-runs the strategy loop for this thread, then clears it. Set by plugins that create a self-driving thread (e.g. `/compact`). |
| `noAutoSelect` | boolean | The UI must not auto-select into this thread on creation (e.g. `/compact` folds in place). |
| `canSpawnThreads` | boolean | Optional. Marks a **human-steered** thread whose LLM may itself call `create_thread`. Set up front by `/thread` (user-created), or stamped when a human sends a genuine message into any non-delegated thread (`promoteThreadSpawnCapable`, called from the worker's send handler). Absent on threads born from LLM `create_thread`, delegated subthreads, strategies, orchestrator, or compaction/handoff until a human engages them ⇒ the worker withholds `create_thread` from that thread's tool list (see `filterToolsForThread` in `llm_request.go`). Delegated threads are never promoted. |
| `forceTool` | string | Tool name the model **must** call on every strategy turn of this thread. The worker translates it into a provider `tool_choice`, withheld from providers that cannot honour one (`ForcedToolChoiceUnsupported`, and claudecode degrades to text) — for those a mandated close falls back to promoting the turn's trailing text as the result. A `/compact` fold carries `'return_result'` as an identity marker for legacy folds only; its summary is produced by the worker's tool-free folded-compaction summariser, not by this directive. Generic — any plugin may set it. |
| `boundedCompaction` | boolean | Marks a `/compact` (or `/handoff`) fold: the worker summarises it with the folded-compaction summariser — one tool-free probe of the whole transcript, map/reduced only if the provider rejects it as too large — and commits the result here. |

### `type: 'guidance'` — `GuidanceMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Plugin/strategy-injected context. |
| `source` | string | Producer name (plugin/strategy ID). |

### `type: 'system-reminder'` — `SystemReminderMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Reminder body. |
| `source` | string | Producer name. |

### `type: 'error'` — `ErrorMessage`
| Key | Type | Notes |
|---|---|---|
| `message` | string | Short error text. |
| `content` | string \| undefined | Long form / detail. |
| `summary` | string \| undefined | Renderer subtitle. |
| `stack` | string \| undefined | Stack trace. |
| `hasRetryButton` | boolean \| undefined | Whether the UI should offer a retry. |

### `type: <context-item-type>` — `ContextItemMessage`
For non-tool context items (`rule`, `system-prompt`, `file-content`, …), the
`type` field IS the context-item type id (no `'context-item'` wrapper).
Tool-produced context items use `type: 'tool-action'` with
`result.resultType === 'context'` instead.

| Key | Type | Notes |
|---|---|---|
| `itemId` | string | Required for diffing & selection. |
| `data` | object \| undefined | Inline context item payload. |
| `isNew` | boolean \| undefined | Set once on insert; cleared after first render. |
| `error` | string \| undefined | Creation error, if any. |
| `preventUserDeletion` | boolean \| undefined | If true, the delete control is hidden. |

### LLM-only output types (`tool-use`, `tool-result`)
`tool-use` and `tool-result` items are produced by the context-builder when
preparing a request payload — they are **not** stored in `items`. They split
a `tool-action` into the request/response pair the LLM API expects. Listed
here only to document why `MESSAGE_TYPES` enumerates them.

---

## 3. Invariants

The rule is: **co-varying state is reconciled in observers, not click
handlers** (see `CLAUDE.md`). Click handlers set the trigger property; the
observer derives the consequence. This makes invariants hold for click,
undo, redo, and peer sync uniformly.

Live invariants (each maintained by a Yjs observer):

| Invariant | Maintained by | Trigger |
|---|---|---|
| Tool-actions are evaluated, executed, and cancelled at most once per state transition. | Go worker `driveToolActions` (in `tool_commands.go`) observes every doc update and commands the engine: `evaluate-tool` → `handleNewToolAction`, `execute-tool` → `claimRunning` + `executeToolAction`, `cancel-tool`. The engine has no reactive tool reducer. | worker doc-update observer |
| Approval cascades (cancelling a parent cancels children) and permission grants are persisted. | Worker commands `cancel-tool` for the cascade; `saveAutoApprovalPermission` runs in the engine's `handleExecuteTool` on a `yes-always` response. | worker doc-update observer |
| The root thread owns exactly one `SYSTEM_1` system-prompt placeholder; sub-threads own none. | Root seeds `SYSTEM_1` at creation (`initBuiltInContextItems`/`ensureSystemPromptPlaceholder`). Sub-threads carry no `SYSTEM_1` — the worker assembles their system prompt from the root thread's context items, so a per-sub-thread copy was vestigial. | thread creation |
| `nextSteps` UI indicator follows `metadata.nextSteps`. | `ConversationArea._metadataObserver` | metadata observe |
| Root thread's strategy follows `metadata.currentStrategyId`. | `setupYjsObservers` metadata observer | metadata observe |
| Context window fetches follow `metadata.modelConfig`. | `setupYjsObservers` metadata observer → `_fetchContextWindow` | metadata observe |
| When the root conversation goes idle, the strategy's `onWorkerIdle()` runs once in the engine. | Worker dispatches `run-strategy-hook` to the engine at its idle chokepoint; the engine runs the hook on its loaded copy. No per-viewer election. | worker idle transition |
| At the same idle moment, every context-item type's static `onTurnEnd()` runs once in the engine (one call per completed turn). | Worker dispatches `run-context-hook` from the same idle chokepoint; the engine fans it out over `contextItemRegistry` (types without the hook are skipped). Fire-and-forget, side-effects only. No per-viewer election. | worker idle transition |
| On a live strategy switch, the strategy's `onActivate()` runs once in the engine before the next turn. | Worker compares `currentStrategyId` vs `activatedStrategyId` at turn-start, dispatches `run-strategy-hook`, and blocks until the injected guidance syncs back. | worker turn-start |

**Engine vs viewer:** several reactions are gated to one side. The engine
must not autonomously insert items (it races viewer-driven mutations); the
viewer must not drive strategy execution that the engine would also drive.
The `isViewer()` / `isEngine()` checks in `utils/client-role.js` are the
single source of truth.

---

## 4. Versioning / migration

There is **no `version` field** on the doc today, and no in-place migration
machinery. Compatibility is maintained by:

- Additive changes only: new keys are introduced with safe defaults,
  consumed defensively (`item.get(key) ?? fallback`).
- Removed keys are tolerated (old docs may still carry them; readers ignore).
- Type changes are forbidden without a coordinated worker + UI deploy.

If a real migration is ever required, the path is: introduce a
`metadata.schemaVersion` key on writes, gate readers behind it, and ship a
one-shot rewrite step. This is intentionally unbuilt; do not paper over
schema drift here without that step.

---

## 5. Keeping this honest

- `web/js-tests/utilities/test-harness.js` builds docs end-to-end. Every key
  the harness writes should appear in §1/§2 above; if you add a new key in
  production code, add it here AND to a harness scenario.
- `cmd/juggler/worker/document.go` is the Go-side mirror. The same key names
  are used; if you rename here, rename there in the same change.
- Run the unit suites under `web/js-tests/unit-tests/` (especially
  `yjs-compat-test.js`, `item-accessor-test.js`, `thread-nested-array-test.js`)
  before assuming a structural change is safe.
