# Distribution: two binaries, one unit

Juggler is two programs, not one:

- **`juggler`** (`juggler.exe` on Windows) — the headless command-line server.
  It does all the work: HTTP/WebSocket server, session store, tool execution.
- **Juggler app** (`juggler-app.exe`) — the native desktop app. It owns the
  windows and is otherwise a thin client pointed at a server.

These two are versioned and shipped **together, as one indivisible unit**. The
desktop app locates its server as a sibling file on disk (`serverBinPath()`) and
spawns it, so the app always runs a server of its *exact* build. Mixing an app
from one release with a server from another is never a supported configuration,
and every distribution channel is built to make that impossible.

## Why they must stay in lock-step

The app and server speak a private protocol over HTTP/WebSocket that is not
promised to be stable across versions. The document format, the engine command
mailbox, and the session-store shape all evolve together. Pinning the app to the
server that ships beside it removes a whole class of "works on my machine"
version-skew bugs: there is only ever one pairing that has been tested.

## Channels

Every channel installs both binaries into a single location so the app's
sibling lookup resolves the matching server.

### macOS — `.dmg`

The `.dmg` contains `Juggler.app`, a normal drag-to-Applications bundle. Both
binaries live *inside* the bundle (`Juggler.app/Contents/MacOS/`), so the app
and its server can never be separated — moving or copying the app moves both.
Launching the app spawns the bundled server automatically.

> **Opening on macOS.** Downloaded builds are quarantined by Gatekeeper. The
> first time you open Juggler, right-click (or Control-click) the app → **Open**
> → **Open**, or go to **System Settings → Privacy & Security → Open Anyway**.
> After the first launch it opens normally.

### Windows — installer

`Juggler-<version>-setup.exe` (built with Inno Setup, see
`packaging/windows/juggler.iss`) writes `juggler-app.exe` and `juggler.exe` into
one install directory as siblings and can add `juggler` to your `PATH`. Because
they land in the same directory in a single install step, the two never drift
apart. Uninstalling removes both.

### Linux — server binary

Linux ships the `juggler` server binary; run it from a terminal and connect with
a browser or the desktop app. There is no separate app package yet.

### Planned: Homebrew cask / winget

A Homebrew cask (macOS) and a winget package (Windows) are planned. Both will
wrap the same artifacts above — the cask installs the `.app` bundle (both
binaries inside it), the winget package runs the same installer — so they inherit
the same lock-step guarantee without introducing a way to install the two halves
independently.

## The invariant, restated

However Juggler reaches your machine, the desktop app and its server arrive and
install as one unit, in one place, and the app spawns the server sitting beside
it. Never install, package, or update the two halves separately.
