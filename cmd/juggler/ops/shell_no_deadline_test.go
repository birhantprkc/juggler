//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// Some things are meant to run until they are stopped: a dev server, a patch
// host an extension embeds in a pinboard pin. Every other background task is
// capped at maxExecTimeoutMs; `timeout: -1` is how a caller asks for no
// deadline at all, and these are the properties that has to have.

// waitForNotRunning polls until the task leaves "running", or fails.
func waitForNotRunning(t *testing.T, id string, deadline time.Duration) TaskSnapshot {
	t.Helper()
	stop := time.After(deadline)
	for {
		s := TaskState(id)
		if s.Status != "running" {
			return s
		}
		select {
		case <-stop:
			t.Fatalf("task %s never stopped running", id)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// startNoDeadlineTask starts a task with the sentinel and waits for it to be up.
func startNoDeadlineTask(t *testing.T) (*ShellOperations, string) {
	t.Helper()
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "echo ready; sleep 30",
		"timeout": float64(noDeadlineTimeoutMs),
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	if id == "" {
		t.Fatalf("startBackground returned no task_id: %+v", res)
	}
	t.Cleanup(func() { KillTask(id) })
	waitForOutput(t, id, "ready", 5*time.Second)
	return shellOps, id
}

// What this guards is not the twenty-minute cap, which no test can sit through —
// it is that the sentinel never reaches context.WithTimeout, where a negative
// duration is an expired one and the task asking to run forever would be the one
// task that died instantly. Still running a beat later is the whole claim.
func TestStartBackground_NoDeadlineKeepsRunning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell command syntax is POSIX")
	}
	_, id := startNoDeadlineTask(t)

	time.Sleep(750 * time.Millisecond)

	if s := TaskState(id); s.Status != "running" {
		t.Fatalf("task with no deadline stopped on its own: status=%q error=%q", s.Status, s.Error)
	}
}

// No deadline must not mean no way out: cancel is still the only thing that ends
// the task, and kill is still what calls it.
func TestStartBackground_NoDeadlineStillKillable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell command syntax is POSIX")
	}
	shellOps, id := startNoDeadlineTask(t)

	res, err := shellOps.kill(map[string]any{"shell_id": id})
	if err != nil {
		t.Fatalf("kill failed: %v", err)
	}
	if killed, _ := res.(map[string]any)["killed"].(bool); !killed {
		t.Fatalf("kill did not report killing the task: %+v", res)
	}

	waitForNotRunning(t, id, 5*time.Second)
}

// The sentinel is one exact value, and everything either side of it is still an
// ordinary duration — a task asked to stop soon must still stop soon.
//
// The command here is a bare `sleep` on purpose, and the reason is a bug this
// test would otherwise trip over rather than describe. The deadline is enforced
// by exec.CommandContext, which kills only the `sh` it started; setProcGroup has
// put that shell in its own process group, so a command that leaves a grandchild
// behind (`echo x; sleep 30`, where sh forks rather than execs) keeps running,
// and cmd.Wait() blocks on the write end of the pipe the survivor inherited. A
// bare `sleep` is exec'd by sh, so the process the deadline kills is the only
// one there is. `kill` does not have this problem — it escalates to the whole
// process group (see the "kill" case in the registry goroutine) — so stopping a
// task explicitly works whatever it spawned; it is only the timeout path that is
// weak. Orthogonal to the no-deadline sentinel and left alone deliberately.
func TestStartBackground_OrdinaryTimeoutStillExpires(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell command syntax is POSIX")
	}
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "sleep 30",
		"timeout": float64(300),
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { KillTask(id) })

	s := waitForNotRunning(t, id, 5*time.Second)
	if s.Status != "failed" {
		t.Errorf("timed-out task status = %q, want failed", s.Status)
	}
}

// A caller who types 0 meaning "forever" gets a task that dies at once, which is
// exactly why 0 could not be the sentinel. Pinned so nobody later decides it
// should mean forever after all without noticing what it already means.
func TestStartBackground_ZeroTimeoutIsNotForever(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell command syntax is POSIX")
	}
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "sleep 30",
		"timeout": float64(0),
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { KillTask(id) })

	waitForNotRunning(t, id, 5*time.Second)
}

// The sentinel is only meaningful where something outlives the call that made
// it. A foreground command must say so rather than read -1 as a duration and
// return instantly, which is the same answer a command that ran and produced
// nothing would give.
func TestExecuteRefusesNoDeadline(t *testing.T) {
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))

	for _, params := range []map[string]any{
		{"command": "echo hello", "timeout": float64(noDeadlineTimeoutMs)},
		{"code": "print('hello')", "timeout": float64(noDeadlineTimeoutMs)},
	} {
		if _, err := shellOps.execute(context.Background(), params); err == nil {
			t.Errorf("execute(%+v) accepted the no-deadline sentinel", params)
		}
	}
}

func TestWantsNoDeadline(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]any
		want   bool
	}{
		{"sentinel", map[string]any{"timeout": float64(-1)}, true},
		{"absent", map[string]any{}, false},
		{"zero", map[string]any{"timeout": float64(0)}, false},
		{"ordinary", map[string]any{"timeout": float64(5000)}, false},
		{"other negative", map[string]any{"timeout": float64(-2)}, false},
		{"wrong type", map[string]any{"timeout": "-1"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := wantsNoDeadline(tc.params); got != tc.want {
				t.Errorf("wantsNoDeadline(%+v) = %v, want %v", tc.params, got, tc.want)
			}
		})
	}
}
