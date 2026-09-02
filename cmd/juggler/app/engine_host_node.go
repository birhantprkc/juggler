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

	"juggler/cmd/juggler/childcontain"
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
//
// The engine process must not outlive the server that spawned it. It dials that
// address forever — the engine is exempt from the reconnect's did-the-server-
// restart check, having no page to reload — and a port is re-bound by whatever
// starts next, so an engine left behind attaches to a stranger. The engine slot
// goes to the newest arrival, so the stranger then receives the work meant for
// the real engine and does nothing with it: a run that hangs until its caller
// gives up rather than an error anyone can see. Containment is therefore not
// tidiness; it is what keeps one server's engine out of the next server.
type nodeHost struct {
	srv         *server.Server
	requestQuit func()
	nodePath    string
	version     string
	// child is the contained engine process, kept so a wedged engine can be
	// killed from the server's supervisor goroutine and so shutdown can take the
	// whole subtree down. Nil until Start succeeds.
	child atomic.Pointer[childcontain.Child]
	// stopping records that the death about to be observed was asked for, so the
	// watcher below reports it as an exit rather than a failure and does not ask
	// for a shutdown that is already under way.
	stopping atomic.Bool
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
	child := h.child.Load()
	if child == nil {
		jlog.Error("[engine-node] cannot restart the node engine: no process handle")
		return
	}
	jlog.Error("[engine-node] node engine stopped answering — killing it")
	_ = child.Terminate()
}

// Stop kills the engine process tree. Called once the server is on its way out,
// so no engine of ours is left dialling a port somebody else is about to bind.
func (h *nodeHost) Stop() {
	child := h.child.Load()
	if child == nil {
		return
	}
	h.stopping.Store(true)
	if err := child.Terminate(); err != nil {
		jlog.Error("[engine-node] couldn't stop the node engine: %v", err)
	}
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
	// Containment covers the deaths no cleanup gets to run for — a crash, a
	// SIGKILL, the watchdog's same-PID re-exec: Pdeathsig on Linux, the
	// parent-death reaper on macOS, a kill-on-close job object on Windows. Stop
	// covers the ordinary exit.
	childcontain.Prepare(cmd)

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
	child, containErr := childcontain.Adopt(cmd)
	if containErr != nil {
		jlog.Info("[engine-node] child containment unavailable (%v); a hard kill of this process may leave the engine running", containErr)
	}
	h.child.Store(child)
	// The pid is worth saying: an engine that outlived its server is invisible
	// otherwise, and this is what identifies it in the process table.
	jlog.Info("[engine-node] engine host running as pid %d", cmd.Process.Pid)
	go pipeToJlog(stderr)
	go pipeToJlog(stdout)

	// Node engine death after startup ⇒ tear the server down, mirroring the
	// webview catch-all (engine_lifecycle.go): a headless server whose host died
	// can do no useful work and must not linger as a zombie holding its port. A
	// death we asked for is neither news nor a reason to ask again.
	go func() {
		werr := cmd.Wait()
		child.Cleanup()
		spec.Cleanup()
		if h.stopping.Load() {
			jlog.Info("[engine-node] node engine process exited (%v)", werr)
			return
		}
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
