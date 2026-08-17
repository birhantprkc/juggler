# Juggler

Yes, it's another AI coding agent. The industry definitely needed one more.

If Juggler has an angle, it's that it's for people who want to be more hands-on over what the LLM is doing to their codebase. It gives you a visual workbench: inspectable tool calls, branching threads, editable context.

It's built by the developer behind [JUCE](https://juce.com), [Tracktion](https://www.tracktion.com) and [Cmajor](https://cmajor.dev). It's free and open-source, with no signup: just download the Go binary and run it.

More blurb on the website: [https://juggler.studio](https://juggler.studio) — and there's a [Discord](https://discord.gg/HyqZwKvSMd) if you want to come and say hello.

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-main.webp" alt="Juggler's Miller-column workbench: tool calls, item properties and nested sub-threads" width="880">
</p>
<p align="center"><em>Tool calls, item properties and nested sub-threads laid out in a Finder-style Miller column view.</em></p>

And here's the TL;DR:

- **It is a proper GUI.** Using a code agent means editing big chunks of multi-line text and getting hosed with information you need to absorb — I find a terminal horrible for that. Juggler is all about visual navigation, inspection, and control.
- **The session is a tree, not a doom-scroll.** It's a Yjs document, not a transcript. Create sub-threads, drill down, backtrack, compare, and edit.
- **Sessions are persistent and stateful.** Because a session is a document on disk, you can quit or relaunch and it resumes every conversation exactly where you left it. That even includes states such as an agent waiting for user approval. You can restart, reconnect, and the approval dialog will be there waiting for you.
- **Everything is inspectable.** Tool calls, approvals, thread structure, item properties, raw context — laid out in Finder-style Miller columns for fast navigation.
- **It's plugins all the way down.** Context items, slash commands, LLM loop strategies, and their UIs are JavaScript extensions you can inspect, fork, or replace. MCP servers and skills plug into the same document, so anything you've already set up comes along.
- **It runs locally, remotely, or both at once.** Use the same session with the same UI in the native desktop app, and/or browsers. Multiple clients can attach to the same session.
- **It talks to the usual model zoo.** Claude Code (via CLI or API), OpenAI (Codex plan or API), GitHub Copilot, Gemini, Mistral, Z.ai, Ollama, OpenRouter, Deepseek, etc. Bring the subscription you already pay for, or your own API keys.

----------

## Getting started

Download a build from the [Releases](https://github.com/juggler-ai/juggler/releases) page or via [juggler.studio](https://juggler.studio).

Each download contains the same two moving parts:

- **Juggler app** — the native desktop app. Works like you'd expect it to.
- **`juggler`** — the headless command-line server. Run this from a terminal for long-lived, remote, or network-accessible sessions. It has no window of its own, but you can type `w` into its terminal to open the desktop app, or use the browser URL it prints.

The desktop app, browser tabs (on local or remote machines) can all be clients viewing the same server session.

#### Installing

- **macOS** — download the `.dmg`, open it, and drag Juggler to Applications, then launch it. The app and its server are bundled together, so the server starts automatically. The first time you open it, macOS Gatekeeper may block the download: right-click (or Control-click) the app → **Open** → **Open**, or go to **System Settings → Privacy & Security → Open Anyway**. After the first launch it opens normally.
- **Windows** — download `Juggler-<version>-setup.exe` and run it. It installs the desktop app and the matching `juggler.exe` command-line server together in one directory (and can add `juggler` to your PATH), so the two never drift apart.
- **Linux** — download the `juggler` server binary and run it from a terminal, then connect with a browser or the desktop app. For servers, containers, and CI machines with no display, see [`docs/headless-linux.md`](docs/headless-linux.md).

The desktop app and the server always ship and install as one unit — see [`docs/distribution.md`](docs/distribution.md).

#### Running the server directly

For a headless session, just run:

```bash
juggler     # prints everything you need to connect from a browser
```

By default, the server opens a web UI and prints its URL plus a QR code for easy connection.

The server is localhost-only by default — nothing off your machine can reach it. To let other devices on your network connect, press `p` in the terminal (or launch with `--public`). LAN access has no password: anyone who can reach the address can drive the agent, so only enable it on networks you trust.

Access from beyond your LAN isn't built into this repository: a build from this source is local + LAN only. The official Juggler binaries from [juggler.studio](https://juggler.studio) additionally include WAN access modes for reaching your server across the internet (see [LICENSING.md](LICENSING.md) on components not in this repo).

----------

## What makes it different?

#### Your conversation is an editable tree, not a chat history

Most agents give you a single linear transcript and if you're lucky you can rewind it.

Juggler gives you a **tree**. Any point can branch into a sub-thread. Sub-threads can branch again. You can navigate, inspect, and edit the structure directly.

The UI uses **Miller columns**: root on the left, selected items expanding into properties and children to the right. (If you've used Finder's column view, you already understand the basic move).

#### Your session survives being closed — approvals and all

Because the whole session is a document, and the server is a state machine that modifies it, nothing is lost when you close the app. Quit, relaunch, lose the connection, come back tomorrow — it rehydrates exactly where it was.

Crucially, that includes workflow that's *waiting on you*. When the agent pauses for user intervention — to run a command, apply an edit, take the next step — that paused state is part of the document. You can shut everything down, reopen it later on the same machine or a different one, and the agent is still parked at the same decision, ready to resume the moment you say yes.

#### Everything is an extension

The core app manages the document and orchestration. Almost all the objects that make up the document are defined by JavaScript extensions:

- **Context items** — every item type in a conversation (`read-file`, `replace-text`, `bash`, …) controls both how it talks to the LLM and how it appears in the UI.
- **Strategies** — high-level LLM loops such as `plan`, `research`, or your own fever-dream inventions are plugins too.
- **Commands** — slash commands like `/clear` and `/compact` are all just plugins that manipulate the session document.

Every tool, even basics like read/write/bash, is a plugin you can swap out. MCP servers and skills plug into the same document, so anything you've already set up comes along.

Not every LLM workflow wants to live as a headless Python script skulking in a terminal. If an orchestration idea needs its own UI, controls, or visualisation, Juggler is a platform for that.

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-extensions.webp" alt="Juggler's LLM-facing tools defined as extensions" width="760">
</p>
<p align="center"><em>Everything's a plugin — even the read/write/bash tools are defined in extensions you can inspect, fork, or replace.</em></p>

#### A desktop app with a multi-client architecture

Juggler looks like a native desktop app, but underneath it is a local webserver serving a live collaborative session. The app is just one client. A browser tab can be another. A different machine can be another.

That means you can run the server where the code lives — local workstation, dev box, server farm - and attach views from wherever is convenient.

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-browser.webp" alt="One Juggler session with multiple synced clients" width="760">
</p>
<p align="center"><em>One session, many clients — the desktop app and browser views stay in sync.</em></p>

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-large.webp" alt="Juggler on a large desktop screen" width="600">
  <img src="https://juggler.studio/assets/screenshot-mobile.webp" alt="Juggler in a phone browser" width="170">
</p>
<p align="center"><em>Big screen or pocket-sized: the same live session, whether it's the desktop app or a remote browser on your phone.</em></p>

#### Model support

Juggler connects to the usual suspects: Claude Code (via CLI or API), OpenAI (Codex plan or API), GitHub Copilot, Gemini, Mistral, Z.ai, Ollama, OpenRouter, Deepseek, etc. Bring the subscription you already pay for, or your own API keys. It's easy to add more providers, so if yours is missing, ask your friendly neighbourhood LLM to add it as a PR.

How Juggler keeps every request inside the model's context window — limits, admission, and automatic history recovery: [`docs/context-window.md`](docs/context-window.md).

----------

## Status and roadmap

Juggler is still very new, and since its release I've churned out hundreds of changes in response to feedback from people trying it out: some big new features, lots of stability fixes, and lots of UX nitpicks. The big features coming next:

- **A "workspace" abstraction.** The filesystem and execution environment a task runs in becomes an abstraction, so plugins can add worktrees, remote SSH to build machines, sandboxing, and other exotic environments.
- **Recursive Language Models.** Juggler's thread-folding architecture already does the hard part, so I just need the remaining plumbing to let a model search its own history.
- **The terminal app becomes a real server.** One machine, many clients, many projects, plus (optional!) user accounts, so you can log in anywhere and enumerate your own servers.

Constructive feedback is welcome — come and say hello on the [Discord](https://discord.gg/HyqZwKvSMd). But be gentle! This isn't being developed by a huge team at a trillion-dollar AI company; it's a one-man side-hustle.

----------

## Building from source

The idea with the extensions system is that most people won't need to actually build the app. If you do, there's no frontend build step and nothing to install beyond Go — the binaries are the whole thing. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full development setup.

**You need:** Go 1.26+, and on Linux the GTK4/WebKitGTK development packages (the server runs its engine in a hidden webview):

```bash
sudo apt-get install -y libgtk-4-dev libwebkitgtk-6.0-dev libsoup-3.0-dev   # Ubuntu 24.04+/Debian
```

Then:

```bash
git clone --recurse-submodules https://github.com/juggler-ai/juggler.git
cd juggler
make go-build
```

If you already cloned without `--recurse-submodules`, fetch them with `git submodule update --init --recursive`.

That leaves everything in `bin/`:

| Platform | What you get | Run it |
|---|---|---|
| macOS | `bin/Juggler.app`, with both binaries inside the bundle, plus `bin/juggler` and `bin/juggler-app` symlinks into it | `open bin/Juggler.app`, or `./bin/juggler` for the headless server |
| Linux, Windows | `bin/juggler` (server) and `bin/juggler-app` (desktop app), side by side | `./bin/juggler`, or run the app |

`make go-build` just compiles. `make build` lints first, which additionally needs Node — it installs the JS/CSS toolchain into `tooling/` on first run — and is what you want before opening a PR. `make test` runs the whole suite and needs no API keys. `make help` lists every target.

To build the same installers and archives the official downloads use: `make mac-dmg` (needs `brew install create-dmg`), `make win-installer` (needs Inno Setup, run on Windows), `make linux-tarball`. These are unsigned — a macOS bundle built here is ad-hoc signed, so other machines' Gatekeeper will object to it.

The Linux desktop app must be built natively on Linux. If you want to build for a `x86/amd64` Intel Mac, you can build that locally. For a Linux host with no display, see [`docs/headless-linux.md`](docs/headless-linux.md).

#### Building on Windows

Windows doesn't ship `make`, and this repo's recipes need a POSIX shell, so the supported setup is Git Bash plus a GNU make:

```bash
winget install Git.Git
winget install ezwinports.make
```

That combination is what CI uses on its Windows runner, so the targets above are proven to work there. Avoid GnuWin32's make — it's version 3.81 from 2006. One adjustment: `make test` needs `RACE=` (the default `-race` requires a C compiler, which Windows usually lacks).

If you'd rather not install make at all, a quick build is just `go build`:

```bash
mkdir -p bin
go build -o bin/juggler.exe ./cmd/juggler
go build -o bin/juggler-app.exe ./cmd/juggler-app
```

WSL2 works too, but builds the Linux binaries — the Linux backend links GTK/WebKitGTK, not a native `.exe`.

CI on this repo is a sanity gate — lint, build, test — and deliberately publishes no artifacts, so there are no per-commit builds to download. The official signed builds come from a separate release pipeline.

## Tech stack

Juggler is a simple native app without baggage — no node, no electron, no dependencies to install. The backend is Go, using Wails for windowing. The UI is HTML/JS served by the Go backend. Session documents are stored and synchronised with Yjs. Extensions are JavaScript.

The frontend is type-checked JavaScript rather than TypeScript: types live in JSDoc and are enforced in CI with strict static linting. There's no build step between source and what ships.

----------

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, test commands, and project conventions. For security issues, please use the private channel described in [`SECURITY.md`](SECURITY.md) rather than the public issue tracker.

## License

Juggler's application code is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). The extension SDK (`web/sdk/`) and the bundled extensions (`web/extensions/`) are licensed under [Apache-2.0](web/sdk/LICENSE), so you can build extensions — including closed-source ones — with no copyleft obligation. See [`LICENSING.md`](LICENSING.md) for the full map.

For the AGPL parts you're free to use, modify, and redistribute — but any modified version you distribute or host as a service must also be released under the AGPLv3. If you want to do something closed-source with it, contact me to discuss commercial licensing.
