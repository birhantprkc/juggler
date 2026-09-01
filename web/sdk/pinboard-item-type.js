//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Pinboard-item manifest — static metadata that describes a pinboard-item plugin.
 * Define this as a static MANIFEST property on your item class.
 * @typedef {object} PinboardItemManifest
 * @property {string} id - Unique item-type identifier (kebab-case, e.g. 'file')
 * @property {string} name - Human-readable display name (shown in the catalog and the add picker)
 * @property {string} version - Semantic version (e.g. '1.0.0')
 * @property {string} description - Help text shown in the extensions catalog and the add picker
 * @property {'single'|'multiple'} [instances] - Whether the board may hold more than
 *   one pin of this type. 'single' (the default) makes the type a singleton: the host
 *   reveals the existing pin instead of adding a second.
 * @property {string} [addLabel] - What the add picker calls this type, where that
 *   differs from its name — for one that opens a chooser rather than adding on the
 *   spot, e.g. 'Select a file to pin…'. Defaults to `name`.
 * @property {number} [order] - Add-picker sort key, ascending, default 0; ties keep
 *   registration order. Ask for a lower one only where the type earns the top of a
 *   list every user reads.
 * @property {boolean} [addable] - Whether the type appears in the add picker at all.
 *   Defaults to true; set false for a type only ever pinned from a source.
 */

/**
 * A source descriptor — a thing elsewhere in the UI that the user asked to pin,
 * passed to `canPinSource`/`configFromSource` so a properties panel never has to
 * name a concrete pin class.
 * @typedef {object} PinSource
 * @property {string} kind - Source kind, e.g. 'file'
 * @property {string} [path] - Absolute path, for `kind: 'file'`
 * @property {'live'|'snapshot'} [presentation] - Whether the pin tracks the source
 *   or freezes what it said at pin time
 */

/**
 * The active context a pin is rendered against. Supplied by the host and treated
 * as immutable — it is a snapshot, not a live view, and a new one arrives through
 * `update()` whenever the active conversation or project changes.
 * @typedef {object} PinActiveContext
 * @property {{path: string, displayName: string}} project - The open project: its
 *   root path, and the last segment of that path as a name to show. Both are empty
 *   strings when no project is open.
 * @property {{id: string, title: string}|null} conversation - Active conversation, if any
 * @property {{id: string|null}|null} thread - The thread the viewer is looking at,
 *   or null when no conversation is open. A conversation's root thread has no id of
 *   its own, so `id` is null there; a sub-thread carries its thread item's id.
 */

/**
 * One file the host was told about while a pin was watching.
 * @typedef {object} PinFileChange
 * @property {string} path - Absolute path of the file that changed
 * @property {'write'|'create'|'remove'|'rename'} event - What happened to it
 */

/**
 * Notification that files on disk changed, for a pin showing one of them. Only
 * files inside the open project are reported, and hidden files are not: the
 * watcher is rooted at the project and skips dot-files. A pin on anything else
 * will hear nothing, so offer the user a way to re-read rather than trusting this
 * to be complete — and never poll for what it does not tell you.
 * @typedef {object} PinFilesService
 * @property {(listener: (changes: PinFileChange[]) => void) => (() => void)} onChange -
 *   Watch for file changes. Returns an unsubscribe function; the host also drops
 *   the subscription when the pin is torn down, so forgetting it leaks nothing.
 */

/**
 * Which thread a context item was found on.
 * @typedef {object} PinContextItemSource
 * @property {string|null} threadId - The thread that owns the item. Null for the
 *   conversation's root thread, which has no thread item of its own.
 * @property {string} label - That thread's name, the same one its column header
 *   shows. Empty when the thread was never given a goal.
 * @property {boolean} inherited - True when the item came from an ancestor of the
 *   focused thread rather than the focused thread itself. Say so if you show it:
 *   a plan belonging to a thread the user is not in is not the same claim as one
 *   belonging to the thread they are.
 * @property {string|null} itemId - The transcript row that stands for the item,
 *   to hand to `reveal`. An item that draws no tile of its own — a plan, a todo
 *   list — is represented in the column by the tool-action row that wrote it, and
 *   this is that row. Null when the item has no row, in which case `reveal` can
 *   only point at the thread.
 */

/**
 * A context item as the board sees it: a copy of what it holds, and where it was
 * found. It is a snapshot, not a handle — mutating `data` changes nothing, and
 * the next call returns fresh values.
 * @typedef {object} PinContextItemSnapshot
 * @property {string} id - The context item's id
 * @property {string} type - Its item-type id, e.g. 'plan'
 * @property {Record<string, any>} data - A deep copy of its stored data
 * @property {PinContextItemSource} source - The thread it came from
 */

/**
 * The context items of the conversation being read. A pin is a view of a
 * conversation it does not own, so this hands out copies and never the model.
 *
 * `find` resolves like the columns do: the thread the user is looking at first,
 * then its ancestors, nearest first, ending at the root. That is why the result
 * carries its source — a Plan pin showing a parent thread's plan is telling the
 * truth only if it says whose plan it is.
 * @typedef {object} PinContextItemsService
 * @property {(type: string, from?: string|null) => PinContextItemSnapshot|null} find -
 *   The nearest context item of that type, or null when neither the starting
 *   thread nor any ancestor has one. The walk starts at the thread being read;
 *   pass `from` to start it somewhere else instead — a thread id, or null for
 *   the conversation root — which is how a pin watches one thread rather than
 *   following the reader. Same resolution either way, so the source it reports
 *   is still whichever thread in that chain actually owns the item.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   items may have changed, or when the focused thread moved. Carries nothing:
 *   call `find` again. Returns an unsubscribe function; the host also drops the
 *   subscription when the pin is torn down.
 * @property {(threadId: string|null, itemId?: string|null) => void} reveal - Point
 *   the conversation at what the pin is showing. Pass the source's `itemId` and
 *   the row itself is selected, wherever in the chain it lives; pass only a
 *   thread id — null meaning the root — and its column is brought into view
 *   instead. Prefer the row: making the root column active is no movement at all
 *   for a reader who is already there, which is most of them. The reveal happens
 *   wherever the columns are: from a board detached into its own window it is
 *   carried out in the window that opened it, which then brings itself forward.
 *   Best-effort and one-way — there is no window to point at once the one that
 *   owns the board has gone.
 */

/**
 * One file in a repository's working tree. `index` and `worktree` are git's own
 * status letters — 'M', 'A', 'D', 'R', '?' — where '.' means that side is
 * unmodified, so a file staged and then edited again reads 'M'/'M'.
 * @typedef {object} PinGitFile
 * @property {string} path - Path relative to its repository, forward-slashed
 * @property {string} index - Staged status letter, '.' when unmodified
 * @property {string} worktree - Working-tree status letter, '?' for untracked
 */

/**
 * One repository under the open project.
 * @typedef {object} PinGitRepo
 * @property {string} path - Location relative to the project root, '' for the root repo
 * @property {number} changed - Files with working-tree changes, untracked included
 * @property {number} staged - Files with staged changes
 * @property {number} total - Files git reported, listed in `files` or not. Not
 *   `changed + staged`: a file staged and then edited again is one file on both sides.
 * @property {string} branch - Current branch, '' on a detached head
 * @property {string} upstream - Tracking branch, '' when it has none
 * @property {number} ahead - Commits this branch has that its upstream does not
 * @property {number} behind - Commits its upstream has that this branch does not
 * @property {boolean} detached - Whether HEAD is on a commit rather than a branch
 * @property {PinGitFile[]} files - The changed files, bounded by the host
 * @property {boolean} truncated - True when the tree holds more files than `files` lists.
 *   The counts still describe the whole tree, so say "200 of 4000" rather than "200".
 */

/**
 * The working-tree state of every repository under the project — the root repo
 * and any nested repos or submodules, in a stable order.
 * @typedef {object} PinGitStatus
 * @property {string} root - Absolute project root path
 * @property {PinGitRepo[]} repos - Every repo found, empty when the project has no git
 */

/**
 * The project's git working tree.
 *
 * This is a **poll, not a watch**. Nothing under `.git` is ever reported by the
 * file watcher — it skips dot-directories before it starts watching — so there is
 * no event to subscribe to and the host asks git on a timer, and only while the
 * window is focused. `onChange` therefore tells you a fresh answer arrived, not
 * that the repository changed at the moment it did. Offer the user a way to ask
 * again rather than implying the display is live, and never poll yourself: every
 * surface shares one poll, and a second one would run git twice.
 * @typedef {object} PinGitService
 * @property {() => PinGitStatus|null} status - The latest status, or null when
 *   nothing has been read yet. Null is not "no repositories": say you are still
 *   looking rather than claiming the project has no git.
 * @property {() => string} error - The last read's failure, or ''. The previous
 *   status is kept beside it, because a transient failure should not blank a
 *   working display — show both.
 * @property {(listener: () => void) => (() => void)} onChange - Called when a new
 *   status has arrived. Carries nothing: call `status()`. Returns an unsubscribe
 *   function; the host also drops the subscription when the pin is torn down.
 * @property {() => Promise<void>} refresh - Ask git now. Never rejects: a failure
 *   shows up on `error()`.
 */

/**
 * One file edit the conversation's transcript records.
 * @typedef {object} PinFileEdit
 * @property {string} itemId - The tool action that made it, for `reveal`
 * @property {string|null} threadId - The thread it happened in, null for the root
 * @property {string} toolName - Which tool, as named in the query
 * @property {string} path - Absolute path of the file it changed
 * @property {number} added - Lines added, 0 when the tool did not report a diffstat
 * @property {number} removed - Lines removed, 0 when unreported
 * @property {number} at - Unix ms it was stamped, `Infinity` for one so new the
 *   worker has not echoed it back yet
 */

/**
 * What this conversation's tools have done to files, read from the transcript
 * rather than from a ledger kept beside it. Nothing here is inferred: an edit
 * appears because a tool action for it completed successfully, so the list is
 * exactly as durable as the conversation and survives a restart with it.
 *
 * **It is not the list of files that changed.** It is the list of files these
 * tools changed. A shell command, another editor, a checkout — none of them are
 * here and none of them can be, because nothing attributes a bare filesystem
 * write to anyone. Say which of the two you are showing; a surface that lets the
 * user read this as "everything that changed" is lying by omission. For what did
 * change, whoever changed it, use `services.git`.
 * @typedef {object} PinFileEditsService
 * @property {(query: {tools: string[], limit?: number}) => PinFileEdit[]} list -
 *   The edits made by the named tools, newest first, capped at `limit` (200 by
 *   default). You supply the tool names: which tools mutate a file is your
 *   knowledge, not the host's.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   transcript may have changed. Carries nothing: call `list` again. Returns an
 *   unsubscribe function; the host also drops the subscription on teardown.
 * @property {(itemId: string) => void} reveal - Select that tool action in the
 *   conversation, opening whatever columns it takes to reach it. Like every
 *   reveal, it happens in the window that has the columns — a detached board's
 *   goes back to the window that opened it.
 */

/**
 * One background task this conversation started and that is still running.
 * @typedef {object} PinTask
 * @property {string} taskId - The task's id, as `stop` takes it
 * @property {string} itemId - The tool action that started it, for `reveal`
 * @property {string|null} threadId - The thread it was started in, null for the root
 * @property {string} toolName - The tool that started it, as the transcript names it
 * @property {string} command - The command line it is running. Unbounded — it is
 *   whatever was typed — so give it a bounded space rather than trusting it to be short.
 * @property {string} label - What it was started for, when the tool was asked to
 *   say. Empty otherwise.
 * @property {number} at - Unix ms it was started, `Infinity` for one so new the
 *   worker has not echoed it back yet
 */

/**
 * The background tasks this conversation has running: `bash` with
 * `run_in_background`, and `Monitor`.
 *
 * **A live inventory, not a history.** A task leaves the list the moment it ends,
 * however it ended. That is the whole retention policy, and it is deliberate: the
 * transcript is where a task's history lives, so a task that failed is gone from
 * here and still says so — with its output, its exit code and its approval — on
 * the tool action that started it. Which is what `reveal` is for.
 *
 * It is built from two halves because neither is enough alone. The transcript
 * says which tasks were started and can never say which are still running: the
 * durable snapshot beside a tool action freezes at whatever it last said, so
 * after a restart it claims `running` forever. The server knows what is running
 * and is asked only about ids the transcript already named. One consequence is
 * worth relying on: nothing survives a server restart, and the list says so by
 * being empty rather than by explaining itself.
 *
 * It is also the narrowest thing that could work, on purpose. There is no way to
 * ask what tasks exist — not in this conversation, not in another one, not in the
 * process — so a surface built on this can only ever show tasks the conversation
 * in front of the user started.
 * @typedef {object} PinTasksService
 * @property {() => PinTask[]|null} list - The tasks running as of the last check,
 *   newest first, or null when none has come back yet. Null is not an empty list:
 *   say you are still looking rather than claiming nothing is running.
 * @property {() => string} error - The last check's failure, or ''. The previous
 *   list is kept beside it, because a transient failure should not empty a
 *   working display — show both.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   list may have changed. Carries nothing: call `list`. Returns an unsubscribe
 *   function; the host also drops the subscription on teardown. The check runs
 *   only while something is watching, so a board nobody has open asks nothing.
 * @property {(itemId: string) => void} reveal - Select the tool action that
 *   started the task, opening whatever columns it takes to reach it. Like every
 *   reveal, it happens in the window that has the columns — a detached board's
 *   goes back to the window that opened it.
 * @property {(taskId: string) => Promise<void>} stop - Stop a running task.
 *   Rejects if it could not be asked to stop, so show what came back. The host
 *   picks how — a `Monitor`'s task and a plain one are stopped by different means
 *   — and you do not need to know which.
 */

/**
 * Host services, for data the active-context snapshot does not carry. Each is
 * read-only and cancellable: a pin is a view, so it never gets a mutable handle
 * on model state, and it asks the host rather than reaching into it.
 *
 * `tasks.stop` is the one exception to read-only, and a narrow one: it acts on a
 * process rather than on any model state, at the user's request, on a surface the
 * conversation already offers a Stop button for. It is not a precedent for a
 * service that writes.
 *
 * Services are added one at a time, as the provider that needs one lands. Write
 * against what is here rather than what you expect to be.
 * @typedef {object} PinServices
 * @property {PinFilesService} files - Files changing on disk
 * @property {PinContextItemsService} contextItems - The conversation's context items
 * @property {PinGitService} git - The project's git working tree
 * @property {PinFileEditsService} fileEdits - What this conversation's tools changed
 * @property {PinTasksService} tasks - The background tasks this conversation is running
 */

/**
 * Everything `mount()` and `update()` receive.
 * @typedef {object} PinContext
 * @property {{id: string, type: string, config: Record<string, any>}} pin - This pin instance
 * @property {PinActiveContext} active - Immutable active-context snapshot
 * @property {PinServices} services - Read-only host services
 * @property {AbortSignal} signal - Aborted when the pin is torn down; every fetch must honour it
 * @property {(nextConfig: Record<string, any>) => Promise<void>} updateConfig - Persist new config for this pin
 */

/**
 * What the host shows in the item toolbar above the provider body. Returned from
 * `describe()`, so the host owns the chrome and the provider owns only the words.
 * @typedef {object} PinDescription
 * @property {string} title - Short tab label and toolbar title, e.g. 'main.go'
 * @property {string} [subtitle] - Secondary line, e.g. the containing directory
 * @property {string} [path] - The absolute path this pin is showing. The toolbar
 *   then names the file rather than the pin: it shows the path in place of the
 *   title, and offers the same open/copy/reveal controls a path gets anywhere
 *   else in the app, so a pin need not supply those actions itself. `title` is
 *   still what the tab says, because a full path across a tab strip is unreadable.
 * @property {string} [badge] - Compact status shown on the tab, e.g. '3/5'. Not a second title.
 */

/**
 * One thing the user can do to the active pin, offered in the item toolbar the
 * host draws above the body. The provider supplies the words and the behaviour;
 * where the control goes, and what it looks like, is the host's business.
 * @typedef {object} PinAction
 * @property {string} id - Stable identifier, for the host to tell actions apart
 * @property {string} label - What the control says, e.g. 'Open'. Literal, not a sentence.
 * @property {boolean} [primary] - Put it in the toolbar as a button of its own.
 *   Everything else goes in the overflow menu, which is where most actions belong:
 *   a toolbar of five buttons is a toolbar nobody reads.
 * @property {string} [icon] - Draw it as a glyph the host knows by this name,
 *   rather than as its label. Currently only `'refresh'`. An icon action is always
 *   a button of its own and never joins the overflow menu, where a picture has
 *   nothing to say; a name the host does not know falls back to the label.
 * @property {boolean} [disabled] - Show it, greyed, rather than hiding it. Prefer
 *   this to omitting an action that is temporarily unavailable — a control that
 *   comes and goes is harder to find than one that is briefly dim.
 * @property {() => void|Promise<void>} run - Do the thing. Anything thrown, or a
 *   rejected promise, is reported in the board's status line with the error text intact.
 */

/**
 * The object `mount()` may return instead of a bare teardown function, letting a
 * pin survive an active-context change rather than being torn down and rebuilt.
 * @typedef {object} PinController
 * @property {(next: PinContext) => void} [update] - Apply a new context snapshot in place
 * @property {() => void} [teardown] - Stop timers and listeners
 * @property {() => void} [focus] - Move focus into the body, when the host reveals this pin
 * @property {() => PinAction[]} [getActions] - The actions the item toolbar offers for
 *   this pin. The host asks after `mount()` and after every `update()`, and at no
 *   other time — there is no channel for announcing that your actions changed, so
 *   return the same set each call and use `disabled` for one that cannot run yet.
 *   Omit this entirely and the toolbar shows title and subtitle alone.
 */

// ============================================================================
// PinboardItemType Base Class
// ============================================================================

/**
 * PinboardItemType — base class for Juggler "pinboard item" plugins.
 *
 * The pinboard is the tabbed workspace behind the right edge of the window. Each
 * tab is one *pin*: a configured instance of an item type, kept in server-backed
 * session state so every viewer of the project sees the same board. An item type
 * supplies the body of its tab; the host owns the tabs, the toolbar, drag, remove,
 * loading and error shells.
 *
 * Pinboard items are **viewer-only** — they touch the DOM and never run in the
 * engine worker, so like info cards (and unlike strategy/context-item/command)
 * there is no `-worker.js` twin of this base class.
 *
 * ## Item type versus info card versus context item
 *
 * - An **info card** is an ambient tile the sidebar may *drop* when it runs out of
 *   room. A pin is guaranteed workspace the user asked for by name.
 * - A **context item** belongs to a conversation and is visible to the model. A pin
 *   is a view: pinning a file shows it, it does not put it in anyone's context.
 *
 * ## Creating an item type
 *
 * Item types ship inside an **extension** (a directory with a
 * `juggler.extension.json` manifest). Add a file named `*-pin.js` under the
 * extension's `pins/` directory — the manifest's `provides.pinboardItems` glob
 * registers it automatically.
 *
 * 1. Import and extend PinboardItemType: `import PinboardItemType from 'juggler/pinboard-item-type';`
 * 2. Define a static MANIFEST with the required fields (id, name, version, description).
 * 3. Implement `mount(container, pinContext)`; optionally override `describe()`,
 *    `canAdd()`, `normalizeConfig()`, and `configure()`.
 *
 * ```javascript
 * import PinboardItemType from 'juggler/pinboard-item-type';
 *
 * export default class ClockPin extends PinboardItemType {
 *   static MANIFEST = {
 *     id: 'clock',
 *     name: 'Clock',
 *     version: '1.0.0',
 *     description: 'Shows the time, which is rarely what you wanted to know',
 *   };
 *
 *   mount(container, { signal }) {
 *     const tick = () => { container.textContent = new Date().toLocaleTimeString(); };
 *     tick();
 *     const timer = setInterval(tick, 1000);
 *     signal.addEventListener('abort', () => clearInterval(timer));
 *     return () => clearInterval(timer);
 *   }
 * }
 * ```
 *
 * ## State rules
 *
 * Config is the only thing that persists, so keep it small, JSON-serializable, and
 * meaningful without the machine that produced it: a path, not file bytes. The
 * board state is shared and long-lived, and it outlives your class — a pin whose
 * extension has been disabled keeps its config until the user removes it.
 *
 * Hold no authoritative state in the DOM or on the instance: one instance serves
 * every pin of its type, mount and teardown happen for reasons you do not control
 * (a project switch, a hot reload, the user switching tabs), and the same board is
 * open in windows you cannot see.
 * @class
 * @abstract
 */
class PinboardItemType {
  /**
   * Pinboard-item manifest (static property set by subclasses).
   * @type {PinboardItemManifest}
   * @static
   */
  static MANIFEST;

  constructor() {
    if (new.target === PinboardItemType) {
      throw new Error('PinboardItemType is an abstract class and cannot be instantiated directly');
    }
  }

  /** @returns {PinboardItemManifest} This item type's manifest. */
  getManifest() {
    return /** @type {typeof PinboardItemType} */ (this.constructor).MANIFEST;
  }

  /** @returns {string} The item-type id (from MANIFEST). */
  get id() {
    return this.getManifest().id;
  }

  /** @returns {string} The item-type display name (from MANIFEST). */
  get name() {
    return this.getManifest().name;
  }

  /** @returns {boolean} True when the board may hold more than one pin of this type. */
  get allowsMultiple() {
    return this.getManifest().instances === 'multiple';
  }

  /**
   * Whether a new pin of this type can be added right now. Return a string to say
   * why not — the add picker shows it, which is far better than the entry silently
   * vanishing ('No project', 'No active conversation'). Defaults to always addable.
   * @param {PinActiveContext} active - The current active-context snapshot.
   * @returns {true|string} True to allow, or the reason it is unavailable.
   */
  canAdd(active) {
    void active;
    return true;
  }

  /**
   * Collect the config for a new pin. Override for a type that needs to ask the
   * user something first (File asks which file). Return null to abandon the add —
   * a cancelled picker is not an error. Defaults to an empty config.
   * @param {{active: PinActiveContext, initialConfig?: Record<string, any>, signal: AbortSignal}} options - Configuration request.
   * @returns {Promise<Record<string, any>|null>} The new config, or null if cancelled.
   */
  async configure(options) {
    return options.initialConfig ?? {};
  }

  /**
   * Validate and normalize a config before it is stored or rendered. This runs on
   * config that has been sitting in session state since a previous version of your
   * extension, so treat every field as untrusted and migrate rather than throw.
   * Return null to reject the config outright — the host keeps the pin but shows it
   * as unusable rather than mounting against nonsense.
   * @param {Record<string, any>} config - The stored or supplied config.
   * @returns {Record<string, any>|null} The normalized config, or null to reject it.
   */
  normalizeConfig(config) {
    return config;
  }

  /**
   * Whether two configs name the same thing, so the host can reveal the existing
   * pin instead of adding a duplicate. Both configs are already normalized.
   * Defaults to a shallow JSON comparison.
   * @param {Record<string, any>} a - One config.
   * @param {Record<string, any>} b - The other config.
   * @returns {boolean} True when the two configs describe the same pin.
   */
  isSameConfig(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Cheap title/subtitle/badge for the tab and item toolbar. Called often, including
   * while the board is being laid out, so it must not do work — read the config, not
   * the filesystem. Defaults to the manifest name.
   * @param {Record<string, any>} config - The pin's normalized config.
   * @param {PinActiveContext} active - The current active-context snapshot.
   * @returns {PinDescription} What the host chrome should say.
   */
  describe(config, active) {
    void config;
    void active;
    return { title: this.name };
  }

  /**
   * Whether this type can pin the given source. Static, because the host asks
   * before any instance exists — a properties panel says "pin this file" and the
   * registry finds the type that can, rather than the panel naming a class.
   * @param {PinSource} source - The source the user asked to pin.
   * @returns {boolean} True if `configFromSource` will accept it.
   */
  static canPinSource(source) {
    void source;
    return false;
  }

  /**
   * Turn a source descriptor into a config for a new pin. Only called when
   * `canPinSource` accepted it.
   * @param {PinSource} source - The source the user asked to pin.
   * @returns {Record<string, any>|null} The config, or null if it cannot be pinned after all.
   */
  static configFromSource(source) {
    void source;
    return null;
  }

  /**
   * Fill the pin's body. The host has already drawn the tab and toolbar; this owns
   * only the region below them.
   *
   * Return a teardown function, or a controller with `update()` so a change of
   * active conversation re-renders in place instead of rebuilding the pin, and
   * `getActions()` to put controls in the toolbar the host draws above you.
   * Anything thrown here is caught by the host and shown in the pin's place, so let
   * a real failure throw rather than rendering your own apology.
   * @abstract
   * @param {HTMLElement} container - The body region to populate.
   * @param {PinContext} pinContext - The pin, its config, and the active context.
   * @returns {PinController|(() => void)|void} Optional teardown or controller.
   */
  mount(container, pinContext) {
    void container;
    void pinContext;
    throw new Error('mount() must be implemented by subclass');
  }
}

export default PinboardItemType;
