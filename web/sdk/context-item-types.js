//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/context-item` type vocabulary — the JSDoc typedefs shared by the
 * ContextItem base class and every plugin/consumer. Split out of context-item.js
 * so the class file stays focused on behaviour; context-item.js re-exports these
 * names so `import('juggler/context-item').TypeName` keeps resolving. Imported
 * for typedefs only — no runtime exports.
 */

/**
 * Formatted result returned by getSummary() - single source of truth for results.
 * @typedef {object} ItemSummary
 * @property {string} summary - Result message for LLM tool_result content AND simple UI display
 * @property {string} details - Plain-text detail line carried with the result for simple display; getStatusUI supplies the rich per-item UI
 * @property {boolean} success - Whether the operation succeeded
 * @property {string} [icon] - Optional icon character (e.g., '✓', '✗')
 * @property {string} [feedbackForLLM] - Optional feedback appended to tool_result (e.g., test hints)
 * @property {import('../js/services/ops-api.js').AssetRef[]} [attachments] - Image/binary asset refs produced by the tool; the framework stores them at the tool-action item level (same field user attachments use) and emits them as image parts in the tool_result
 */

/**
 * Approval UI configuration returned as part of PreparedItem.
 * Contains all data needed to show the approval dialog.
 * @typedef {object} ApprovalConfig
 * @property {string} message - Message explaining what the action will do
 * @property {string} [title] - Dialog title (default: "Approve: {item name}")
 * @property {Array<{label: string, value: string, style: string}>} [options] - Custom buttons (default: Yes/Yes+Always/No)
 * @property {Record<string, unknown>} [display] - Extra display data (diffs, previews, etc.)
 */

/**
 * One "don't ask again" choice offered alongside an approval prompt.
 *
 * A plugin returns an escalating list of these (narrowest breadth first) from
 * `getApprovalSuggestions`. The framework renders one button per suggestion;
 * when the user picks one, exactly that suggestion's `rules` (under `itemType`)
 * and/or `allowedPaths` are persisted. The contract: after they are added,
 * `isPermitted(toolInput)` MUST return true — a suggestion that doesn't
 * actually cover the call is a bug. A pure path grant (only `allowedPaths`, as a
 * read offers to widen its filesystem scope) carries no rules and omits
 * `itemType`.
 * @typedef {object} ApprovalSuggestion
 * @property {string} [itemType] - Permission itemType the rules belong to (owning plugin id). Omitted for a pure `allowedPaths` grant, which has no owning plugin rule.
 * @property {Array<{kind: string, value: any, scope?: 'session'|'conversation'}>} [rules] - Rules to add when this suggestion is chosen
 * @property {string[]} [allowedPaths] - Framework-generic FS roots to add to the conversation's allowed-paths list when this suggestion is chosen. An alternative to `rules` for a command that is rejected only because it reads outside the allowed roots; granting the folders makes `isPermitted` true without wildcarding the command. A suggestion carries `rules` OR `allowedPaths`, never both.
 * @property {string} [label] - Display string summarising what gets approved (e.g. "git push *"); shown on the button when `patterns` is absent
 * @property {string[]} [patterns] - The individual pattern/path strings this suggestion covers. The framework renders each as its own `<code>` span joined by a plain-font "or", so a suggestion spanning several segments reads as distinct alternatives. Preferred over `label` whenever there is more than one.
 */

/**
 * A single-pattern suggestion re-derived from the user's edited text by the
 * optional `reviseApprovalSuggestion` hook (see `ContextItem`).
 *
 * The framework renders a pencil affordance on each editable "don't ask again"
 * button (single-pattern options only, when the action implements the hook),
 * turns the pattern into a text input, and calls the hook — debounced — on each
 * edit. It gates the button on `valid`, styles `notice` by `valid` (amber
 * caution when valid, red reason when not), and on approval persists the
 * returned `rules`/`allowedPaths` verbatim. The framework holds no glob or path
 * semantics; every match/broadness judgment lives in the plugin.
 * @typedef {object} RevisedApprovalSuggestion
 * @property {Array<{kind: string, value: any, scope?: 'session'|'conversation'}>} [rules] - Grant derived from the edited text (command-glob edits). Persisted verbatim on approval; same shape as the original suggestion's `rules`.
 * @property {string[]} [allowedPaths] - Grant derived from the edited text (folder-grant edits). Mutually exclusive with `rules`.
 * @property {string[]} patterns - Normalized display string(s) rendered back into the input (one element; the plugin may trim/canonicalize).
 * @property {boolean} valid - When false the framework disables the button and blocks Return. Set false when the edit is syntactically invalid or wouldn't approve the current command.
 * @property {string} [notice] - Optional human message, styled by `valid`: amber caution when valid (a "dangerously broad" warning), red reason when invalid.
 */

/**
 * Validation result from validate() - simplified validation-only return type.
 * @typedef {object} ValidationResult
 * @property {boolean} valid - Whether params are valid for execution
 * @property {Record<string, unknown>} [params] - Normalized params (if valid)
 * @property {string} [error] - Error message (if invalid)
 */

/**
 * Prepared item parameters returned by prepare().
 * Contains validation state, normalized params, and approval UI config.
 * @typedef {object} PreparedItem
 * @property {boolean} valid - Whether params are valid for execution
 * @property {Record<string, unknown>} [params] - Prepared params (if valid)
 * @property {string} [error] - Error message (if invalid)
 * @property {ApprovalConfig} [approval] - Approval dialog configuration (if requires approval)
 * @property {Record<string, unknown>} [displayData] - UI display context (diffs, previews, plan data)
 */

/**
 * Successful outcome
 * @typedef {object} OutcomeSuccess
 * @property {true} success - Discriminant: true for success
 * @property {Record<string, unknown>} result - Raw result data
 * @property {PreparedItem} [prepared] - Original prepared params
 * @property {boolean} [cancelled] - Allow checking cancelled before narrowing
 */

/**
 * Failed outcome - error is REQUIRED (not optional)
 * @typedef {object} OutcomeFailure
 * @property {false} success - Discriminant: false for failure
 * @property {string} error - REQUIRED error message (include context in message)
 * @property {Record<string, unknown>} [result] - Partial result if available
 * @property {boolean} [denied] - User denied approval
 * @property {boolean} [cancelled] - User cancelled
 * @property {PreparedItem} [prepared] - Original prepared params
 */

/**
 * Outcome - discriminated union enforces error field when success=false
 * @typedef {OutcomeSuccess | OutcomeFailure} Outcome
 */

/**
 * Semantic status for result styling.
 * - success: Completed successfully (green)
 * - error: Failed with an error (red)
 * - cancelled: Cancelled or denied by user (orange)
 * - running: In progress (blue)
 * @typedef {'success'|'error'|'cancelled'|'running'} ResultStatus
 */

/**
 * Status UI configuration returned by getStatusUI().
 * Plugins return this to describe what to display; the framework handles rendering.
 * @typedef {object} ResultStatusMessage
 * @property {string} [typeName] - Type label rendered as a lozenge badge (e.g., "Read", "Question")
 * @property {string|HTMLElement} summary - Status line content (string or custom element, will be truncated)
 * @property {ResultStatus} [status] - Semantic status for styling (success, error, cancelled, running)
 * @property {HTMLElement} [customFormElement] - Custom form element rendered at the item's full width below the status row, in place of the default approval buttons
 */

/**
 * One branch of a getStatusUI() ladder, as passed to `buildStatusUI()`. A bare
 * string or element is the status line and takes the branch's default status
 * ('running' while pending, 'success' when the action succeeded); return a
 * full ResultStatusMessage to override the status or add fields such as
 * `customFormElement`.
 * @typedef {string|HTMLElement|ResultStatusMessage} StatusBranch
 */

/**
 * Declarative description of a getStatusUI() ladder, consumed by
 * `buildStatusUI()`. Branches may be values or thunks — a thunk is only called
 * for the branch that applies, so a success branch can read `actionStatus.result`
 * without guarding for the pending case.
 * @typedef {object} StatusUIConfig
 * @property {string} typeName - Type label rendered as the lozenge badge
 * @property {StatusBranch|(() => StatusBranch)} [pending] - Shown while the action is running
 * @property {StatusBranch|(() => StatusBranch)} [success] - Shown when the action succeeded
 * @property {string} [failurePrefix] - Prefix for the error message on the failure branch
 * @property {string} [cancelledMessage] - Custom message for the cancelled branch
 */

/**
 * Unified tool call result returned by handleToolCall()
 * @typedef {object} ToolCallResult
 * @property {boolean} success - Whether tool executed successfully
 * @property {boolean} shouldContinue - Whether to continue the LLM loop
 * @property {boolean} [includeInConversation] - Whether to include result in LLM conversation
 * @property {string} [message] - Message shown to LLM in tool_result (success case)
 * @property {string} [error] - Error message shown to LLM (failure case)
 * @property {Record<string, any>} [result] - Result details for UI/debugging
 * @property {string} [itemId] - Context item ID (added by response-handler for context item tools)
 */

/**
 * Tool call execution context passed to handleToolCall()
 * @typedef {object} ToolCallContext
 * @property {import('../js/model/session.js').default} session - Current session
 * @property {import('../js/model/conversation.js').default} conversation - Current conversation
 * @property {(content: string) => void} [addAssistantMessage] - Add assistant message to LLM context
 * @property {(content: string) => void} [addUserMessage] - Add user message to LLM context
 * @property {(content: string, source?: string) => void} [addSystemReminder] - Add system reminder
 * @property {(toolUseId: string, toolName: string, input: Record<string, unknown>, result: string) => void} [addToolPair] - Add tool-use + tool-result pair
 */

/**
 * Context parameters passed to getContextText() and related methods.
 * @typedef {object} ContextParams
 * @property {number} [contextWindowSize] - Total LLM context window size in tokens
 * @property {{provider: string, model: string}|null} [modelConfig] - Model configuration
 * @property {object} helpers - Formatting helper utilities
 */

/**
 * Result from mergeOrReplace() indicating how to handle duplicate requests.
 * @typedef {object} MergeOrReplaceResult
 * @property {'reuse'|'merge'} action - 'reuse': use existing as-is, 'merge': update existing
 * @property {import('./context-item.js').default} item - The existing item to reuse or merge into
 * @property {Record<string, any>} [mergedParams] - Combined params (only for 'merge' action)
 */

/**
 * Context object for ContextItem constructor.
 * Subclasses receive this and pass it to super(context).
 * @typedef {object} ItemContext
 * @property {string} id - Unique item identifier
 * @property {import('../js/model/session.js').default} session - Current session
 * @property {import('../js/model/conversation.js').default} conversation - Current conversation
 * @property {import('../js/model/message-thread.js').MessageThread} messageThread - Message thread for scoped operations
 * @property {string} [type] - Item type identifier
 * @property {string} [toolUseId] - Tool use ID (for filtering self from items during validation)
 * @property {string} [toolName] - The (resolved) name of the tool being invoked. Set by the framework at every tool-execution construction site so a single class that exposes many tools (e.g. the MCP bridge, whose per-tool args are server-defined and indistinguishable by shape) can route validate/execute/approval to the right tool. Undefined for non-tool instantiations.
 * @property {AbortSignal} [signal] - Abort signal for cooperative cancellation of execute()
 * @property {(event: any) => void} [onProgress] - Progress callback for streaming output
 */

/**
 * Model configuration
 * @typedef {object} ModelConfig
 * @property {string} provider - LLM provider name (e.g., 'anthropic', 'openai')
 * @property {string} model - LLM model name (e.g., 'claude-sonnet-4-20250514')
 */

/**
 * Serialized item structure for JSON storage/transmission.
 * @typedef {object} ItemJSON
 * @property {string} id - Unique item identifier (e.g., 'ITEM_1')
 * @property {string} type - Item type identifier (e.g., 'read-file')
 * @property {Record<string, any>} data - Item-specific data
 */

/**
 * Helpers passed to renderToolActionDetails for building plugin-neutral UI
 * without coupling to the PropertiesPanel component.
 * @typedef {typeof import('../js/utils/properties-panel-helpers.js')} ToolActionRenderHelpers
 */

/**
 * Context object passed to renderToolActionDetails.
 * @typedef {object} ToolActionRenderContext
 * @property {any} toolAction - The Y.Map representing the tool action (has .get())
 * @property {string} toolName - Lowercased tool name
 * @property {Record<string, any>} input - Plain-object snapshot of toolInput
 * @property {ToolActionRenderHelpers} helpers - DOM helpers (addSubsection, addFilePath, addDiffViewer, createCopyableText)
 * @property {import('../js/model/conversation.js').default | null} conversation - Active conversation
 * @property {import('../js/model/message-thread.js').default | null} messageThread - Message thread containing the action
 * @property {import('../js/model/session.js').default | null} session - Session for the conversation
 * @property {string | null} selectedItemId - Selected item id in the panel
 */

/**
 * Context item manifest - static metadata that describes a context item plugin.
 * Define this as a static MANIFEST property on your context item class.
 * @typedef {object} ContextItemManifest
 * @property {string} id - Unique identifier (kebab-case, e.g., 'write-file')
 * @property {string} name - Human-readable display name (e.g., 'Write File')
 * @property {string} version - Semantic version (e.g., '1.0.0')
 * @property {string} description - Brief description of what this item does
 * @property {boolean} [requiresApproval] - Whether user approval is needed before execution (default: false)
 * @property {'gate'|'elicitation'} [interaction] - How this tool's approval suspends: `'gate'` (default) awaits a delegable go/no-go decision; `'elicitation'` awaits non-delegable user input (the resolution IS the answer, so approval automation never resolves it — e.g. AskUserQuestion). See `INTERACTION_KIND`.
 * @property {boolean} [refreshable] - Can update content after creation (default: false)
 * @property {'system'|'prefix'|'none'} [contextPosition] - Where this item's
 *   rendered content is injected into the request (default: 'prefix'):
 *   - `'system'`: folded into the system prompt (cached; busts when it changes).
 *     Memory, skills, the system-prompt identity item.
 *   - `'prefix'` (default): leading user-role messages placed BEFORE the
 *     conversation history, so the content rides inside the cached prefix. An
 *     unchanged render is byte-identical each turn → the cache hits; a genuine
 *     change busts from that point (adding/removing one cold-starts once). For a
 *     deliberately-current file pin (dropped/pinned file contents).
 *   - `'none'`: not injected into the request at all; the item's state already
 *     lives durably in the model's own tool_use/tool_result history (todo, plan).
 *
 *   There is deliberately no trailing/tail position: standing content is either
 *   cacheable (system/prefix) or lives in tool history (none). Genuinely-volatile
 *   per-turn content that changes every turn is an anti-pattern — it would bust
 *   the cache each turn; put such state in a tool result instead. One-shot file
 *   content (an `@`-mention, a read) belongs in the append-only history as a read,
 *   not as a standing context item.
 * @property {boolean} [watchesFileChanges] - React to file modifications (default: false)
 * @property {string} [idPrefix] - **@internal** (outside the engineApi compat promise; used by core, third-party support not guaranteed). Prefix for generated IDs (e.g., 'ITEM', 'RULE'). Defaults to 'ITEM'
 * @property {string} [author] - Author name (e.g., 'Juggler Team')
 * @property {boolean} [delegatesToSubthread] - If true, this item's tool MAY run
 *   as a subthread instead of executing client-side. The flag only advertises
 *   the capability to the worker; the per-call decision is
 *   `buildSubthreadSpec(toolInput, ctx)` — returning a spec delegates, returning
 *   `null` runs the ordinary `execute()`. When the tool delegates, the LLM's
 *   `tool_use` is answered by the child agent run's outcome, whatever it is —
 *   the reply it came to rest on, or the error it stopped on. The child's
 *   working context (large fetches, intermediate tool calls) never enters the
 *   parent. Default: false
 * @property {boolean} [workerManaged] - **@internal** (outside the engineApi compat promise). If true, execution is handled by the Go worker
 *   server-side instead of the engine browser. The plugin still provides
 *   `getToolDefinitions()`, `getStatusUI()`, and `getBadgeOptions()`, but
 *   `execute()` is never called — the worker manages the lifecycle directly.
 *   Use this for items that require server-side orchestration (e.g., thread
 *   creation, external API coordination). Default: `false`
 * @property {string[]} [permissions] - Required permissions (e.g., ['filesystem.read'])
 * @property {Record<string, any>} [exampleData] - Example data object for documentation
 * @property {boolean} [preventUserDeletion] - **@internal** (outside the engineApi compat promise). If true, item cannot be deleted by user
 * @property {boolean} [userAddable] - If true, users can create items of this type via UI
 * @property {string} [syntheticToolName] - **@internal** (outside the engineApi compat promise). Tool name to use in synthetic tool-use/tool-result pairs
 * @property {boolean} [autoInstantiate] - **@internal** (outside the engineApi compat promise). If true, one instance of this type is
 *   seeded onto every new conversation/thread (deduped via mergeOrReplace), so
 *   it is "always present" without the user adding it — e.g. project memory.
 *   A class may additionally gate seeding with a static
 *   `shouldAutoInstantiate()` returning a boolean/Promise (default: seed
 *   unconditionally when true). Default: false
 * @property {string} [itemCategory] - **@internal** (outside the engineApi compat promise). Item category: 'context-item', 'meta', or 'rule'
 */

/**
 * The seed for a delegated subthread, returned by `buildSubthreadSpec`.
 * @typedef {object} SubthreadSpec
 * @property {string} goal - Child thread label / column header.
 * @property {string} prompt - The child's seed user message (task + any inlined data).
 * @property {string} [resultSpec] - Contract for what the child's last message
 *   must contain; appended to the seed and shown in the thread header.
 * @property {string} [sessionName] - Handle for the child, so a later call can
 *   continue it. A name matching a session THIS tool already ran in the calling
 *   thread invokes that child again — the prompt arrives as the next message in
 *   the transcript it already has, with nothing re-seeded or replayed. A name
 *   matching nothing (or none at all) starts a new session, auto-named from the
 *   tool. Every result opens with the name that was used, so a caller that did
 *   not plan ahead can still follow up. Expose it as an optional argument on
 *   your own tool schema and pass it through.
 */

/**
 * Context passed to `buildSubthreadSpec`. Runs in the browser (engine), after
 * `validate()`.
 * @typedef {object} SubthreadBuildContext
 * @property {any} conversation - The conversation the tool was called in.
 * @property {any} session - The owning session.
 * @property {AbortSignal} [signal] - Abort signal for any local pre-work.
 */

/**
 * Context passed to the static `onTurnEnd(ctx)` hook. Runs in the engine (no
 * DOM), once per completed turn when the root conversation goes idle.
 * @typedef {object} TurnEndContext
 * @property {any} conversation - The conversation that just went idle. Use
 *   `conversation.id` as the stable anchor for external per-conversation state.
 * @property {any} messageThread - The root message thread — the transcript to
 *   read/distil (the same object a strategy hook sees as `this.messageThread`).
 * @property {any} session - The owning session, for durable `getMetadata` /
 *   `patchMetadata` state.
 * @property {number} turnIndex - The completed-turn counter for this idle
 *   transition, so a hook can process only what is new since its last run.
 * @property {AbortSignal} [signal] - Aborts when a later turn's hook supersedes
 *   this run; forward it to async work so a slow run bails out.
 */

// no runtime exports; file is imported for typedefs only
export default {};
