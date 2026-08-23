# Running Juggler headless on Linux

The `juggler` server is a terminal process with no window of its own. On Linux
it runs its agent engine in a Node.js child process, so a headless host — a
container, a CI runner, a cloud VM over SSH — needs no display: no X server, no
Wayland, no Xvfb.

It does still need the GTK4/WebKitGTK libraries on disk. The server binary
links them through cgo, so the dynamic loader resolves them at startup whichever
host the engine runs in.

The desktop app (`juggler-app`) always needs a real display. Headless setups
run only the server, and you connect to it from a browser (or the desktop app)
on another machine.

## 1. Install the runtime libraries

On Ubuntu 24.04+ / Debian:

```bash
sudo apt-get install -y libgtk-4-1 libwebkitgtk-6.0-4
```

Equivalents elsewhere (names vary slightly by release):

| Distro family | Packages |
|---|---|
| Fedora / RHEL (dnf) | `gtk4 webkitgtk6.0` |
| Arch (pacman) | `gtk4 webkitgtk-6.0` |
| openSUSE (zypper) | `libgtk-4-1 libwebkitgtk-6_0-4` |

Missing libraries surface at the dynamic loader as `error while loading shared
libraries: libwebkitgtk-6.0.so…` before the server prints anything — that error
always means "install the packages above".

## 2. Install Node.js

Node 22 or newer, on the server's `PATH`:

```bash
node --version
```

Distro packages are often behind: Ubuntu 24.04 ships Node 18. Install a current
release from [nodejs.org](https://nodejs.org), from your distro's Node
repository, or with a version manager.

## 3. Run it

```bash
juggler
```

The server prints its URL and a QR code. It is localhost-only by default —
press `p` in its terminal (or start with `--public`) to allow other devices on
your network to connect. The default port is 3939 (`--port` overrides).

## Choosing the engine host

`JUGGLER_ENGINE_HOST` selects where the engine runs:

| Value | Effect |
|---|---|
| `auto` (default) | Node when a usable one is on `PATH`, otherwise the WebKitGTK webview |
| `node` | Node, or refuse to start and say why |
| `webview` | The hidden WebKitGTK webview |

`juggler doctor` prints what each probe found — display, Node, Xvfb — and the
host it would choose. Run it first when the engine will not start.

## The webview fallback

With no usable Node, the engine runs in a hidden WebKitGTK webview, which needs
a display as well as the libraries above. Install Xvfb to supply a virtual one:

```bash
sudo apt-get install -y xvfb
```

(Fedora: `xorg-x11-server-Xvfb`; Arch: `xorg-server-xvfb`; openSUSE:
`xvfb-run`.) On this path a server that finds no `DISPLAY` or
`WAYLAND_DISPLAY` relaunches itself under `xvfb-run -a`; `JUGGLER_NO_XVFB=1`
disables that.

Two webview failures are common enough to name:

- **`bwrap: setting up uid map: Permission denied`** — the kernel is blocking
  the unprivileged user namespaces WebKit's sandbox needs (Ubuntu 23.10+
  restricts them via AppArmor by default). Juggler detects and works around
  the common cases automatically; if you still hit it, start with
  `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` — reasonable inside a container,
  which is itself a sandbox.
- **Rendering/GPU failures** on odd or virtual GL stacks: try
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1`.

## Docker

A known-good container recipe lives at
[`packaging/docker/Dockerfile`](../packaging/docker/Dockerfile). It installs a
pinned Node alongside the runtime libraries, and carries no display server.
Place a Linux `juggler` binary next to it (from the release tarball, or your own
build), then:

```bash
docker build -t juggler packaging/docker
docker run -it -p 3939:3939 -v "$PWD:/work" -w /work juggler
```

The image starts the server with `--public` (required for the port mapping to
be reachable; the container boundary takes the place of the localhost-only
default — don't publish the port beyond networks you trust).
