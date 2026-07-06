# Contributing to Juggler

Thanks for your interest. This document covers the basics; for the broader engineering rules (architecture, concurrency, Yjs invariants, fork-submodule workflow) see [`CLAUDE.md`](CLAUDE.md).

## Setup

Juggler needs Go 1.24+ and a recent Node toolchain (for JS linting). Clone with submodules so the Wails fork is populated:

```bash
git clone --recurse-submodules https://github.com/juggler-ai/juggler
cd juggler
make build
```

If you cloned without submodules, run `git submodule update --init --recursive`.

## Building and running

```bash
make build       # Lint + build Go binaries (bin/juggler, bin/juggler-app, bin/juggler-test)
make go-build    # Build Go binaries only (skip linting)
make dev         # Build and run the server
```

Juggler is two binaries: `cmd/juggler` is the headless **server** (HTTP/WS + the hidden engine WebView) and `cmd/juggler-app` is the multi-window **desktop app** (`bin/Juggler.app`). The desktop app is a pure viewer that talks to a server over HTTP/WebSocket — see the Architecture ▸ Server/app split section in [`CLAUDE.md`](CLAUDE.md).

## Tests

The inner-loop command runs everything (unit, integration, browser) and skips linting:

```bash
make test
```

Before opening a PR, run the full check:

```bash
make test-full   # Lint + tests
```

For finer-grained runs:

```bash
go test -v -count=1 -timeout 15m ./tests/integration
go test -short ./tests/integration                                # skip browser tests
go test -v -count=1 -run 'TestBrowser/integration:glob' ./tests/integration
```

## Linting

```bash
make lint         # Go + JS type-check + JS lint + CSS
make lint-types   # TypeScript type-check of the JS frontend only
```

CI runs the same lints. Fix lint errors locally before pushing; do not use `--no-verify` to skip hooks.

This repo's CI is a sanity gate only — lint, build, and tests on hosted
runners, with no secrets. Official signed binaries are built and published to
the [Releases](https://github.com/juggler-ai/juggler/releases) page by the
maintainer's separate release pipeline, so a green CI here never produces
release artifacts.

### The frontend is type-checked JavaScript, not TypeScript

`web/` is plain JavaScript with types expressed as JSDoc annotations — but it is **fully type-checked**. `make lint-types` runs `tsc --project tooling/jsconfig.json --noEmit` with `checkJs` and `strict` on (plus `noUncheckedIndexedAccess` and friends), so the frontend gets the same TypeScript checker, inference, and editor tooling as a `.ts` codebase — with no build step or transpile between source and what ships. This is the same approach Svelte and others took; type errors fail `make lint`, so keep your JSDoc honest. New frontend code is expected to type-check clean.

## Commit and PR style

- One logical change per commit; rebase noise out before opening the PR.
- Commit subjects: short imperative ("Fix CI", "Bump Node versions for CI"). Match the style you see in `git log`.
- New commits, not amended ones, after a failing pre-commit hook. The failed commit didn't happen — `--amend` would modify the previous commit.
- Tests for behaviour changes. Prefer browser integration tests under `tests/integration/` over Go unit tests for anything that has a UI surface.

## Repository layout

- **`docs/`** is for published, user-facing documentation only — not plans, working notes, or temporary development files.
- WIP planning docs and scratch notes go in **`scratch/`** (git-ignored, with `local/` and `playground/`). Promote a doc into `docs/` only once it's meant for users.

## Architecture rules

A short list of project conventions you will be asked to follow in review. Full rationale lives in [`CLAUDE.md`](CLAUDE.md).

- **Concurrency**: goroutines and channels, not mutexes. There is exactly one sanctioned `sync.Mutex` in the codebase (`ycrdtMu`), and adding another will be flagged.
- **Yjs invariants**: when two pieces of CRDT state must co-vary, encode the relationship as a reactive observer, not in click handlers.
- **Frontend services**: classes for per-instance state, module singletons for one-logical-instance registries. Don't rewrite existing services to match a different style.
- **Plugin architecture**: plugins drive behaviour by mutating the Yjs document; they don't call `workerManager` directly.
- **Render callbacks** never perform state changes — fire events from the action site instead.
- **Server stays windowless**: `cmd/juggler` creates only the hidden engine WebView in production. Visible windows belong to `cmd/juggler-app`; the server's one visible-window path is test-only and isolated in `window_testpool.go`.

## Submodule forks (`3rdparty/`)

The Wails fork is vendored as a git submodule with a `replace` directive in `go.mod`. The submodule pointer is the source of truth. `CLAUDE.md` has the rebase / push workflow if you need to update it.

## Licensing and sign-off

The repo carries two licenses — AGPL-3.0-or-later for the application,
Apache-2.0 for `web/sdk/**` and `web/extensions/**`. See
[`LICENSING.md`](LICENSING.md). Your contribution is licensed under the license
of the directory it lands in.

### Sign your work

Every commit must carry a `Signed-off-by:` line certifying the
[Developer Certificate of Origin](DCO) — that you wrote the change (or
otherwise have the right to submit it) under the applicable license:

```bash
git commit -s
```

This adds `Signed-off-by: Your Name <you@example.com>` (matching your git
`user.name`/`user.email`) to the commit message. PRs with unsigned commits
fail the DCO check and can't be merged.

## Reporting bugs

Open an issue using the bug template. For security issues, see [`SECURITY.md`](SECURITY.md) — please don't file them as public issues.
