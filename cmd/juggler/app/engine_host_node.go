//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync/atomic"

	"juggler/cmd/juggler/server"
	"juggler/internal/enginehost"
	"juggler/internal/jlog"
)

// nodeHost runs the engine in a spawned Node.js process — the headless
// alternative to the webview host. The server snapshots the engine module graph
// to disk (server.PrepareNodeEngineHost) and this launches
// `node <snapshot>/engine-host.mjs --server <addr>` against it. The engine then
// connects its WebSocket back exactly as the webview worker does; readiness and
// tool execution flow through the same host-agnostic paths.
type nodeHost struct {
	srv         *server.Server
	requestQuit func()
	nodePath    string
	version     string
	// proc is the spawned engine process, kept so a wedged engine can be killed
	// from the server's supervisor goroutine. Nil until Start succeeds.
	proc atomic.Pointer[os.Process]
}

// newNodeHost constructs a nodeHost from a validated node probe (info.OK).
func newNodeHost(srv *server.Server, requestQuit func(), info enginehost.NodeInfo) *nodeHost {
	return &nodeHost{srv: srv, requestQuit: requestQuit, nodePath: info.Path, version: info.Version}
}

// Describe implements engineHost.
func (h *nodeHost) Describe() string { return "node " + h.version }

// Recover kills the wedged node engine. There is no in-place reload for a
// process — the graph is snapshotted at spawn — so this deliberately routes into
// the same exit path any other node death takes: the Wait goroutine below logs
// it and tears the server down. That is the honest outcome for a host that
// cannot be revived, and node mode is the dev/debug host in any case.
func (h *nodeHost) Recover() {
	proc := h.proc.Load()
	if proc == nil {
		jlog.Error("[engine-node] cannot restart the node engine: no process handle")
		return
	}
	jlog.Error("[engine-node] node engine stopped answering — killing it")
	_ = proc.Kill()
}

// Start snapshots the engine graph and spawns the node process against it.
func (h *nodeHost) Start(addr string) error {
	spec, err := h.srv.PrepareNodeEngineHost()
	if err != nil {
		return fmt.Errorf("snapshot engine graph: %w", err)
	}
	cmd := exec.Command(h.nodePath, spec.Entry, "--server", spec.Addr)
	// The token goes via env, never argv: argv is world-readable in the process
	// table, and the token gates the sensitive /api surface. The project root is
	// passed alongside it so the query_code sandbox can expose `projectRoot`.
	cmd.Env = append(os.Environ(),
		"JUGGLER_TOKEN="+spec.Token,
		"JUGGLER_PROJECT_ROOT="+spec.ProjectRoot,
	)
	// Best-effort: on Linux, have the kernel kill the child if we die, so a
	// crashed server never orphans a live node engine. No-op on other OSes,
	// where node mode is dev/debug-only.
	setChildDeathSignal(cmd)

	stderr, err := cmd.StderrPipe()
	if err != nil {
		spec.Cleanup()
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		spec.Cleanup()
		return err
	}
	if err := cmd.Start(); err != nil {
		spec.Cleanup()
		return fmt.Errorf("spawn node engine host: %w", err)
	}
	h.proc.Store(cmd.Process)
	go pipeToJlog(stderr)
	go pipeToJlog(stdout)

	// Node engine death after startup ⇒ tear the server down, mirroring the
	// webview catch-all (engine_lifecycle.go): a headless server whose host died
	// can do no useful work and must not linger as a zombie holding its port.
	go func() {
		werr := cmd.Wait()
		spec.Cleanup()
		jlog.Error("[engine-node] node engine process exited (%v) — shutting down", werr)
		h.requestQuit()
	}()
	return nil
}

// pipeToJlog forwards a node child's output stream to jlog line by line, with an
// [engine-node] prefix so engine-side logs are attributable. The larger buffer
// accommodates the occasional long stack trace without truncating mid-line.
func pipeToJlog(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		jlog.Info("[engine-node] %s", sc.Text())
	}
}
