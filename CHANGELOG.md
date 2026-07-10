# Changelog

All notable changes to Juggler are recorded here. Each release is a tight list
of changes; this project follows semantic versioning.

## [Unreleased]

- Made the model chooser list able to hide some providers

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
