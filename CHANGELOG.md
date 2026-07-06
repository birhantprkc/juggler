# Changelog

All notable changes to Juggler are recorded here. Each release is a tight list
of changes; this project follows semantic versioning.

## [Unreleased]

- Auto-update on macOS
- Interrupting a running bash command now kills its process instead of orphaning it.
- Settings gained a Logs page to view this session's logs live, with copy/reveal.

## [0.1.9] - 2026-07-05

- Added some syntax highlighting for things like bash and JS in the properties panel
- Added keyboard shortcuts, a settings page listing them, and shortcut hints in tooltips.

## [0.1.8] - 2026-07-03

- First-run prompt guides new users to connect an AI provider.
- Clear "add a provider" hint when sending with none configured, instead of a dead-end.
- Desktop project picker gained a native "Browse…" folder chooser.
- Terminal launches are now localhost-only by default; enable LAN with `--public` or `p`.
- Added a per-instance session token so only Juggler's own pages can drive tools and file ops.
- Model menu now shows a short hint instead of a raw provider error on load failure.
- Model picker shows an add-credentials hint even when no providers are cached.
- Clearer 403 for a network-blocked browser reaching a localhost-only server.
- Fixed sub-threads inheriting the whole parent conversation instead of just starting context.
- Context item badges now use a coherent colour scheme keyed to tool families.
- Fixes to TaskOutput and bash in "background" mode.
- Images can now be sent without typing any accompanying message text.
- Dropping a text file into the composer now attaches its contents as context.

## [0.1.7] - 2026-07-01

- The terminal can now start a Cloudflare Tunnel relay via `--cloudflare` or the 'c' key.
- The plan tool now tolerates common arg variants from weaker models.
- Improved UI for property panel titles
- Added delete buttons to queued messages
- Added a popup completions panel for slash commands
- Model names now show as readable labels instead of raw hyphenated IDs.

## [0.1.6] - 2026-06-30

- Claude Code now finds the `claude` CLI from nvm and other version managers, even when launched from the dock.
- Claude Code settings now have a field to set the `claude` CLI path for unusual installs.
- A message queued during a Claude Code tool loop no longer triggers a cold restart.
- The browser/mobile Back button now dismisses an open popup, modal, or menu.
- A monitor can now be stopped from any of its output messages, not just its tool call.
- Added usage stats for more LLM providers
- Reasoning models now stream their thinking live instead of a frozen "Receiving" spinner.
- Raised GLM and DeepSeek output caps so long reasoning turns finish instead of silently retrying.
- Logs are now organized per project, with a separate log file per conversation.
- Old logs are purged automatically after 14 days so they no longer pile up.

## [0.1.5] - 2026-06-28

- Sub-threads always run isolated now; the inherit-context option has been removed.
- Spinner elapsed time now matches across all clients viewing a session, and resets after a human approval.

## [0.1.4] - 2026-06-28

- Added Monitor tool that streams a background command's output into the conversation as events, plus TaskOutput and TaskStop/KillShell.
- Linux releases now ship the desktop app alongside the server, for both amd64 and arm64.
- Moved "Duplicate tab" from the header bar to the root thread's footer.
- Undo/redo is locked out while a tab's LLM loop is running.
- Clicking a selected context item scrolls its details column into view when off-screen.
- Hardened claudecode tool-result delivery (stranded "Running", cross-tool output, duplicate runs across reattach and resume).
- Mobile/narrow-screen UI improvements, including a usable Settings panel.
- Better auto-recovery for remote clients with a dropped connection.

## [0.1.3] - 2026-06-25

## [0.1.2] - 2026-06-25

- Attention alerts: when a conversation you’re not viewing needs you (awaiting approval or turn finished), its tab always flashes, plus a per-window chime and an opt-in out-of-app signal (Dock-icon bounce in the desktop app, browser-tab title marker in a browser); alerts auto-dismiss after ~20s, with a header bell (Do Not Disturb) toggle and a Notifications settings tab.
- Added explicit Direct P2P (WebRTC via juggler.studio) and optional cloudflared relay WAN access modes; juggler.studio signaling is STUN-only with no public TURN relay.
- Fixed image attachments being dropped when a message is sent while a turn is already in flight (queued messages now keep their images, which also survive asset GC until sent).

## [0.1.1] - 2026-06-24

- Thread column header "Copy to new tab" button: copies the thread (plus inherited parent context) into its own conversation tab.
- Redesigned the system-prompt preset dropdown with aligned rows and a marked active preset.
- Saving an API key no longer corrupts `credentials.json` under concurrent writes (atomic write), and a corrupt file is quarantined and recreated instead of permanently blocking key saves.
- macOS: always seal the .app bundle (ad-hoc when unsigned), so a downloaded copy no longer fails Gatekeeper as "damaged and can't be opened".

## [0.1.0] - 2026-06-24

Initial release.

It took over 6 months of chaotic churn to get to this point, so rather than hang
out 1500 commits of dirty laundry in public, I'll spare you that, and arbitrarily
start the repo from this point...
