# Changelog

All notable changes to Juggler are recorded here. Each release is a tight list
of changes; this project follows semantic versioning.

## [Unreleased]

- llama.cpp models report the context window the server really serves, multi-model setups included
- The busy spinner juggles a club per parallel tool call, at the speed the work is moving
- The spinner tires gradually through a long tool call, and picks up when the next one starts
- New settings stop tabs highlighting, or floating to the top, when a conversation wants you

## [0.5.6] - 2026-08-14

- The Escape key's behaviour is now a setting: stop, pause, two-step, press-twice, or clear only
- Hidden conversation tabs release their transcript DOM, preventing memory growth in large projects
- Tool-use grouping now has a keyboard shortcut (⌥⌘G / Ctrl+Alt+G)
- Window titles show the project's directory name, which survives taskbar and menu truncation
- Linux windows now carry their project name in the taskbar and window switcher instead of all reading "Juggler"
- Codex ChatGPT-plan requests send a session_id header, eliminating random prompt-cache misses
- Cache token stats distinguish provider-reported zero from not-reported (shown as unknown)
- Deleting or rewinding past several items offers an Undo in that column's footer
- Span deletes now cancel a running turn and undo as a single step, not several
- Auto-approve now says why it left a tool call parked for you, and no longer gives up when a turn parks several tool calls at once
- Auto-approve is told which permissions you already granted, so it stops re-asking about work you sanctioned
- An overloaded provider is reported in minutes instead of hanging forever, and the spinner admits it is retrying
- A Claude model that botches a tool call now retries it instead of ending the conversation without explanation

## [0.5.5] - 2026-08-11

- Added a togglable mode that collapses runs of consecutive tool uses into group items
- Alt+N starts a new conversation, a key browsers leave alone unlike Ctrl+N
- PDF files render page-by-page in the properties panel, and their text is read by the model
- Extensions can add file viewers, teaching Juggler to display and read new file formats
- Images stream from disk instead of round-tripping through the conversation, keeping documents smaller
- Binary files no viewer can display now explain themselves instead of a fixed warning
- Duplicating a conversation no longer hijacks its running monitors, so output stays with the original
- Clicking an item's badge in the properties panel opens the extension that provides it in Settings
- Tab auto-naming retries an overloaded model instead of silently leaving "Untitled", and says so if it gives up
- Various fixes and improvements to the compaction invocation and feedback while summarising

## [0.5.4] - 2026-08-08

- Added a create-new-conversation tool that LLMs can use to create new tabs with prompts. You might use this to get the agent to fan out tasks, or to hand over to a fresh tab
- Added an optional Exa.ai extension (an agent-oriented web search tool)
- Extensions can make authenticated server-side HTTP requests through the host operations API
- Headless Linux servers can run the Node engine without an X or Wayland session
- Claude Code usage stats load in projects awaiting workspace trust
- Claude Code flashes a warning when a large conversation misses its context cache
- Handing off a conversation auto-names the continued tab from its summary, leaving tabs you named alone
- Fixed focus stranding after answering an approval or question, so you can type straight away

## [0.5.3] - 2026-08-06

- Oversized shell output now spills the full log to a readable file instead of dropping the middle
- Typing '$' allows the user to pick a skill to manually inject into the conversation
- A warning is shown when your next message will cause a context cache miss (strategy switch, edited or deleted history)
- Automatic compaction can now be turned off in Settings, keeping full transcripts until the context limit is hit
- Edit and write tools refuse files never read this session or changed on disk since reading
- Reading an image file now shows it to multimodal models instead of a binary-file warning
- MCP servers can now hide individual tools via per-server allow/deny lists, editable as checkboxes in Settings
- MCP servers can fix default arguments that are merged into every call and hidden from the model
- Claude Code usage polls no longer load user-level plugins or hooks, so unrelated tools don't fire on every quota refresh
- Context-item extensions can implement `static onTurnEnd()` to run a side-effect (e.g. retain a memory) once per turn
- Fixed an auto-instantiate context item that implements `execute()` failing to seed, so its standing context reached the prompt
- Fixed YOLO auto-approving plan submissions — plans now still wait for your review before execution begins
- @-mention filename completion searches the whole project for dashed and short queries

## [0.5.2] - 2026-08-01

- File search tools (grep, glob, tree) now respect nested .gitignore files, with a per-conversation toggle to search everything
- Added a todo checklist tool for frictionless progress tracking; plan is now reserved for approval-gated proposals
- Large pastes collapse to inline expandable placeholders in the composer
- Info cards (Tips, Usage, Git status) are now extension plugins, toggled in the Extensions catalog and re-shown from a new sidebar menu
- Fixed compaction piling up summary threads
- Fixed compaction requests duplicating large edit snapshots and missing prompt caches
- More reliable tool-command delivery via a simpler level-based re-drive

## [0.5.1] - 2026-07-29

- Reading files with very long lines (e.g. one-paragraph-per-line Markdown) no longer truncates mid-character or too eagerly
- Editing a long prose paragraph no longer gets bounced to the write tool
- Added proxy support — uses your system/env proxy by default, with a manual override in Settings → Network
- Fixed the Claude Code CLI re-opening its login page in the background when it wasn't the active provider
- Fixed YOLO auto-approving AskUserQuestion — questions now still wait for your answer
- Fixed various UI niggles, including some mobile layout problems
- Fixed some more multi-line bash parsing edge-cases

## [0.5.0] - 2026-07-26

- Added an 'auto-approve' strategy that uses a cheap model to approve any obviously safe commands that would otherwise have needed user approval
- New conversations now name their own tab from your first message
- Added a "cheap model" setting — a small, fast model for background micro-tasks like tab naming
- Plugins can now request short out-of-band model completions via a generateText op
- Added Mistral AI provider, with vision models and Magistral reasoning levels
- Added OpenCode Zen provider — a multi-model gateway (Claude, GPT, Gemini, DeepSeek, and more)
- Some minor fixes for thinking mode names, a few UI issues, light/dark mode on linux
- Handling for bash commands with newlines inside string literals
- "Don't ask again" approval patterns can now be edited in place before saving
- New Thread no longer interrupts an active agent turn
- Font size and theme are now remembered per project; a new empty window inherits the size and theme of the window you opened it from
- Recent models are promoted only after sending a message with them
- Added an option to default new conversations to have file editing allowed

## [0.4.5] - 2026-07-24

- Added Cmd+/ and Ctrl+/ shortcut to show keyboard shortcuts
- Fixed ⌥⌘M / ⌥⌘T being lost when focus was outside the composer
- Fixed the model cycler doing nothing on the first use after a page load
- Had a rehash of the buttons in the user message box, to make their layout more balanced and stable at different sizes
- Added a sidebar card showing active provider quota usage
- Added a flag for providers which can't handle the forced tool option, which was breaking auto-compaction
- Made the theme selector tri-state: light/dark/system

## [0.4.4] - 2026-07-23

- Sub-threads can no longer spawn their own subthreads (threads you create with /thread still can)
- GitHub Copilot now works with GitHub Enterprise Cloud (*.ghe.com): reuses your editor login and can sign in to your tenant
- New shortcuts: ⌥⌘M / Ctrl+Alt+M cycles recent models, ⌥⌘T / Ctrl+Alt+T cycles thinking level (hold opens the menu)
- Model and thinking menus now stay stable and readable while selecting levels
- Fix for some token count estimation errors that would make the auto-compact kick in much too soon
- Added GLM5.2 1m token option

## [0.4.3] - 2026-07-21

- User messages now render Markdown you typed or pasted (links, formatting, code) instead of raw source
- Connectivity settings now let you start LAN access or a WAN tunnel automatically on launch
- Local and keyless OpenAI-compatible providers now work without an API key
- Subthreads now show how they were set up (system prompt, memory, skills)
- Long conversations no longer crash when they outgrow the model's limit — Juggler trims old history and retries automatically
- Juggler now respects each model's real context and output limits (including Ollama's actual window), so it won't fire off requests that are doomed to fail
- /compact and /handoff now cope with even very large conversations
- Fixed Claude Code sessions getting stuck in plan mode when other Claude CLI sessions were open in the same folder
- Added an F2 key shortcut for renaming the current tab (also pressing return when the tab panel has keyboard focus will rename the tab)
- Fixed double-insertion of agent.md files if there are synlinks involved
- Fallback for some image-pasting pasting in desktop app when the clipboard is async

## [0.4.2] - 2026-07-18

- Added moonshot/KIMI, Copilot and llama.cpp providers, refactored and fixed other providers like ollama, codex
- Made it possible to disable auto-update
- Fixes for some MCP and extension loading bugs
- Fixed a bug where changing the project folder would leave a stale folder in the javascript that the explore_code uses

## [0.4.1] - 2026-07-17

- Added a Skills marketplace to discover and install Agent Skills from GitHub registries
- Made lots of fixes/improvements to skill handling and the skill-related items in a conversation
- Bin now shows its on-disk size on the Bin button and Empty-Bin action
- Write approvals now enforce project-path containment on all platforms
- Writes outside the project folder always prompt, with a clear warning
- Pre-approval write validation no longer creates directories or files
- Windows absolute paths now display correctly in approval dialogs

## [0.4.0] - 2026-07-16

- Added per-model thinking-level control to the model chooser
- Added Agent Skills: discovery across native roots, plus a skill tool to load them on demand
- Added ACP client support
- Added workarounds for some Firefox bugs when using the WAN client
- Fixed failure to save settings in the generic openAI provider
- Made sure .md files are previewed as markdown, not syntax-highlighted text
- Followed XDG Base Directory spec for config/cache on Linux

## [0.3.8] - 2026-07-15

- Added a generic openAI provider which can use any URL
- Made the provider connection timeout customisable
- Attached images now render again instead of showing as broken links
- Fix for deepseek thinking, and Ollama
- Headless Linux servers now auto-relaunch under xvfb-run when no display exists
- Linux no-display errors now give exact, distro-specific install commands
- On headless linux servers without GTK, it will now fall back to using node/bun as its javascript engine

## [0.3.7] - 2026-07-14

- Recovered locked project sessions safely and explained unrecoverable lock conflicts.
- Added Pause (shift+Escape / footer button): stop the LLM loop as soon as possible without cancelling in-flight operation.

## [0.3.6] - 2026-07-13

- Assistant replies now support Markdown, HTML, and mixed Markdown/HTML content, including declarative inline SVG
- Added a /handoff command which summarises the current conversation into a new tab
- Added auto-update for Windows

## [0.3.5] - 2026-07-12

- Added ability for extension items to spawn a subthread, and used this to make the webfetch tool run sub-prompts to filter its results
- Injecting queued user messages now pushes them into the thread sooner
- Added alt+up/down shortcuts to skip between user messages in the thread

## [0.3.4] - 2026-07-11

- Added user-defined slash commands with a UI editor and sub-thread execution
- Made juggler able to explain how to use itself
- Clear per-OS error with fix-it steps when no display or webview runtime is available, instead of a silent exit.
- Fixed some UTF16 handling issues
- Reviewed and updated some command-line args

## [0.3.3] - 2026-07-11

- Fixed a MIME type error that could mess things up on Windows under some circumstances

## [0.3.2] - 2026-07-11

- Improved model shortlist sorting and filtering
- Improved the notification chime settings

## [0.3.1] - 2026-07-10

- Added GPT5.6 support
- Used the saved theme hint earlier to avoid startup background flashes.

## [0.3.0] - 2026-07-10

- Made the model chooser list able to hide some providers
- Added ⌘F find-in-conversation with a floating search bar and match navigation

## [0.2.3] - 2026-07-10

- Linux desktop window now uses the app's own title bar with custom caption buttons, matching macOS/Windows.
- Fixed Finder/Dock-launched app inheriting a stripped PATH, so the bash tool now sees the user's full shell PATH.
- Improved Codex sign-in diagnostics with checked auth-file paths.
- Fixed file context-item titles showing the full path on Windows instead of just the filename.

## [0.2.2] - 2026-07-07

- Added MCP server support: stdio tools surface as context items with live status and approval.
- Added a Git status info card summarising changed/staged files per repo.
- Show other connected clients (count in header; origin and connect time in connectivity settings).
- @-mention completion now finds deeply nested files instantly via a whole-tree path index.

## [0.2.1] - 2026-07-06

- Misc UI improvements, and some auto-update UX fixes

## [0.2.0] - 2026-07-06

It took over 6 months of chaotic churn to get to this point, so I will spare
everyone the 2000 commits and changes that got here, and arbitrarily start the
changelist from this point...
