//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"

	"juggler/internal/jlog"
)

// agentProc is a spawned ACP agent subprocess and its stdio handles.
type agentProc struct {
	stdin  io.WriteCloser
	stdout io.Reader
	kill   func()
	reap   func()
}

// spawnAgent starts a resolved ACP agent in the given working directory, wiring
// stdin/stdout for the JSON-RPC transport and draining stderr into the log. The
// agent inherits the process environment plus any per-agent env from acp.json.
// kill is non-blocking (close stdin + SIGKILL); reap is a once-guarded
// cmd.Wait().
func spawnAgent(_ context.Context, workingDir string, agent resolvedAgent) (*agentProc, error) {
	if agent.path == "" {
		return nil, fmt.Errorf("acp: no agent command configured")
	}
	// Not exec.CommandContext: cancelling a turn must NOT kill the agent (that
	// would drop the session). Cancellation is cooperative via session/cancel;
	// process teardown happens only on Close / crash recovery.
	cmd := exec.Command(agent.path, agent.args...) //nolint:gosec // user-configured agent command
	cmd.Dir = workingDir
	cmd.Env = os.Environ()
	for k, v := range agent.env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("acp: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("acp: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("acp: stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("acp: start %q: %w", agent.path, err)
	}
	jlog.Info("[acp] spawned agent %s (pid %d)", agent.path, cmd.Process.Pid)

	// Drain stderr on its own goroutine; reap waits it out so cmd.Wait never
	// closes the stderr pipe from under an in-flight read (see reap).
	var stderrWG sync.WaitGroup
	stderrWG.Add(1)
	go func() {
		defer stderrWG.Done()
		drainStderr(stderr)
	}()

	var killOnce sync.Once
	kill := func() {
		killOnce.Do(func() {
			_ = stdin.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		})
	}
	var reapOnce sync.Once
	reap := func() {
		reapOnce.Do(func() {
			// cmd.Wait closes the stdio pipes, so it must not run until every
			// pipe read has finished: stdout is done (the reader calls reap only
			// after its Scan hits EOF), and this waits out the stderr drain.
			stderrWG.Wait()
			if err := cmd.Wait(); err != nil {
				jlog.Debug("[acp] agent %s exited: %v", agent.path, err)
			}
		})
	}

	return &agentProc{
		stdin:  stdin,
		stdout: stdout,
		kill:   kill,
		reap:   reap,
	}, nil
}

// drainStderr forwards the agent's stderr to the debug log, one line at a time,
// until the pipe closes (agent exit). Matches claudecode's stderr handling:
// stderr is diagnostics, never protocol.
func drainStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 8*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r\n")
		if line == "" {
			continue
		}
		jlog.Debug("[acp] stderr: %s", line)
	}
}
